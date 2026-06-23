from __future__ import annotations

import shutil
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .compactor import Compactor
from .context import ContextBuilder
from .control import (
    AskUserTool,
    ControlManager,
    ControlMode,
    InteractionKind,
    ProposePlanTool,
    TurnPaused,
)
from .logger import configure as configure_logging
from .mcp import MCPClient
from .memory import MemoryStore
from .model_router import ModelRouter
from .plans import PlanContextBuilder
from .projects import ProjectStore
from .runner import AgentRunner
from .runner_factory import build_routed_runner
from .scheduler import SchedulerService, SchedulerStore, SchedulerTool
from .sessions.conversation import ConversationStore, ProjectSessionMemoryStore, SessionMemoryStore
from .sessions.store import SessionStore
from .skills import SkillsLoader
from .subagents import SubagentRegistry
from .tasks import TaskManager
from .team import (
    TeamBroadcastTool,
    TeamListTool,
    TeamManager,
    TeamReadInboxTool,
    TeamSendMessageTool,
    TeamShutdownTool,
    TeamSpawnTool,
)
from .telemetry import TokenTracker
from .tools import (
    DispatchSubagentTool,
    EditFileTool,
    GlobTool,
    GrepTool,
    LoadSkill,
    ReadFileTool,
    RunCommand,
    TodoStore,
    ToolRegistry,
    UpdateTodosTool,
    WebFetch,
    WriteFileTool,
)
from .workspace import WorkspaceContext

_TEAM_TOOL_NAMES = {
    "spawn_teammate",
    "list_teammates",
    "send_message",
    "read_inbox",
    "broadcast",
    "shutdown_teammate",
}


class AgentLoop:
    def __init__(
        self,
        root: Path | None = None,
        model: str | None = None,
        verbose: bool = True,
        startup_compaction: bool = True,
        console: Console | None = None,
    ):
        load_dotenv()
        self.root = root or Path(__file__).parent.parent
        configure_logging(self.root)
        self.verbose = verbose
        self.console = console or Console()
        self._model_override = model
        self.user_file = self._ensure_local_user_file()

        self.memory = MemoryStore(
            memory_dir=self.root / "memory",
            user_file=self.user_file,
            memory_template=self.root / "templates" / "init" / "MEMORY.md",
        )
        self.token_tracker = TokenTracker(self.root / "memory" / "tokens.jsonl")
        self.scheduler_store = SchedulerStore(self.root)
        self.scheduler_service = SchedulerService(self.scheduler_store)
        self.project_store = ProjectStore(self.root)
        self.task_manager = TaskManager(self.root)

        self.skills = SkillsLoader(self.root / "skills")
        self.context_builder = ContextBuilder(
            self.root / "templates",
            self.skills,
            memory=self.memory,
        )
        self.context_builder.set_session_scope(
            mode="chat",
            project_index_summary=self.project_store.summary_for_chat(),
        )

        self.workspace_context = WorkspaceContext(self.root)
        self.registry = ToolRegistry()
        self.registry.register(RunCommand(self.workspace_context))
        self.registry.register(WebFetch())
        self.registry.register(LoadSkill(self.skills))
        self.registry.register(ReadFileTool(self.workspace_context))
        self.registry.register(WriteFileTool(self.workspace_context))
        self.registry.register(EditFileTool(self.workspace_context))
        self.registry.register(GlobTool(self.workspace_context))
        self.registry.register(GrepTool(self.workspace_context))
        self.registry.register(SchedulerTool(self.scheduler_service))

        self.control_manager = ControlManager(self.root)
        self.registry.register(AskUserTool(self.control_manager))
        self.registry.register(ProposePlanTool(self.control_manager))

        self.todos = TodoStore()
        self.control_manager.set_todo_store(self.todos)
        self.registry.register(UpdateTodosTool(self.todos))

        self.subagent_registry = SubagentRegistry(
            self.root / "templates" / "subagents",
            skills_loader=self.skills,
        )
        self.context_builder.set_subagent_registry(self.subagent_registry)
        self._install_subagent_tool()
        self._team_managers: dict[str, TeamManager] = {}
        self.team_manager: TeamManager | None = None
        self._active_project_id: str | None = None
        self._active_project_path: str | None = None

        self.mcp_client: MCPClient | None = None
        try:
            self.mcp_client = MCPClient(self.root)
        except Exception as exc:
            logger.warning(f"MCP client init failed: {exc}")

        self.session_store = SessionStore(self.root)
        self._active_session_id: str | None = None
        self._active_conversation: ConversationStore | None = None
        self._active_session_memory: SessionMemoryStore | None = None

        self.refresh_model_config(initial=True)

        # 优先恢复上次未完成 turn 的 checkpoint（含 tool_calls / tool 消息成对的中间状态）；
        # 没有 checkpoint 才回退到 history.jsonl 的未归档段。
        checkpoint = self.memory.read_checkpoint()
        if checkpoint:
            logger.info(f"[Startup: restored checkpoint with {len(checkpoint)} messages]")
            self.history: list = list(checkpoint)
            if self.control_manager.payload().get("pending"):
                logger.info("[Startup: control interaction pending; keeping checkpoint until resume/cancel]")
            else:
                self.memory.clear_checkpoint()
        else:
            unarchived = self.memory.load_unarchived_history()
            if startup_compaction and len(unarchived) >= 2:
                logger.info(f"[Startup: found {len(unarchived)} unarchived turns, compacting...]")
                try:
                    self.compactor.compact_startup(unarchived)
                except Exception as exc:
                    logger.warning(f"startup compaction failed: {exc}")
                unarchived = []
            self.history: list = list(unarchived)

        # ── Multi-session initialisation ────────────────────────────
        self._migrate_if_needed_and_activate()
        # ─────────────────────────────────────────────────────────────

    def _migrate_if_needed_and_activate(self) -> None:
        sessions = self.session_store.list()
        old_history = self.root / "memory" / "history.jsonl"

        if not sessions and old_history.exists():
            logger.info("Migrating legacy conversation into default session...")
            default = self.session_store.create("Default")
            dst = self.session_store._dir(default["id"])

            # Move old history into the session directory
            shutil.move(str(old_history), str(dst / "history.jsonl"))

            # Move old checkpoint if present
            old_cp = self.root / "memory" / "_checkpoint.json"
            if old_cp.exists():
                shutil.move(str(old_cp), str(dst / "_checkpoint.json"))

            # Move runtime events if present
            old_runtime = self.root / "memory" / "runtime" / "events.jsonl"
            dst_rt_dir = dst / "runtime"
            if old_runtime.exists():
                dst_rt_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(old_runtime), str(dst_rt_dir / "events.jsonl"))
            old_rt_archive = self.root / "memory" / "runtime" / "archive"
            if old_rt_archive.exists():
                shutil.move(str(old_rt_archive), str(dst_rt_dir / "archive"))

            sessions = [default]

        if sessions:
            self.activate_session(sessions[0]["id"])

    def activate_session(self, session_id: str) -> None:
        entry = self.session_store.get(session_id)
        if entry is None:
            raise KeyError(f"unknown session: {session_id}")
        conv = ConversationStore(self.session_store.session_dir(session_id))
        self._active_session_id = session_id
        self._active_conversation = conv
        session_mode = str(entry.get("mode") or "chat")
        project_id = str(entry.get("project_id") or "")
        project_path = str(entry.get("project_path") or "")
        self._active_project_id = project_id or None
        self._active_project_path = project_path or None
        project_agents = ""
        if session_mode == "build" and project_id:
            self._active_session_memory = ProjectSessionMemoryStore(
                self.memory,
                conv,
                self.project_store,
                project_id,
            )
            project_agents = self.project_store.read_agents(project_id)
            if project_path and Path(project_path).expanduser().exists():
                self.workspace_context.set(project_path)
            else:
                self.workspace_context.reset()
        else:
            self._active_session_memory = SessionMemoryStore(self.memory, conv)
            self.workspace_context.reset()
        self.context_builder.set_session_scope(
            mode=session_mode,
            project_agents=project_agents,
            project_path=project_path,
            project_index_summary=self.project_store.summary_for_chat(),
        )
        self._activate_team_scope(session_mode, project_id)
        cp = conv.read_checkpoint()
        if cp:
            logger.info(f"Session {session_id[:8]}: restored checkpoint ({len(cp)} msgs)")
            self.history = list(cp)
        else:
            self.history = conv.load_unarchived_history()
        if hasattr(self, "runner"):
            self.runner.memory_store = self._active_session_memory
            self.runner.system_prompt = self.context_builder.build_system_prompt()
        if hasattr(self, "compactor"):
            self.compactor.memory = self._active_session_memory

    @property
    def active_session_id(self) -> str | None:
        return self._active_session_id

    @property
    def active_memory_store(self):
        return self._active_session_memory or self.memory

    def _ensure_local_user_file(self) -> Path:
        template = self.root / "templates" / "init" / "USER.md"
        local = self.root / "templates" / "USER.local.md"
        if not local.exists() and template.exists():
            local.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(template, local)
        return local

    def refresh_model_config(self, *, initial: bool = False) -> None:
        self.model_router = ModelRouter(self.root, model_override=self._model_override)
        main_route = self.model_router.route("main_agent")
        snapshot = main_route.snapshot
        self.provider_snapshot = snapshot
        self.provider = snapshot.provider
        self.provider_name = snapshot.provider_name
        self.provider_label = snapshot.provider_label
        self.model = snapshot.model
        self.max_tokens = snapshot.generation.max_tokens
        self.temperature = snapshot.generation.temperature
        self.reasoning_effort = snapshot.generation.reasoning_effort
        self.max_context = snapshot.context_window_tokens
        self.supports_vision = snapshot.supports_vision
        self.entry_name = snapshot.entry_name
        self.model_role = snapshot.model_role
        self.route_reason = main_route.reason

        compactor_route = self.model_router.route("memory_compaction")
        compactor_snapshot = compactor_route.snapshot
        compactor_fallback = compactor_route.fallback
        self.compactor = Compactor(
            compactor_snapshot.provider,
            compactor_snapshot.model,
            self.memory,
            temperature=compactor_snapshot.generation.temperature,
            reasoning_effort=compactor_snapshot.generation.reasoning_effort,
            provider_name=compactor_snapshot.provider_name,
            token_tracker=self.token_tracker,
            model_role=compactor_snapshot.model_role,
            route_reason=compactor_route.reason,
            fallback_provider=compactor_fallback.provider if compactor_fallback else None,
            fallback_model=compactor_fallback.model if compactor_fallback else None,
            fallback_provider_name=compactor_fallback.provider_name if compactor_fallback else None,
            fallback_generation=compactor_fallback.generation if compactor_fallback else None,
            fallback_model_role=compactor_fallback.model_role if compactor_fallback else "main",
            fallback_route_reason=compactor_fallback.route_reason if compactor_fallback else "",
            runtime_context_provider=PlanContextBuilder(self.control_manager.plan_store).message_for,
        )
        system_prompt = self.context_builder.build_system_prompt()
        if self.verbose and initial:
            logger.info(f"[System Prompt]\n{system_prompt}\n{'='*60}\n")

        if initial or not hasattr(self, "runner"):
            self.runner = AgentRunner(
                provider=self.provider,
                model=self.model,
                registry=self.registry,
                system_prompt=system_prompt,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                reasoning_effort=self.reasoning_effort,
                provider_name=self.provider_name,
                model_role=self.model_role,
                route_reason=self.route_reason,
                route_estimated_tokens=main_route.estimated_tokens,
                usage_type="main_agent",
                memory_store=self.active_memory_store,
                token_tracker=self.token_tracker,
                compactor=self.compactor,
                todo_store=self.todos,
                control_manager=self.control_manager,
                max_context=self.max_context,
            )
            return

        self.runner.provider = self.provider
        self.runner.model = self.model
        self.runner.system_prompt = system_prompt
        self.runner.max_tokens = self.max_tokens
        self.runner.temperature = self.temperature
        self.runner.reasoning_effort = self.reasoning_effort
        self.runner.provider_name = self.provider_name
        self.runner.model_role = self.model_role
        self.runner.route_reason = self.route_reason
        self.runner.route_estimated_tokens = main_route.estimated_tokens
        self.runner.fallback_provider = None
        self.runner.fallback_model = None
        self.runner.fallback_provider_name = None
        self.runner.fallback_generation = None
        self.runner.fallback_model_role = "main"
        self.runner.usage_type = "main_agent"
        self.runner.compactor = self.compactor
        self.runner.memory_store = self.active_memory_store
        self.runner.control_manager = self.control_manager
        self.runner.max_context = self.max_context

    def refresh_runtime_context(self) -> None:
        self.skills.reload()
        self.runner.system_prompt = self.context_builder.build_system_prompt()

    def init_mcp(self) -> None:
        """同步初始化 MCP（CLI / WebUI 启动时调用）。"""
        if not self.mcp_client:
            return
        if getattr(self.mcp_client, "_initialized", False):
            return
        from .providers.base import run_sync
        try:
            run_sync(self.mcp_client.initialize())
            tools = self.mcp_client.get_tools()
            for tool in tools:
                self.registry.register(tool)
            logger.info(f"[MCP] registered {len(tools)} tools")
        except Exception as exc:
            logger.warning(f"MCP initialization failed: {exc}")

    def close_mcp(self) -> None:
        """关闭所有 MCP 连接。"""
        if self.mcp_client:
            from .providers.base import run_sync
            try:
                run_sync(self.mcp_client.close())
            except Exception as exc:
                logger.debug(f"MCP close ignored: {exc}")

    def run(self) -> None:
        self.init_mcp()
        self._print_cli_banner()
        while True:
            user_input = self.console.input("[bold cyan]You[/bold cyan] : ")
            if not user_input.strip():
                continue
            if self._handle_cli_command(user_input):
                continue
            self.history.append({"role": "user", "content": user_input})
            self.active_memory_store.append_history("user", user_input)
            try:
                reply = self.runner.step(self.history)
            except TurnPaused:
                self._drive_cli_control()
                continue
            self._print_assistant(reply)

    def _handle_cli_command(self, user_input: str) -> bool:
        text = user_input.strip()
        if not text.startswith("/"):
            return False
        command = text.split()[0].lower()
        if command in {"/help", "/commands"}:
            self._print_cli_help()
            return True
        if command == "/status":
            self._print_cli_status()
            return True
        if command in {"/init", "/config"}:
            from .onboarding import run_onboarding

            saved = run_onboarding(self.root, console=self.console)
            if saved:
                self.refresh_model_config()
                self._print_cli_status()
            return True
        if command == "/plan":
            parts = text.split(maxsplit=1)
            arg = parts[1].strip().lower() if len(parts) > 1 else "status"
            if arg in {"on", "plan"}:
                self.control_manager.set_mode(ControlMode.PLAN.value)
                self.console.print("[green]Plan 模式已开启：只读探索 + 提问 + 计划预览。[/green]")
                return True
            if arg in {"off", "normal"}:
                self.control_manager.set_mode(ControlMode.ASK_BEFORE_EDIT.value)
                self.console.print("[green]Plan 模式已关闭，已回到编辑前询问模式。[/green]")
                return True
            payload = self.control_manager.payload()
            pending = payload.get("pending")
            pending_label = "-"
            if pending:
                pending_label = f"{pending.get('kind')}:{pending.get('id')}"
            table = Table.grid(padding=(0, 2))
            table.add_column(style="bold cyan")
            table.add_column()
            table.add_row("mode", str(payload.get("mode")))
            table.add_row("previous", str(payload.get("previous_mode") or "-"))
            table.add_row("pending", pending_label)
            self.console.print(Panel(table, title="Control 状态", border_style="cyan"))
            return True
        if command == "/mode":
            parts = text.split(maxsplit=1)
            arg = parts[1].strip().lower() if len(parts) > 1 else "status"
            if arg in {"ask", "ask_before_edit", "edit_before_ask"}:
                self.control_manager.set_mode(ControlMode.ASK_BEFORE_EDIT.value)
                self.console.print("[green]权限模式：编辑前询问。[/green]")
                return True
            if arg == "auto":
                self.control_manager.set_mode(ControlMode.AUTO.value)
                self.console.print("[green]权限模式：自动执行。[/green]")
                return True
            if arg == "plan":
                self.control_manager.set_mode(ControlMode.PLAN.value)
                self.console.print("[green]权限模式：计划模式。[/green]")
                return True
            payload = self.control_manager.payload()
            table = Table.grid(padding=(0, 2))
            table.add_column(style="bold cyan")
            table.add_column()
            table.add_row("mode", str(payload.get("mode")))
            table.add_row("previous", str(payload.get("previous_mode") or "-"))
            self.console.print(Panel(table, title="权限模式", border_style="cyan"))
            return True
        if command == "/clear":
            self.history.clear()
            self.todos.todos = []
            self.console.print("[green]已清空当前 CLI 屏幕上下文；长期记忆和 history.jsonl 未删除。[/green]")
            return True
        if command in {"/exit", "/quit"}:
            raise SystemExit(0)
        self.console.print(f"[yellow]未知命令: {command}。输入 /help 查看可用命令。[/yellow]")
        return True

    def _drive_cli_control(self) -> None:
        while True:
            pending = self.control_manager.payload().get("pending")
            if not pending:
                return
            if pending.get("kind") == InteractionKind.ASK.value:
                self.console.print(Panel(self._render_cli_ask(pending), title="需要定夺", border_style="yellow"))
                answers = {}
                for question in pending.get("questions") or []:
                    qid = question.get("id")
                    raw = self.console.input(f"回答 {question.get('header') or qid}: ").strip()
                    answers[qid] = {"choice": raw, "freeform": ""}
                resume = self.control_manager.answer(pending["id"], answers)
            elif pending.get("kind") == InteractionKind.PLAN.value:
                self.console.print(Panel(self._render_cli_plan(pending), title="计划待预览", border_style="cyan"))
                while True:
                    raw = self.console.input("plan> approve / comment <内容> / cancel: ").strip()
                    if raw == "approve":
                        resume = self.control_manager.approve(pending["id"])
                        break
                    if raw.startswith("comment "):
                        resume = self.control_manager.comment(pending["id"], raw[len("comment "):].strip())
                        break
                    if raw == "cancel":
                        event = self.control_manager.cancel(pending["id"])
                        message = str(event.get("message") or "")
                        if message:
                            self.history.append({"role": "user", "content": message})
                            self.active_memory_store.append_history("user", message, extra={"type": "control_response"})
                        self.active_memory_store.clear_checkpoint()
                        self.console.print(f"[yellow]已取消：{event.get('interaction', {}).get('id')}[/yellow]")
                        return
                    self.console.print("[yellow]请输入 approve、comment <内容> 或 cancel。[/yellow]")
            else:
                return

            self.history.append({"role": "user", "content": resume.message})
            self.active_memory_store.append_history("user", resume.message, extra={"type": "control_response"})
            try:
                reply = self.runner.step(self.history)
            except TurnPaused:
                continue
            self._print_assistant(reply)
            return

    def _print_cli_banner(self) -> None:
        all_defs = self.registry.get_definitions()
        table = Table.grid(padding=(0, 2))
        table.add_column(style="bold cyan")
        table.add_column()
        table.add_row("Provider", self.provider_name)
        table.add_row("Main model", self.model)
        table.add_row("Secondary", self.model_router.secondary.model if self.model_router.secondary.model_role == "secondary" else "-")
        table.add_row("Control", self.control_manager.mode)
        table.add_row("Tools / Skills", f"{len(all_defs)} / {len(self.skills.skills)}")
        table.add_row("Config", str(self.root / "model_config.json"))
        self.console.print(Panel(table, title="Emperor Agent CLI", border_style="red"))
        self.console.print("输入 [bold]/help[/bold] 查看命令，输入 [bold]/init[/bold] 打开初始化向导。")

    def _print_cli_help(self) -> None:
        rows = [
            ("/help", "显示命令列表"),
            ("/status", "查看模型、Provider、Token、工具和技能数量"),
            ("/init", "打开终端初始化向导"),
            ("/config", "同 /init，重新配置核心项"),
            ("/plan on|off|status", "开关或查看 Plan 模式"),
            ("/mode ask|auto|plan|status", "切换或查看三模式权限层"),
            ("/clear", "清空当前 CLI 运行上下文，不删除 memory/history.jsonl"),
            ("/exit", "退出 CLI"),
        ]
        table = Table(title="CLI Commands")
        table.add_column("命令", style="bold cyan")
        table.add_column("说明")
        for command, description in rows:
            table.add_row(command, description)
        self.console.print(table)

    def _print_cli_status(self) -> None:
        totals = self.token_tracker.totals()
        all_defs = self.registry.get_definitions()
        mcp_count = len([d for d in all_defs if d["name"].startswith("mcp_")])
        builtin_count = len(all_defs) - mcp_count
        table = Table.grid(padding=(0, 2))
        table.add_column(style="bold cyan")
        table.add_column()
        table.add_row("provider", self.provider_name)
        table.add_row("model", f"{self.model} (main)")
        table.add_row("secondary", self.model_router.secondary.model if self.model_router.secondary.model_role == "secondary" else "-")
        table.add_row("tokens", f"{totals.get('total', 0)} total / {totals.get('calls', 0)} calls")
        table.add_row("skills", str(len(self.skills.skills)))
        table.add_row("tools", f"{len(all_defs)} (builtin: {builtin_count}, mcp: {mcp_count})")
        table.add_row("history", f"{len(self.history)} in-memory turns")
        table.add_row("control", self.control_manager.mode)
        self.console.print(Panel(table, title="当前状态", border_style="cyan"))

    def _print_assistant(self, reply: str) -> None:
        self.console.print(Panel(str(reply or ""), title="大内总管", border_style="green"))

    @staticmethod
    def _render_cli_ask(interaction: dict) -> str:
        lines = ["\n需要你先定夺几个问题："]
        for question in interaction.get("questions") or []:
            lines.append(f"\n[{question.get('header')}] {question.get('question')}")
            for idx, option in enumerate(question.get("options") or [], start=1):
                lines.append(f"  {idx}. {option.get('label')} — {option.get('description')}")
            lines.append("  也可直接输入自由回答。")
        return "\n".join(lines)

    @staticmethod
    def _render_cli_plan(interaction: dict) -> str:
        assumptions = interaction.get("assumptions") or []
        lines = [
            "\n计划待预览：",
            f"# {interaction.get('title') or 'Plan'}",
            "",
            str(interaction.get("summary") or ""),
            "",
            str(interaction.get("plan_markdown") or ""),
        ]
        if assumptions:
            lines.extend(["", "Assumptions:", *[f"- {item}" for item in assumptions]])
        return "\n".join(lines)

    def _install_subagent_tool(self) -> None:
        def _make_subagent_runner(*, spec, sub_registry, task: str | None = None):
            route = self.model_router.route("subagent", agent_type=spec.name, task=task)
            return build_routed_runner(
                route=route,
                registry=sub_registry,
                system_prompt=spec.system_prompt,
                max_tokens_cap=2000,
                usage_type=f"subagent:{spec.name}",
                token_tracker=self.token_tracker,
                max_turns=spec.max_turns,
            )

        self.registry.register(DispatchSubagentTool(
            client=None,
            model="",
            parent_registry=self.registry,
            subagent_registry=self.subagent_registry,
            runner_factory=_make_subagent_runner,
            task_manager=self.task_manager,
        ))

    def _team_runner_factory(self, project_id: str):
        def _make_team_runner(*, member, spec, sub_registry):
            route = self.model_router.route("team", agent_type=spec.name)
            system_prompt = (
                f"{spec.system_prompt}\n\n"
                "## Agent Team 协作规则\n\n"
                f"- 你的队友名是 `{member.name}`, role 是 `{member.role}`。\n"
                f"- 当前项目 id 是 `{project_id}`。只处理这个项目的任务和文件。\n"
                "- 你拥有自己的持久 thread 与 inbox, 不需要向用户直接发言。\n"
                "- 收到任务后先理解 inbox 内容, 必要时调用工具完成差事。\n"
                "- 完成后必须用 send_message(to=\"lead\", content=\"...\") 回禀关键结果。\n"
                "- 只能处理本队友职责内的任务, 不要创建或唤醒其他队友。\n"
            )
            return build_routed_runner(
                route=route,
                registry=sub_registry,
                system_prompt=system_prompt,
                max_tokens_cap=4000,
                usage_type=f"team:{project_id}:{member.name}",
                token_tracker=self.token_tracker,
                max_turns=spec.max_turns,
            )

        return _make_team_runner

    def _team_registry_for_project(self, project_path: str) -> ToolRegistry:
        workspace = WorkspaceContext(self.root)
        if project_path and Path(project_path).expanduser().exists():
            workspace.set(project_path)
        registry = ToolRegistry()
        registry.register(RunCommand(workspace))
        registry.register(WebFetch())
        registry.register(LoadSkill(self.skills))
        registry.register(ReadFileTool(workspace))
        registry.register(WriteFileTool(workspace))
        registry.register(EditFileTool(workspace))
        registry.register(GlobTool(workspace))
        registry.register(GrepTool(workspace))
        return registry

    def team_manager_for_project(self, project_id: str) -> TeamManager:
        safe_project_id = str(project_id or "").strip()
        if not safe_project_id:
            raise ValueError("project_id is required for project team")
        project = self.project_store.get(safe_project_id)
        if project is None:
            raise ValueError(f"unknown project_id for team: {safe_project_id}")
        if safe_project_id not in self._team_managers:
            project_path = str(project.get("project_path") or "")
            team_dir = self.root / "memory" / "projects" / safe_project_id / "team"
            self._team_managers[safe_project_id] = TeamManager(
                root=self.root,
                team_dir=team_dir,
                project_id=safe_project_id,
                parent_registry=self._team_registry_for_project(project_path),
                subagent_registry=self.subagent_registry,
                runner_factory=self._team_runner_factory(safe_project_id),
                task_manager=self.task_manager,
            )
        return self._team_managers[safe_project_id]

    def _activate_team_scope(self, mode: str, project_id: str) -> None:
        self._uninstall_team_tools()
        if mode == "build" and project_id:
            self.team_manager = self.team_manager_for_project(project_id)
            self._install_team_tools(self.team_manager)
            return
        self.team_manager = None

    def _install_team_tools(self, manager: TeamManager) -> None:
        self.registry.register(TeamSpawnTool(manager))
        self.registry.register(TeamListTool(manager))
        self.registry.register(TeamSendMessageTool(manager))
        self.registry.register(TeamReadInboxTool(manager))
        self.registry.register(TeamBroadcastTool(manager))
        self.registry.register(TeamShutdownTool(manager))

    def _uninstall_team_tools(self) -> None:
        for name in _TEAM_TOOL_NAMES:
            self.registry.unregister(name)
