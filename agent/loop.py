from __future__ import annotations
import os
import sys
from pathlib import Path

import anthropic
from dotenv import load_dotenv

from .compactor import Compactor
from .context import ContextBuilder
from .memory import MemoryStore
from .runner import AgentRunner
from .skills import SkillsLoader
from .subagents import SubagentRegistry
from .telemetry import TokenTracker
from .tools import (
    LoadSkill, RunCommand, ToolRegistry, WebFetch,
    ReadFileTool, WriteFileTool, EditFileTool, GlobTool, GrepTool,
    TodoStore, UpdateTodosTool, DispatchSubagentTool,
)


class AgentLoop:
    def __init__(self, root: Path | None = None,
                 model: str = "qwen3.6-35b-a3b-ud-mlx"):
        load_dotenv()
        self.root = root or Path(__file__).parent.parent

        client = anthropic.Anthropic(
            api_key=os.environ["ANTHROPIC_API_KEY"],
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        )

        self.memory = MemoryStore(
            memory_dir=self.root / "memory",
            user_file=self.root / "templates" / "USER.md",
        )
        token_tracker = TokenTracker(self.root / "memory" / "tokens.jsonl")
        compactor = Compactor(client, model, self.memory)

        skills = SkillsLoader(self.root / "skills")
        ctx = ContextBuilder(self.root / "templates", skills, memory=self.memory)

        workspace = self.root
        registry = ToolRegistry()
        registry.register(RunCommand())
        registry.register(WebFetch())
        registry.register(LoadSkill(skills))
        registry.register(ReadFileTool(workspace))
        registry.register(WriteFileTool(workspace))
        registry.register(EditFileTool(workspace))
        registry.register(GlobTool(workspace))
        registry.register(GrepTool(workspace))

        self.todos = TodoStore()
        registry.register(UpdateTodosTool(self.todos))

        # 子代理: 必须最后注册 dispatch 工具, 让它能拿到完整的 parent_registry
        # 传 skills 让子代理 system prompt 也能看到 skills 摘要
        subagent_registry = SubagentRegistry(
            self.root / "templates" / "subagents",
            skills_loader=skills,
        )

        def _make_subagent_runner(*, spec, sub_registry):
            return AgentRunner(
                client=client,
                model=model,
                registry=sub_registry,
                system_prompt=spec.system_prompt,
                max_tokens=2000,
                memory_store=None,
                token_tracker=None,
                compactor=None,
                max_turns=spec.max_turns,
            )

        registry.register(DispatchSubagentTool(
            client=client,
            model=model,
            parent_registry=registry,
            subagent_registry=subagent_registry,
            runner_factory=_make_subagent_runner,
        ))

        unarchived = self.memory.load_unarchived_history()
        if len(unarchived) >= 2:
            print(f"[Startup: found {len(unarchived)} unarchived turns, compacting...]")
            try:
                compactor.compact_startup(unarchived)
            except Exception as exc:
                print(f"[warning] startup compaction failed: {exc}", file=sys.stderr)

        system_prompt = ctx.build_system_prompt()
        print(f"[System Prompt]\n{system_prompt}\n{'='*60}\n")

        self.runner = AgentRunner(
            client=client,
            model=model,
            registry=registry,
            system_prompt=system_prompt,
            memory_store=self.memory,
            token_tracker=token_tracker,
            compactor=compactor,
        )
        self.history: list = []

    def run(self) -> None:
        while True:
            user_input = input("You🫅 : ")
            self.history.append({"role": "user", "content": user_input})
            self.memory.append_history("user", user_input)
            reply = self.runner.step(self.history)
            print(f"大内总管🧟\u200d♂️: {reply}\n")
