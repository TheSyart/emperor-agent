from __future__ import annotations
from threading import Lock

from .base import Tool
from .registry import ToolRegistry
from .schema import StringSchema, tool_parameters_schema


class DispatchSubagentTool(Tool):
    """派遣预设身份的子代理。子代理拥有独立 history, 跑完只回传一段
    总结文本, 主 agent 的 history 中只多一条 tool_result。"""

    name = "dispatch_subagent"
    exclusive = False

    @property
    def concurrency_safe(self) -> bool:
        # 每次派遣都有独立 history / ToolRegistry / AgentRunner。若主模型在同一帧
        # 发出多个 dispatch_subagent, runner 可以并行等待它们完成, 再按原顺序回填结果。
        return True

    def __init__(self, *, client, model: str,
                 parent_registry: ToolRegistry,
                 subagent_registry,
                 runner_factory):
        self._client = client
        self._model = model
        self._parent_registry = parent_registry
        self._subagent_registry = subagent_registry
        self._runner_factory = runner_factory   # 注入: spec, sub_registry -> AgentRunner
        self._counter = 0
        self._counter_lock = Lock()

    @property
    def description(self) -> str:
        return (
            "派遣一个小太监去单独办差。小太监有自己独立的上下文, 办完只回传"
            "一段文字总结, 不污染主上下文。适用于: 抓取并阅读多个网页、"
            "批量执行命令并整理输出、需要试错的探索性搜索、跨多文件查找等。"
            "若多件差事互不依赖, 可在同一回复中发出多个 dispatch_subagent, "
            "运行时会并发派遣并按原 tool_use 顺序回填结果。\n\n"
            "可用 agent_type:\n"
            f"{self._subagent_registry.describe()}"
        )

    @property
    def parameters(self) -> dict:
        return tool_parameters_schema(
            agent_type=StringSchema(
                "子代理类型, 必须是 description 中列出的可用类型之一",
                enum=self._subagent_registry.names(include_aliases=True),
            ),
            task=StringSchema(
                "交代给小太监的差事, 写清要做什么、希望返回什么格式的总结"
            ),
            purpose=StringSchema(
                "一句话用途标签, 仅用于终端打印",
                nullable=True,
            ),
        )

    def execute(self, *, agent_type: str, task: str, purpose: str | None = None) -> str:
        spec = self._subagent_registry.get(agent_type)
        if spec is None:
            return (
                f"Error: unknown subagent '{agent_type}'. "
                f"Available: {self._subagent_registry.names(include_aliases=True)}"
            )

        # 子 registry: 从父 registry 借出白名单 Tool 实例 (Tool 多为无状态, 共享指针即可)
        sub_registry = ToolRegistry()
        for tool_name in spec.tool_names:
            tool = self._parent_registry.get(tool_name)
            if tool is not None:
                sub_registry.register(tool)

        runner = self._runner_factory(spec=spec, sub_registry=sub_registry)

        with self._counter_lock:
            self._counter += 1
            counter = self._counter

        label = (purpose or task)[:60]
        print(f"\n[派遣小太监 #{counter} · {spec.name}]: {label}")
        print("  ┌── subagent context start ──")

        history: list = [{"role": "user", "content": task}]
        try:
            final = runner.step(history)
        except Exception as exc:
            print(f"  └── subagent context end (异常: {exc}) ──")
            return f"Error: subagent '{agent_type}' raised: {exc}"

        print(f"  └── subagent context end (内部 history {len(history)} 条, 回传 {len(final)} 字) ──")
        print(f"[小太监回禀]: {final}")
        print(f"[主上下文压缩]: 子代理仅向主 history 追加 {len(final)} 字\n")
        return final
