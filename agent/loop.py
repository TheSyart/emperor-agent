from __future__ import annotations

import shutil
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger

from .compactor import Compactor
from .context import ContextBuilder
from .logger import configure as configure_logging
from .memory import MemoryStore
from .model_config import build_provider_snapshot
from .runner import AgentRunner
from .skills import SkillsLoader
from .subagents import SubagentRegistry
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


class AgentLoop:
    def __init__(
        self,
        root: Path | None = None,
        model: str | None = None,
        verbose: bool = True,
        startup_compaction: bool = True,
    ):
        load_dotenv()
        self.root = root or Path(__file__).parent.parent
        configure_logging(self.root)
        self.verbose = verbose
        self._model_override = model
        self.user_file = self._ensure_local_user_file()

        self.memory = MemoryStore(
            memory_dir=self.root / "memory",
            user_file=self.user_file,
            memory_template=self.root / "templates" / "init" / "MEMORY.md",
        )
        self.token_tracker = TokenTracker(self.root / "memory" / "tokens.jsonl")

        self.skills = SkillsLoader(self.root / "skills")
        self.context_builder = ContextBuilder(
            self.root / "templates",
            self.skills,
            memory=self.memory,
        )

        workspace = self.root
        self.registry = ToolRegistry()
        self.registry.register(RunCommand(workspace))
        self.registry.register(WebFetch())
        self.registry.register(LoadSkill(self.skills))
        self.registry.register(ReadFileTool(workspace))
        self.registry.register(WriteFileTool(workspace))
        self.registry.register(EditFileTool(workspace))
        self.registry.register(GlobTool(workspace))
        self.registry.register(GrepTool(workspace))

        self.todos = TodoStore()
        self.registry.register(UpdateTodosTool(self.todos))

        self.subagent_registry = SubagentRegistry(
            self.root / "templates" / "subagents",
            skills_loader=self.skills,
        )
        self._install_subagent_tool()

        self.refresh_model_config(initial=True)

        # 优先恢复上次未完成 turn 的 checkpoint（含 tool_calls / tool 消息成对的中间状态）；
        # 没有 checkpoint 才回退到 history.jsonl 的未归档段。
        checkpoint = self.memory.read_checkpoint()
        if checkpoint:
            logger.info(f"[Startup: restored checkpoint with {len(checkpoint)} messages]")
            self.history: list = list(checkpoint)
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

    def _ensure_local_user_file(self) -> Path:
        template = self.root / "templates" / "init" / "USER.md"
        local = self.root / "templates" / "USER.local.md"
        if not local.exists() and template.exists():
            local.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(template, local)
        return local

    def refresh_model_config(self, *, initial: bool = False) -> None:
        snapshot = build_provider_snapshot(self.root, model_override=self._model_override)
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

        self.compactor = Compactor(
            self.provider,
            self.model,
            self.memory,
            temperature=self.temperature,
            reasoning_effort=self.reasoning_effort,
            provider_name=self.provider_name,
            token_tracker=self.token_tracker,
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
                usage_type="main_agent",
                memory_store=self.memory,
                token_tracker=self.token_tracker,
                compactor=self.compactor,
                todo_store=self.todos,
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
        self.runner.usage_type = "main_agent"
        self.runner.compactor = self.compactor
        self.runner.max_context = self.max_context

    def refresh_runtime_context(self) -> None:
        self.skills.reload()
        self.runner.system_prompt = self.context_builder.build_system_prompt()

    def run(self) -> None:
        while True:
            user_input = input("You🫅 : ")
            if self._handle_cli_command(user_input):
                continue
            self.history.append({"role": "user", "content": user_input})
            self.memory.append_history("user", user_input)
            reply = self.runner.step(self.history)
            logger.info(f"大内总管: {reply}")

    def _handle_cli_command(self, user_input: str) -> bool:
        text = user_input.strip()
        if not text.startswith("/"):
            return False
        command = text.split()[0].lower()
        if command in {"/help", "/commands"}:
            logger.info(
                "\n可用命令:\n"
                "  /help      显示命令列表\n"
                "  /status    查看模型、Provider、Token、工具和技能数量\n"
                "  /clear     清空当前 CLI 运行上下文, 不删除 memory/history.jsonl\n"
                "  /exit      退出 CLI\n"
            )
            return True
        if command == "/status":
            totals = self.token_tracker.totals()
            logger.info(
                "\n当前状态:\n"
                f"  provider: {self.provider_name}\n"
                f"  model:    {self.model}\n"
                f"  tokens:   {totals.get('total', 0)} total / {totals.get('calls', 0)} calls\n"
                f"  skills:   {len(self.skills.skills)}\n"
                f"  tools:    {len(self.registry.get_definitions())}\n"
                f"  history:  {len(self.history)} in-memory turns\n"
            )
            return True
        if command == "/clear":
            self.history.clear()
            self.todos.todos = []
            logger.info("\n已清空当前 CLI 屏幕上下文；长期记忆和 history.jsonl 未删除。")
            return True
        if command in {"/exit", "/quit"}:
            raise SystemExit(0)
        logger.warning(f"\n未知命令: {command}。输入 /help 查看可用命令。")
        return True

    def _install_subagent_tool(self) -> None:
        def _make_subagent_runner(*, spec, sub_registry):
            return AgentRunner(
                provider=self.provider,
                model=self.model,
                registry=sub_registry,
                system_prompt=spec.system_prompt,
                max_tokens=min(2000, self.max_tokens),
                temperature=self.temperature,
                reasoning_effort=self.reasoning_effort,
                provider_name=self.provider_name,
                usage_type=f"subagent:{spec.name}",
                memory_store=None,
                token_tracker=self.token_tracker,
                compactor=None,
                max_turns=spec.max_turns,
            )

        self.registry.register(DispatchSubagentTool(
            client=None,
            model="",
            parent_registry=self.registry,
            subagent_registry=self.subagent_registry,
            runner_factory=_make_subagent_runner,
        ))
