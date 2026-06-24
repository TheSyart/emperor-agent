from __future__ import annotations

import re
from threading import Lock
from typing import Any

from loguru import logger

from ..plans.reviewer import parse_reviewer_verdict
from ..providers.base import run_sync
from ..runtime import events as runtime_events
from ..tasks import TaskKind
from .base import Tool
from .registry import ToolRegistry
from .schema import StringSchema, tool_parameters_schema

_PLAN_CONTRACT_FIELDS = ("scope_limit", "expected_output", "evidence_required")
_EVIDENCE_FILE_RE = re.compile(
    r"(?<![\w/.-])"
    r"([A-Za-z0-9_./-]+\."
    r"(?:py|pyi|ts|tsx|js|jsx|vue|md|rst|json|toml|yaml|yml|txt|css|scss|html)"
    r"(?::\d+(?:-\d+)?)?)"
)


class DispatchSubagentTool(Tool):
    """派遣预设身份的子代理。子代理拥有独立 history, 跑完只回传一段
    总结文本, 主 agent 的 history 中只多一条 tool_result。"""

    name = "dispatch_subagent"
    exclusive = False
    requires_runtime_context = True
    supports_plan_readonly_exploration = True

    @property
    def concurrency_safe(self) -> bool:
        # 每次派遣都有独立 history / ToolRegistry / AgentRunner。若主模型在同一帧
        # 发出多个 dispatch_subagent, runner 可以并行等待它们完成, 再按原顺序回填结果。
        return True

    def __init__(self, *, client, model: str,
                 parent_registry: ToolRegistry,
                 subagent_registry,
                 runner_factory,
                 task_manager=None,
                 control_manager=None):
        self._client = client
        self._model = model
        self._parent_registry = parent_registry
        self._subagent_registry = subagent_registry
        self._runner_factory = runner_factory   # 注入: spec, sub_registry -> AgentRunner
        self._task_manager = task_manager
        self._control_manager = control_manager
        self._counter = 0
        self._counter_lock = Lock()

    @property
    def description(self) -> str:
        return (
            "派遣一个小太监去单独办差。小太监有自己独立的上下文, 办完只回传"
            "一段文字总结, 不污染主上下文。适用于: 抓取并阅读多个网页、"
            "批量执行命令并整理输出、需要试错的探索性搜索、跨多文件查找等。"
            "Plan 模式只允许 registry 标记的只读探索子代理, 且必须填写 "
            "scope_limit / expected_output / evidence_required; 写入型子代理仍禁止。"
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

    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        spec = self._subagent_registry.get(str(arguments.get("agent_type") or ""))
        if spec is None or not bool(getattr(spec, "plan_readonly_explorer", False)):
            return False
        return not _missing_plan_contract(arguments)

    def is_destructive(self, arguments: dict[str, Any]) -> bool:
        return not self.is_read_only(arguments)

    def execute(self, *, agent_type: str, task: str, purpose: str | None = None,
                expected_output: str | None = None,
                evidence_required: str | None = None,
                scope_limit: str | None = None,
                emit=None, loop=None, parent_call_id=None) -> str:
        import asyncio as asyncio_mod

        def bridge_emit(evt):
            if emit is not None and loop is not None:
                asyncio_mod.run_coroutine_threadsafe(emit(evt), loop)

        spec = self._subagent_registry.get(agent_type)
        if spec is None:
            return (
                f"Error: unknown subagent '{agent_type}'. "
                f"Available: {self._subagent_registry.names(include_aliases=True)}"
            )

        plan_error = self._plan_exploration_error(
            spec=spec,
            arguments={
                "agent_type": agent_type,
                "task": task,
                "expected_output": expected_output,
                "evidence_required": evidence_required,
                "scope_limit": scope_limit,
            },
        )
        if plan_error:
            return plan_error

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
        task_record = None
        if self._task_manager is not None:
            task_record = self._task_manager.start_task(
                kind=TaskKind.SUBAGENT.value,
                title=purpose or task[:80],
                source="dispatch_subagent",
                tool_call_id=parent_call_id,
                metadata={
                    "agent_type": agent_type,
                    "subagent_name": spec.name,
                    "plan_readonly_explorer": bool(getattr(spec, "plan_readonly_explorer", False)),
                    "scope_limit": scope_limit or "",
                    "expected_output": expected_output or "",
                    "evidence_required": evidence_required or "",
                },
            )
            self._task_manager.append_sidechain(task_record.id, history[0])
            bridge_emit(runtime_events.task_started(task_record.to_runtime_dict()))

        if emit is not None and loop is not None and parent_call_id is not None:
            subagent_id = f"sub_{counter}"

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
                bridge_emit({
                    "event": "subagent_error",
                    "parent_id": parent_call_id,
                    "subagent_id": subagent_id,
                    "message": str(exc),
                })
                if task_record is not None:
                    failed = self._task_manager.fail_task(task_record.id, error=str(exc))
                    if failed is not None:
                        bridge_emit(runtime_events.task_error(failed.to_runtime_dict(), error=str(exc)))
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
            completed = self._task_manager.complete_task(task_record.id, summary=final[:500])
            plan_update = self._record_plan_exploration_discovery(
                spec=spec,
                task_record=completed or task_record,
                final=final,
            )
            verification_update = self._record_independent_verification(
                spec=spec,
                task_record=completed or task_record,
                final=final,
            )
            if completed is not None:
                bridge_emit(runtime_events.task_done(completed.to_runtime_dict()))
            if plan_update is not None:
                bridge_emit(runtime_events.plan_runtime_update(plan_update.to_dict()))
            if verification_update is not None:
                bridge_emit(runtime_events.plan_runtime_update(verification_update.to_dict()))

        logger.info(f"  └── subagent context end (内部 history {len(history)} 条, 回传 {len(final)} 字) ──")
        logger.info(f"[小太监回禀]: {final}")
        logger.info(f"[主上下文压缩]: 子代理仅向主 history 追加 {len(final)} 字")
        return final

    def _plan_exploration_error(self, *, spec, arguments: dict[str, Any]) -> str:
        if not self._in_plan_mode():
            return ""
        if not bool(getattr(spec, "plan_readonly_explorer", False)):
            return (
                "Error: Plan mode only allows dispatch_subagent for registry-marked "
                "read-only explorer subagents."
            )
        missing = _missing_plan_contract(arguments)
        if missing:
            return (
                "Error: Plan mode dispatch_subagent requires explicit "
                f"{', '.join(_PLAN_CONTRACT_FIELDS)}. Missing: {', '.join(missing)}."
            )
        return ""

    def _in_plan_mode(self) -> bool:
        return str(getattr(self._control_manager, "mode", "")) == "plan"

    def _record_plan_exploration_discovery(self, *, spec, task_record, final: str):
        if not self._in_plan_mode() or not bool(getattr(spec, "plan_readonly_explorer", False)):
            return None
        recorder = getattr(self._control_manager, "record_plan_discovery", None)
        if not callable(recorder):
            return None
        evidence_refs = [f"task:{task_record.id}", *_extract_evidence_refs(final)]
        try:
            return recorder(
                source=f"dispatch_subagent:{spec.name}",
                summary=_summarize_exploration(final),
                files=_extract_evidence_files(evidence_refs),
                evidence_refs=evidence_refs,
            )
        except Exception as exc:
            logger.warning(f"plan exploration discovery recording failed: {exc}")
            return None

    def _record_independent_verification(self, *, spec, task_record, final: str):
        if getattr(spec, "name", "") != "verification_reviewer":
            return None
        recorder = getattr(self._control_manager, "record_independent_verification_result", None)
        plan_lookup = getattr(self._control_manager, "reviewable_plan_id", None)
        if not callable(recorder) or not callable(plan_lookup):
            return None
        verdict = parse_reviewer_verdict(final)
        if verdict is None:
            return None
        plan_id = plan_lookup()
        if plan_id is None:
            return None
        payload = verdict.to_payload()
        payload["source"] = "verification_reviewer"
        if task_record is not None:
            payload["task_id"] = task_record.id
            payload["transcript_path"] = task_record.transcript_path
        try:
            return recorder(plan_id=plan_id, result=payload)
        except Exception as exc:
            logger.warning(f"independent verification recording failed: {exc}")
            return None


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


def _missing_plan_contract(arguments: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    for field in _PLAN_CONTRACT_FIELDS:
        if not str(arguments.get(field) or "").strip():
            missing.append(field)
    return missing


def _extract_evidence_refs(text: str) -> list[str]:
    refs: list[str] = []
    for match in _EVIDENCE_FILE_RE.findall(text or ""):
        ref = match.strip().rstrip(".,;，。；)")
        if ref.startswith("http://") or ref.startswith("https://"):
            continue
        refs.append(ref)
    return _dedupe_strings(refs)


def _extract_evidence_files(evidence_refs: list[str]) -> list[str]:
    files: list[str] = []
    for ref in evidence_refs:
        if ref.startswith("task:"):
            continue
        files.append(ref.split(":", 1)[0])
    return _dedupe_strings(files)


def _summarize_exploration(text: str, *, limit: int = 500) -> str:
    summary = " ".join((text or "").strip().split())
    if len(summary) <= limit:
        return summary
    return f"{summary[:limit - 3].rstrip()}..."


def _dedupe_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result
