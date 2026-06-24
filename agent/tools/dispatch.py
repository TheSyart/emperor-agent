from __future__ import annotations

from threading import Lock

from loguru import logger

from ..providers.base import run_sync
from .base import Tool
from .registry import ToolRegistry
from .schema import StringSchema, tool_parameters_schema


class DispatchSubagentTool(Tool):
    """派遣预设身份的子代理。子代理拥有独立 history, 跑完只回传一段
    总结文本, 主 agent 的 history 中只多一条 tool_result。"""

    name = "dispatch_subagent"
    exclusive = False
    requires_runtime_context = True

    @property
    def concurrency_safe(self) -> bool:
        # 每次派遣都有独立 history / ToolRegistry / AgentRunner。若主模型在同一帧
        # 发出多个 dispatch_subagent, runner 可以并行等待它们完成, 再按原顺序回填结果。
        return True

    def __init__(self, *, client, model: str,
                 parent_registry: ToolRegistry,
                 subagent_registry,
                 runner_factory,
                 task_manager=None):
        self._client = client
        self._model = model
        self._parent_registry = parent_registry
        self._subagent_registry = subagent_registry
        self._runner_factory = runner_factory   # 注入: spec, sub_registry -> AgentRunner
        self._task_manager = task_manager
        self._counter = 0
        self._counter_lock = Lock()

    @property
    def description(self) -> str:
        return (
            "派遣一个小太监去单独办差。小太监有自己独立的上下文, 办完只回传"
            "一段文字总结, 不污染主上下文。适用于: 抓取并阅读多个网页、"
            "批量执行命令并整理输出、需要试错的探索性搜索、跨多文件查找等。"
            "仅在非 Plan 模式、无待处理 Ask/Plan 且权限允许时使用。"
            "若多件差事互不依赖, 可在同一回复中发出多个 dispatch_subagent, "
            "运行时会并发派遣并按原 tool_use 顺序回填结果。\n\n"
            "可用 agent_type:\n"
            f"{self._subagent_registry.describe()}"
        )

    @property
    def parameters(self) -> dict:
        schema = tool_parameters_schema(
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
        schema["properties"].update({
            "expected_output": StringSchema(
                "可选: 希望子代理最终回禀的具体产物或格式",
                nullable=True,
            ).to_json_schema(),
            "evidence_required": StringSchema(
                "可选: 需要子代理提供的证据类型, 如文件路径/行号/URL/命令摘要",
                nullable=True,
            ).to_json_schema(),
            "scope_limit": StringSchema(
                "可选: 明确禁止越界的范围, 如只读/不改文件/只看某目录",
                nullable=True,
            ).to_json_schema(),
        })
        schema["required"] = ["agent_type", "task"]
        return schema

    def execute(self, *, agent_type: str, task: str, purpose: str | None = None,
                expected_output: str | None = None,
                evidence_required: str | None = None,
                scope_limit: str | None = None,
                emit=None, loop=None, parent_call_id=None) -> str:
        import asyncio as asyncio_mod

        spec = self._subagent_registry.get(agent_type)
        if spec is None:
            return (
                f"Error: unknown subagent '{agent_type}'. "
                f"Available: {self._subagent_registry.names(include_aliases=True)}"
            )

        sub_registry = ToolRegistry()
        for tool_name in spec.tool_names:
            tool = self._parent_registry.get(tool_name)
            if tool is not None:
                sub_registry.register(tool)

        subagent_task = _compose_subagent_task(
            task,
            expected_output=expected_output,
            evidence_required=evidence_required,
            scope_limit=scope_limit,
        )
        runner = self._runner_factory(spec=spec, sub_registry=sub_registry, task=subagent_task)

        with self._counter_lock:
            self._counter += 1
            counter = self._counter

        label = (purpose or task)[:60]
        logger.info(f"[派遣小太监 #{counter} · {spec.name}]: {label}")
        logger.info("  ┌── subagent context start ──")

        history: list = [{"role": "user", "content": subagent_task}]
        subagent_id = f"sub_{counter}"
        task_record = None
        if self._task_manager is not None:
            task_record = self._task_manager.start_task(
                kind="subagent",
                title=purpose or task[:80],
                source="dispatch_subagent",
                tool_call_id=parent_call_id,
                metadata={"agent_type": agent_type, "subagent_id": subagent_id},
            )
            self._task_manager.append_sidechain(task_record.id, history[0])

        if emit is not None and loop is not None and parent_call_id is not None:
            def bridge_emit(evt):
                asyncio_mod.run_coroutine_threadsafe(emit(evt), loop)

            async def sub_emit(evt):
                evt_type = evt.get("event", "")
                if evt_type == "message_delta":
                    evt_type = "subagent_delta"
                elif evt_type == "tool_call":
                    evt_type = "subagent_tool_call"
                elif evt_type == "tool_result":
                    evt_type = "subagent_tool_result"
                elif evt_type == "assistant_done":
                    evt_type = "subagent_done"
                base = {"parent_id": parent_call_id, "subagent_id": subagent_id, "event": evt_type}
                for k, v in evt.items():
                    if k == "event":
                        continue
                    if evt_type == "subagent_done" and k == "content":
                        base["summary"] = v
                    else:
                        base[k] = v
                bridge_emit(base)

            bridge_emit({
                "event": "subagent_start",
                "parent_id": parent_call_id,
                "subagent_id": subagent_id,
                "agent_type": agent_type,
                "purpose": purpose or task[:60],
            })

            try:
                final = run_sync(runner.step_stream(history, sub_emit))
            except Exception as exc:
                if task_record is not None:
                    self._task_manager.fail_task(task_record.id, error=str(exc))
                bridge_emit({
                    "event": "subagent_error",
                    "parent_id": parent_call_id,
                    "subagent_id": subagent_id,
                    "message": str(exc),
                })
                logger.warning(f"  └── subagent context end (异常: {exc}) ──")
                return f"Error: subagent '{agent_type}' raised: {exc}"
        else:
            try:
                final = runner.step(history)
            except Exception as exc:
                if task_record is not None:
                    self._task_manager.fail_task(task_record.id, error=str(exc))
                logger.warning(f"  └── subagent context end (异常: {exc}) ──")
                return f"Error: subagent '{agent_type}' raised: {exc}"

        if task_record is not None:
            self._task_manager.append_sidechain(task_record.id, {"role": "assistant", "content": final})
            self._task_manager.complete_task(task_record.id, summary=final[:500])
        logger.info(f"  └── subagent context end (内部 history {len(history)} 条, 回传 {len(final)} 字) ──")
        logger.info(f"[小太监回禀]: {final}")
        logger.info(f"[主上下文压缩]: 子代理仅向主 history 追加 {len(final)} 字")
        return final


def _compose_subagent_task(
    task: str,
    *,
    expected_output: str | None = None,
    evidence_required: str | None = None,
    scope_limit: str | None = None,
) -> str:
    contract = []
    if expected_output:
        contract.append(f"- 期望产物: {expected_output}")
    if evidence_required:
        contract.append(f"- 证据要求: {evidence_required}")
    if scope_limit:
        contract.append(f"- 范围限制: {scope_limit}")
    contract.append("- 最终回禀必须包含: 结论、证据、风险、建议下一步。")
    return f"{task.rstrip()}\n\n## 差事契约\n" + "\n".join(contract)
