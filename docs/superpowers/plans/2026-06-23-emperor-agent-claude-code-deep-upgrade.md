# Emperor Agent Claude Code Deep Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a staged Emperor Agent upgrade that absorbs Claude Code's query state machine, tool protocol, permission pipeline, context budget pipeline, task runtime, sidechain transcript, and replayable UI events without copying Claude Code UI or provider-specific internals.

**Architecture:** Add narrow Python modules around the existing runner first, keep behavior compatible, and move logic out of `agent/runner.py` only after characterization tests lock current behavior. Each Epic lands behind adapters: old tools keep working, current Ask/Plan remains authoritative, runtime replay remains backend-owned, and Vue/Electron receives explicit event schemas instead of inferred state.

**Tech Stack:** Python 3, dataclasses, pytest, existing provider abstractions, existing `RuntimeEventStore`, Vue 3 runtime reducer/types, Markdown project documentation.

---

## Source Anchors From Claude Code

Use these source files as design references during implementation. They are research inputs only; do not copy large code blocks or Anthropic-only request features into Emperor Agent.

| Design area | Claude Code source | Emperor target |
|---|---|---|
| Query state machine | `/Users/anhuike/Documents/workspace/claude-code-source-code/src/query.ts` | `agent/runner.py`, new `agent/query_state/*` |
| Query config and injectable deps | `/Users/anhuike/Documents/workspace/claude-code-source-code/src/query/config.ts`, `src/query/deps.ts` | `agent/runner_factory.py`, `agent/runner_model.py` |
| Tool protocol | `/Users/anhuike/Documents/workspace/claude-code-source-code/src/Tool.ts` | `agent/tools/base.py`, new `agent/tools/protocol.py`, `agent/tools/results.py`, `agent/tools/context.py` |
| Tool execution pipeline | `src/services/tools/toolExecution.ts` | new `agent/tools/execution.py`, updates to `agent/tools/registry.py` |
| Streaming tool executor | `src/services/tools/StreamingToolExecutor.ts` | new `agent/tools/execution.py`, `agent/runtime/events.py` |
| Permission pipeline | `src/utils/permissions/*`, `src/hooks/useCanUseTool.tsx` | `agent/permissions/*`, `agent/control/*` |
| Plan mode and project execution | `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`, `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`, `src/tools/TodoWriteTool/TodoWriteTool.ts`, `src/commands/plan/plan.tsx`, `src/utils/messages.ts`, `src/utils/plans.ts`, `src/utils/attachments.ts` | `agent/plans/*`, `agent/control/*`, `agent/tools/todo.py`, `agent/context_pipeline/*`, frontend plan projection |
| Context budgets | `src/utils/toolResultStorage.ts`, `src/services/compact/*`, `src/services/contextCollapse/*` | new `agent/context_pipeline/*`, `agent/compactor.py`, `agent/memory.py` |
| Task state | `src/Task.ts`, `src/tasks/LocalAgentTask/*`, `src/tasks/LocalMainSessionTask.ts` | new `agent/tasks/*`, `agent/runtime/active.py` |
| Subagent sidechain | `src/tools/AgentTool/runAgent.ts`, `src/utils/sessionStorage.ts` | `agent/tools/dispatch.py`, `agent/team/manager.py`, new `agent/tasks/sidechain.py` |
| Runtime projection | `src/state/*`, `src/components/TaskListV2.tsx` | `agent/runtime/*`, `desktop/src/renderer/src/runtime/*`, `desktop/src/renderer/src/types.ts` |

## Scope Split

This upgrade spans independent subsystems. Execute in this sequence so every stage is testable and revertable:

1. Characterize current behavior.
2. Extract request context projection.
3. Add Tool Protocol v2 adapters.
4. Add Tool Execution Engine.
5. Add Permission Pipeline v2.
6. Add Query State transition helpers.
7. Add Project Execution and Plan Runtime v2.
8. Strengthen Project Execution and Plan Runtime v3.
9. Add Task Framework and sidechain transcript.
10. Add runtime replay and Vue task projection.
11. Add advanced context budgets and reactive compact.

Do not start Phase 6 before Phase 3 and Phase 4 are merged, because sidechain transcript relies on structured tool results and execution lifecycle events.

## Current Progress

- Project Execution and Plan Runtime v2 has a durable `PlanRecord`/`PlanStep` store, plan approval activation, todo synchronization, command verification evidence, verification failure follow-up, and final-answer gate.
- Plan replay is now visible in the Chat UI: `planProjection` is exposed through app context, `PlanCard` renders step status, files, commands, verification evidence, and failed stderr/stdout summaries, and `planProjection.test.ts` covers interaction-to-plan selection.
- Project Execution Prompt Contract is now explicit in approved-plan follow-up messages and stable prompt templates: active todo maintenance, verification evidence, failure repair, blocked-state escalation, and no-final-answer-before-complete are covered by tests.
- Advanced context budget work has started: `ToolResultStore` is available, `ContextPipeline(tool_result_store=...)` can replace large tool messages with stable artifact-backed model content, `AgentRunner` uses store-backed projection when a memory store is present, and tool-level `max_result_chars` budgets flow from `ToolRegistry` into that projection.
- First built-in result budgets are now configured: `read_file=24000`, `grep=16000`, `glob=12000`, `run_command=12000`, `web_fetch=10000`.
- MCP result budgets now flow from `mcp_config.json` `defaults.max_result_chars` and `tool_overrides.<tool>.max_result_chars` into `MCPToolAdapter.max_result_chars`, `ToolRegistry.tool_result_limits()`, and the default `ContextPipeline`.
- Structured `ToolResult` is now preserved across `ToolRegistry.execute_result()`, `ToolExecutionEngine`, `AgentRunner` tool messages/runtime summaries, and WebUI replay types. Legacy `execute()` remains string-compatible.
- First native high-value tool mappings are now in place: `read_file` emits source-file artifact metadata and line ranges, `grep` emits match/search metadata, and `run_command` emits command/exit/timeout/truncation metadata while keeping legacy `execute()` string-compatible.
- Write/edit result mapping is now in place: `write_file` and `edit_file` emit file artifacts, concise summaries, unified diff previews, and change metadata while keeping legacy `execute()` string-compatible.
- Tool-card evidence display is now in place: Chat tool cards render artifact paths, artifact kind/size, and diff previews from replayed runtime metadata.
- Project Execution and Plan Runtime v3 has started: `PlanDecisionPolicy` now deterministically classifies required/recommended/proceed planning cases and Runner blocks non-read-only tools for required-plan requests before files are modified.
- `PlanDraftState` now persists plan phase, relevant files, open/resolved questions, alternatives, recommended approach, verification strategy, and plan comment revision snapshots across `PlanRecord` reloads.
- `PlanQualityGate` now rejects weak `propose_plan` calls before a PlanCard is created, requiring concrete scope, verification, and high-risk risk/rollback notes.
- `PlanEvidenceGate` now rejects `update_todos` completion for command-backed PlanSteps until matching verification evidence has passed, preserves explicit `plan_step_id`, and requires `blocked_reason` for blocked steps.
- Approved plan command scope is now explicit: active PlanStep verification commands receive `plan.approved_command` permission only when they are exact non-high-risk `run_command` matches; high-risk shell and writes still use the normal permission pipeline.
- `PlanContextBuilder` now injects durable plan runtime context into model projection and memory compaction prompts, preserving active step, failed evidence, blocked reason, open questions, files, and artifacts after compaction/recovery.
- Independent Verification Gate is now part of Plan Runtime v3: non-trivial completed plans require reviewer PASS with command evidence or user waiver before final answer, and PlanCard projects required/passed/failed/waived/missing-evidence states.
- Task Framework v1 is in place: `TaskStore`, `TaskManager`, `SidechainTranscript`, task lifecycle runtime events, frontend task projection, subagent task registration, Team wake task records, Scheduler task records, and task transcript API are all covered by focused tests.
- The remaining upgrade lane is task transcript consolidation across more long-running tools plus microcompact/reactive compact refinements on top of the file-backed tool result store.

## File Structure

### New backend modules

- Create `agent/context_pipeline/__init__.py`
  Export `ContextPipeline`, `ContextProjection`, and helpers.
- Create `agent/context_pipeline/models.py`
  Dataclasses for projected messages, budget report, replacement records, and stage issues.
- Create `agent/context_pipeline/pairing.py`
  Move tool call/result pairing out of `AgentRunner`.
- Create `agent/context_pipeline/tool_results.py`
  Move current cap/shrink logic first, then add file-backed replacement.
- Create `agent/context_pipeline/pipeline.py`
  Orchestrate pairing, result budget, snip, local microcompact, and future reactive recovery.
- Create `agent/tools/results.py`
  Define `ToolResult`, `ToolArtifact`, `ToolResultContent`.
- Create `agent/tools/context.py`
  Define `ToolExecutionContext` and event emit wrapper.
- Create `agent/tools/protocol.py`
  Define `ToolV2`, `ToolAdapter`, and `PreparedToolCall`.
- Create `agent/tools/execution.py`
  Implement queued/executing/completed/failed/cancelled execution state.
- Create `agent/permissions/pipeline.py`
  Combine tool-specific checks, mode policy, safety checks, resolver behavior.
- Create `agent/permissions/resolvers.py`
  Define interactive and non-interactive permission resolution.
- Create `agent/query_state/__init__.py`
- Create `agent/query_state/models.py`
  Define `QueryState`, `QueryTransition`, and reason constants.
- Create `agent/query_state/transitions.py`
  Pure helpers for empty response, truncation recovery, max turns, plan pause, and continuation.
- Create `agent/plans/__init__.py`
- Create `agent/plans/models.py`
  Durable structured plan, step, status, and verification models.
- Create `agent/plans/store.py`
  Local plan store under `memory/plans/index.json`.
- Create `agent/plans/execution.py`
  Pure helpers for starting, completing, failing, and blocking plan steps.
- Create `agent/plans/verification.py`
  Verification command/result records for project execution gates.
- Create `agent/tasks/__init__.py`
- Create `agent/tasks/models.py`
  Define persistent `TaskRecord`, `TaskStatus`, `TaskKind`, `TaskProgress`.
- Create `agent/tasks/store.py`
  Durable task metadata store under `memory/tasks/index.json`.
- Create `agent/tasks/sidechain.py`
  Append-only transcript writer and paginated reader under `memory/tasks/{task_id}/transcript.jsonl`.
- Create `agent/tasks/manager.py`
  Runtime-facing task manager that wraps `ActiveTaskRegistry`.

### Existing backend modules to modify

- Modify `agent/runner.py`
  Replace inline context cleanup and tool execution with injected pipeline/engine while keeping public methods.
- Modify `agent/runner_factory.py`
  Build runner with context pipeline, tool execution engine, and task manager once modules exist.
- Modify `agent/runner_model.py`
  Preserve fallback behavior; later return structured model errors.
- Modify `agent/tools/base.py`
  Add default v2 trait methods without breaking current tools.
- Modify `agent/tools/registry.py`
  Return `PreparedToolCall`; execute via adapter; expose tool metadata to WebUI.
- Modify `agent/tools/filesystem.py`
  Add read-state tracking and structured diff result for file edit.
- Modify `agent/tools/shell.py`
  Split safety analysis from command execution and expose it to permission pipeline.
- Modify `agent/tools/dispatch.py`
  Create task record and sidechain transcript for subagent runs.
- Modify `agent/team/manager.py`
  Map every teammate wake to task record and sidechain transcript; keep `.team` as identity/message store.
- Modify `agent/scheduler/service.py` and `agent/web/services/scheduler_executor.py`
  Register scheduler runs as tasks.
- Modify `agent/runtime/events.py`
  Add context projection, tool lifecycle, permission, and task lifecycle events.
- Modify `agent/runtime/active.py`
  Bridge process-local active tasks to durable `TaskRecord`.
- Modify `agent/web/container.py`
  Construct and inject `TaskManager`.
- Modify `agent/web/routes/*`
  Add task status and sidechain transcript endpoints after backend task store exists.

### Frontend modules to modify

- Modify `desktop/src/renderer/src/types.ts`
  Add `TaskRecord`, task lifecycle events, context projection event, tool run status events.
- Modify `desktop/src/renderer/src/runtime/events.ts`
  Keep event sorting but type new event families.
- Modify `desktop/src/renderer/src/runtime/selectors.ts`
  Add task selectors and sidechain link selectors.
- Modify `desktop/src/renderer/src/composables/useRuntime.ts`
  Consume task lifecycle and tool lifecycle events.
- Create `desktop/src/renderer/src/runtime/handlers/tasks.ts`
  Reducer helper for task projection.
- Create `desktop/src/renderer/src/runtime/handlers/plans.ts`
  Reducer helper for structured plan projection and verification evidence.
- Create `desktop/src/renderer/src/runtime/taskProjection.test.ts`
  Unit tests for task event replay.
- Create `desktop/src/renderer/src/runtime/planProjection.test.ts`
  Unit tests for plan replay and step evidence updates.
- Create `desktop/src/renderer/src/components/chat/TaskTrail.vue`
  Compact task summary component for Chat timeline.
- Create `desktop/src/renderer/src/components/panels/TasksPanel.vue`
  Optional panel once task endpoints exist.

### Tests

- Create `tests/unit/test_runner_behavior_contract.py`
- Create `tests/unit/test_context_pipeline.py`
- Create `tests/unit/test_tool_protocol_v2.py`
- Create `tests/unit/test_tool_execution_engine.py`
- Create `tests/unit/test_permission_pipeline_v2.py`
- Create `tests/unit/test_query_state.py`
- Create `tests/unit/test_plan_store.py`
- Create `tests/unit/test_plan_runtime.py`
- Create `tests/unit/test_plan_execution_state.py`
- Create `tests/unit/test_plan_verification.py`
- Create `tests/unit/test_tasks_store.py`
- Create `tests/unit/test_sidechain_transcript.py`
- Create `tests/unit/test_task_runtime_api.py`

## Global Implementation Rules

- Preserve current public commands: `emperor-agent chat`, `emperor-agent web`, `emperor-agent doctor --dev`.
- Do not change provider request schemas in the first three Epics.
- Do not move `.team` data into task store. Team member identity remains in `.team`; each wake gets a task run.
- Do not let Scheduler, Team, External, or background tasks bypass Ask/Plan.
- Do not introduce automatic permission classifier until rule-based behavior is covered by tests.
- Keep `memory/`, `.team/`, `model_config.json`, `mcp_config.json`, `emperor.local.json`, and `templates/USER.local.md` out of commits.

## Phase 0: Characterize Current Behavior

### Task 1: Runner Behavior Contract

**Files:**
- Create: `tests/unit/test_runner_behavior_contract.py`
- Read: `agent/runner.py`
- Read: `agent/providers/base.py`

- [ ] **Step 1: Create tests that lock current tool pairing and tool-result shrink behavior**

Create `tests/unit/test_runner_behavior_contract.py` with this content:

```python
from agent.runner import AgentRunner


def test_pair_tool_calls_fills_missing_tool_result() -> None:
    history = [
        {"role": "user", "content": "run it"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
    ]

    cleaned = AgentRunner._pair_tool_calls(history)

    assert cleaned[-1] == {
        "role": "tool",
        "tool_call_id": "call_1",
        "name": "read_file",
        "content": "(tool execution interrupted)",
    }


def test_pair_tool_calls_drops_orphan_tool_message() -> None:
    history = [
        {"role": "tool", "tool_call_id": "orphan", "name": "read_file", "content": "bad"},
        {"role": "user", "content": "hello"},
    ]

    cleaned = AgentRunner._pair_tool_calls(history)

    assert cleaned == [{"role": "user", "content": "hello"}]


def test_cap_tool_result_keeps_head_and_tail() -> None:
    text = "a" * 9000 + "tail"
    history = [{"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": text}]

    capped = AgentRunner._cap_tool_result(history, per_call_limit=8000)

    content = capped[0]["content"]
    assert content.startswith("a" * 100)
    assert content.endswith("tail")
    assert "truncated, total 9004 chars" in content


def test_shrink_old_tool_results_keeps_recent_tool_messages() -> None:
    old_large = {"role": "tool", "tool_call_id": "old", "name": "grep", "content": "x" * 2000}
    recent_large = {"role": "tool", "tool_call_id": "recent", "name": "grep", "content": "y" * 2000}
    history = [old_large, {"role": "user", "content": "middle"}, recent_large]

    shrunk = AgentRunner._shrink_old_tool_results(history, keep_recent=2)

    assert shrunk[0]["content"] == "[shrunk] grep → 2000 chars omitted"
    assert shrunk[2]["content"] == "y" * 2000
```

- [ ] **Step 2: Run the new contract tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_runner_behavior_contract.py -q
```

Expected:

```text
4 passed
```

- [ ] **Step 3: Commit the characterization tests**

Run:

```bash
git add tests/unit/test_runner_behavior_contract.py
git commit -m "test: characterize runner context behavior"
```

Expected: commit succeeds with one new test file.

## Phase 1: Context Pipeline

### Task 2: Extract Pairing and Tool Result Budget Without Behavior Change

**Files:**
- Create: `agent/context_pipeline/__init__.py`
- Create: `agent/context_pipeline/models.py`
- Create: `agent/context_pipeline/pairing.py`
- Create: `agent/context_pipeline/tool_results.py`
- Create: `agent/context_pipeline/pipeline.py`
- Create: `tests/unit/test_context_pipeline.py`
- Modify: `agent/runner.py`

- [ ] **Step 1: Write failing tests for the new pipeline module**

Create `tests/unit/test_context_pipeline.py`:

```python
from agent.context_pipeline.pipeline import ContextPipeline


def test_context_pipeline_repairs_missing_tool_result() -> None:
    history = [
        {"role": "user", "content": "inspect"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
    ]

    projection = ContextPipeline().project(history)

    assert projection.messages[-1]["role"] == "tool"
    assert projection.messages[-1]["tool_call_id"] == "call_1"
    assert projection.report["paired_missing_tool_results"] == 1


def test_context_pipeline_caps_large_tool_result() -> None:
    history = [{"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": "x" * 9000}]

    projection = ContextPipeline(per_call_limit=8000).project(history)

    assert "truncated, total 9000 chars" in projection.messages[0]["content"]
    assert projection.report["capped_tool_results"] == 1


def test_context_pipeline_does_not_mutate_input_history() -> None:
    history = [{"role": "tool", "tool_call_id": "call_1", "name": "grep", "content": "x" * 9000}]
    original = [dict(history[0])]

    ContextPipeline(per_call_limit=8000).project(history)

    assert history == original
```

- [ ] **Step 2: Run tests and confirm the module is missing**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.context_pipeline'
```

- [ ] **Step 3: Add context pipeline models**

Create `agent/context_pipeline/models.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ContextProjection:
    messages: list[dict[str, Any]]
    report: dict[str, Any] = field(default_factory=dict)
```

- [ ] **Step 4: Add pairing helper**

Create `agent/context_pipeline/pairing.py`:

```python
from __future__ import annotations

from typing import Any


def pair_tool_calls(history: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    cleaned: list[dict[str, Any]] = []
    expected: list[tuple[str, str]] = []
    filled = 0
    dropped = 0

    def flush_expected() -> None:
        nonlocal filled
        for tool_call_id, tool_name in expected:
            cleaned.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_name,
                "content": "(tool execution interrupted)",
            })
            filled += 1
        expected.clear()

    for message in history:
        copied = dict(message)
        role = copied.get("role")
        if role == "tool":
            tool_call_id = copied.get("tool_call_id")
            index = next((i for i, (expected_id, _) in enumerate(expected) if expected_id == tool_call_id), None)
            if index is None:
                dropped += 1
                continue
            cleaned.append(copied)
            expected.pop(index)
            continue
        flush_expected()
        cleaned.append(copied)
        if role == "assistant":
            for tool_call in copied.get("tool_calls") or []:
                function = tool_call.get("function") or {}
                expected.append((tool_call.get("id") or "", function.get("name", "")))
    flush_expected()
    return cleaned, filled, dropped
```

- [ ] **Step 5: Add tool result budget helper**

Create `agent/context_pipeline/tool_results.py`:

```python
from __future__ import annotations

from typing import Any

DEFAULT_KEEP_RECENT = 10
DEFAULT_MIN_BYTES = 1500
DEFAULT_TOOL_RESULT_BUDGET = 8000
DEFAULT_TOOL_RESULT_TAIL = 200


def content_text_size(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(
            len(str(block.get("text", "")))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return len(str(content or ""))


def cap_tool_results(
    history: list[dict[str, Any]],
    *,
    per_call_limit: int = DEFAULT_TOOL_RESULT_BUDGET,
    tail_chars: int = DEFAULT_TOOL_RESULT_TAIL,
) -> tuple[list[dict[str, Any]], int]:
    out: list[dict[str, Any]] = []
    capped = 0
    head_chars = max(1, per_call_limit - tail_chars)
    for message in history:
        copied = dict(message)
        if copied.get("role") == "tool":
            text = str(copied.get("content", ""))
            if len(text) > per_call_limit:
                head = text[:head_chars]
                tail = text[-tail_chars:]
                copied["content"] = f"{head}\n...[truncated, total {len(text)} chars]...\n{tail}"
                capped += 1
        out.append(copied)
    return out, capped


def shrink_old_tool_results(
    history: list[dict[str, Any]],
    *,
    keep_recent: int = DEFAULT_KEEP_RECENT,
    min_bytes: int = DEFAULT_MIN_BYTES,
) -> tuple[list[dict[str, Any]], int]:
    cutoff = max(0, len(history) - keep_recent)
    out: list[dict[str, Any]] = []
    shrunk = 0
    for index, message in enumerate(history):
        copied = dict(message)
        if (
            copied.get("role") == "tool"
            and index < cutoff
            and content_text_size(copied.get("content")) > min_bytes
        ):
            name = copied.get("name") or copied.get("tool_call_id") or "tool"
            size = content_text_size(copied.get("content"))
            copied["content"] = f"[shrunk] {name} → {size} chars omitted"
            shrunk += 1
        out.append(copied)
    return out, shrunk
```

- [ ] **Step 6: Add pipeline orchestrator**

Create `agent/context_pipeline/pipeline.py`:

```python
from __future__ import annotations

from .models import ContextProjection
from .pairing import pair_tool_calls
from .tool_results import cap_tool_results, shrink_old_tool_results


class ContextPipeline:
    def __init__(self, *, per_call_limit: int = 8000, keep_recent: int = 10) -> None:
        self.per_call_limit = per_call_limit
        self.keep_recent = keep_recent

    def project(self, history: list[dict]) -> ContextProjection:
        paired, filled, dropped = pair_tool_calls(history)
        capped, capped_count = cap_tool_results(paired, per_call_limit=self.per_call_limit)
        shrunk, shrunk_count = shrink_old_tool_results(capped, keep_recent=self.keep_recent)
        return ContextProjection(
            messages=shrunk,
            report={
                "paired_missing_tool_results": filled,
                "dropped_orphan_tool_results": dropped,
                "capped_tool_results": capped_count,
                "shrunk_old_tool_results": shrunk_count,
            },
        )
```

Create `agent/context_pipeline/__init__.py`:

```python
from .models import ContextProjection
from .pipeline import ContextPipeline

__all__ = ["ContextPipeline", "ContextProjection"]
```

- [ ] **Step 7: Update runner to use the pipeline**

Modify `agent/runner.py` imports:

```python
from .context_pipeline import ContextPipeline
```

Add to `AgentRunner.__init__` parameters:

```python
        context_pipeline: ContextPipeline | None = None,
```

Add inside `__init__`:

```python
        self.context_pipeline = context_pipeline or ContextPipeline()
```

Replace the first three lines of `_ask_model()`:

```python
        governed = self._pair_tool_calls(history)
        governed = self._cap_tool_result(governed)
        governed = self._shrink_old_tool_results(governed)
```

with:

```python
        projection = self.context_pipeline.project(history)
        governed = projection.messages
```

Keep the old static methods temporarily for compatibility with `tests/unit/test_runner_behavior_contract.py`.

- [ ] **Step 8: Run context and runner contract tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_context_pipeline.py tests/unit/test_runner_behavior_contract.py -q
```

Expected:

```text
7 passed
```

- [ ] **Step 9: Commit context pipeline extraction**

Run:

```bash
git add agent/context_pipeline agent/runner.py tests/unit/test_context_pipeline.py
git commit -m "refactor: extract context projection pipeline"
```

Expected: commit succeeds.

## Phase 2: Tool Protocol v2

### Task 3: Add Structured Tool Results and Tool Context

**Files:**
- Create: `agent/tools/results.py`
- Create: `agent/tools/context.py`
- Create: `agent/tools/protocol.py`
- Create: `tests/unit/test_tool_protocol_v2.py`
- Modify: `agent/tools/base.py`
- Modify: `agent/tools/registry.py`

- [ ] **Step 1: Write failing tests for old tools wrapped as v2**

Create `tests/unit/test_tool_protocol_v2.py`:

```python
from pathlib import Path

from agent.tools.base import Tool, tool_parameters
from agent.tools.context import ToolExecutionContext
from agent.tools.protocol import ToolAdapter
from agent.tools.registry import ToolRegistry
from agent.tools.results import ToolResult


@tool_parameters({
    "type": "object",
    "properties": {"path": {"type": "string"}},
    "required": ["path"],
})
class EchoPathTool(Tool):
    name = "echo_path"
    description = "echo path"
    read_only = True

    def execute(self, path: str) -> str:
        return f"path={path}"


def test_tool_adapter_wraps_string_result(tmp_path: Path) -> None:
    context = ToolExecutionContext(root=tmp_path, turn_id="turn_1")
    result = ToolAdapter(EchoPathTool()).execute_sync({"path": "a.txt"}, context)

    assert isinstance(result, ToolResult)
    assert result.model_content == "path=a.txt"
    assert result.display_summary == "path=a.txt"


def test_registry_prepare_call_returns_structured_call() -> None:
    registry = ToolRegistry()
    registry.register(EchoPathTool())

    prepared = registry.prepare_call("echo_path", {"path": "a.txt"})

    assert prepared.error is None
    assert prepared.name == "echo_path"
    assert prepared.arguments == {"path": "a.txt"}


def test_invalid_params_do_not_execute_tool() -> None:
    registry = ToolRegistry()
    registry.register(EchoPathTool())

    prepared = registry.prepare_call("echo_path", {})

    assert prepared.error is not None
    assert "missing required field 'path'" in prepared.error
```

- [ ] **Step 2: Run tests and confirm missing modules**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tool_protocol_v2.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.tools.context'
```

- [ ] **Step 3: Add structured tool result model**

Create `agent/tools/results.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ToolArtifact:
    path: str
    kind: str = "text"
    bytes: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult:
    model_content: str
    display_summary: str = ""
    raw_content: str | None = None
    artifacts: list[ToolArtifact] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    is_error: bool = False

    @classmethod
    def from_text(cls, text: str, *, is_error: bool = False) -> "ToolResult":
        summary = text if len(text) <= 500 else f"{text[:500]}\n...[summary truncated]"
        return cls(
            model_content=text,
            display_summary=summary,
            raw_content=text,
            is_error=is_error,
        )
```

- [ ] **Step 4: Add tool execution context**

Create `agent/tools/context.py`:

```python
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ToolEventEmitter = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class ToolExecutionContext:
    root: Path
    turn_id: str | None = None
    parent_call_id: str | None = None
    emit: ToolEventEmitter | None = None
    loop: Any | None = None
    abort_signal: Any | None = None
    non_interactive: bool = False
```

- [ ] **Step 5: Add protocol adapter and prepared call**

Create `agent/tools/protocol.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .context import ToolExecutionContext
from .results import ToolResult


@dataclass(frozen=True)
class PreparedToolCall:
    name: str
    arguments: dict[str, Any]
    tool: Any | None = None
    error: str | None = None


class ToolV2(Protocol):
    name: str
    description: str
    parameters: dict

    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        raise NotImplementedError

    def is_concurrency_safe(self, arguments: dict[str, Any]) -> bool:
        raise NotImplementedError

    def validate_input(self, arguments: dict[str, Any], context: ToolExecutionContext) -> str | None:
        raise NotImplementedError

    def check_permissions(self, arguments: dict[str, Any], context: ToolExecutionContext) -> Any:
        raise NotImplementedError

    def map_result(self, result: Any, context: ToolExecutionContext) -> ToolResult:
        raise NotImplementedError

    def execute_v2(self, arguments: dict[str, Any], context: ToolExecutionContext) -> ToolResult:
        raise NotImplementedError


class ToolAdapter:
    def __init__(self, tool: Any) -> None:
        self.tool = tool

    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        method = getattr(self.tool, "is_read_only", None)
        if callable(method):
            return bool(method(arguments))
        return bool(getattr(self.tool, "read_only", False))

    def is_concurrency_safe(self, arguments: dict[str, Any]) -> bool:
        method = getattr(self.tool, "is_concurrency_safe", None)
        if callable(method):
            return bool(method(arguments))
        return bool(getattr(self.tool, "concurrency_safe", False))

    def execute_sync(self, arguments: dict[str, Any], context: ToolExecutionContext) -> ToolResult:
        validate_input = getattr(self.tool, "validate_input", None)
        if callable(validate_input):
            validation_error = validate_input(arguments, context)
            if validation_error:
                return ToolResult.from_text(f"Error: {validation_error}", is_error=True)
        result = self.tool.execute(**arguments)
        map_result = getattr(self.tool, "map_result", None)
        if callable(map_result):
            mapped = map_result(result, context)
            if isinstance(mapped, ToolResult):
                return mapped
        if isinstance(result, ToolResult):
            return result
        return ToolResult.from_text(str(result), is_error=str(result).startswith("Error"))
```

- [ ] **Step 6: Add default v2 traits to base Tool**

Modify `agent/tools/base.py` inside `class Tool`:

```python
    def is_read_only(self, arguments: dict[str, Any]) -> bool:
        return bool(self.read_only)

    def is_concurrency_safe(self, arguments: dict[str, Any]) -> bool:
        return bool(self.concurrency_safe)

    def is_destructive(self, arguments: dict[str, Any]) -> bool:
        return not self.is_read_only(arguments)

    def validate_input(self, arguments: dict[str, Any], context: Any = None) -> str | None:
        return None

    def get_path(self, arguments: dict[str, Any]) -> str | None:
        value = arguments.get("path") if isinstance(arguments, dict) else None
        return str(value) if value else None
```

- [ ] **Step 7: Make registry prepare calls structured while keeping execute compatible**

Modify `agent/tools/registry.py` import:

```python
from .protocol import PreparedToolCall
from .results import ToolResult
```

Replace `prepare_call()` return values with:

```python
    def prepare_call(self, name: str, params: Any) -> PreparedToolCall:
        if not isinstance(params, dict):
            return PreparedToolCall(
                name=name,
                arguments={},
                error=f"Error: tool '{name}' received non-object params: {type(params).__name__}",
            )
        tool = self._tools.get(name)
        if tool is None:
            return PreparedToolCall(
                name=name,
                arguments=params,
                error=f"Error: Unknown tool '{name}'. Available: {', '.join(self.names())}",
            )
        try:
            cast = tool.cast_params(params)
            tool.validate_params(cast)
        except (ValueError, TypeError) as exc:
            return PreparedToolCall(
                name=name,
                arguments=params,
                tool=tool,
                error=f"Error: invalid params for '{name}': {exc}",
            )
        return PreparedToolCall(name=name, arguments=cast, tool=tool, error=None)
```

Update `execute()` to use `prepared = self.prepare_call(...)`. Preserve the current string return contract:

```python
        prepared = self.prepare_call(name, params)
        if prepared.error:
            return f"{prepared.error}\n{self._HINT}"
        tool = prepared.tool
        cast = prepared.arguments
```

Add `execute_result()` for the structured path, and keep `execute()` as the legacy string adapter:

```python
    def execute_result(...) -> ToolResult:
        ...

    def execute(...) -> str:
        return self.execute_result(...).model_content
```

- [ ] **Step 8: Run protocol tests plus existing tool tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tool_protocol_v2.py tests/unit/test_filesystem.py tests/unit/test_shell.py -q
```

Expected: all tests pass.

- [ ] **Step 9: Commit Tool Protocol v2 adapter**

Run:

```bash
git add agent/tools/base.py agent/tools/context.py agent/tools/protocol.py agent/tools/registry.py agent/tools/results.py tests/unit/test_tool_protocol_v2.py
git commit -m "feat: add tool protocol v2 adapter"
```

Expected: commit succeeds.

## Phase 3: Tool Execution Engine

### Task 4: Move Tool Batch Execution Out of Runner

**Files:**
- Create: `agent/tools/execution.py`
- Create: `tests/unit/test_tool_execution_engine.py`
- Modify: `agent/runner.py`
- Modify: `agent/runtime/events.py`

- [ ] **Step 1: Write failing tests for execution ordering**

Create `tests/unit/test_tool_execution_engine.py`:

```python
from dataclasses import dataclass
from typing import Any

import pytest

from agent.providers.base import ToolCallRequest
from agent.tools.base import Tool, tool_parameters
from agent.tools.execution import ToolExecutionEngine
from agent.tools.registry import ToolRegistry


EVENTS: list[dict[str, Any]] = []


@tool_parameters({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]})
class ReadOnlyEcho(Tool):
    name = "read_echo"
    description = "read echo"
    read_only = True

    def execute(self, value: str) -> str:
        return f"read:{value}"


@tool_parameters({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]})
class WriteEcho(Tool):
    name = "write_echo"
    description = "write echo"
    exclusive = True

    def execute(self, value: str) -> str:
        return f"write:{value}"


async def collect(event: dict[str, Any]) -> None:
    EVENTS.append(event)


@pytest.mark.asyncio
async def test_engine_returns_tool_messages_in_original_order() -> None:
    EVENTS.clear()
    registry = ToolRegistry()
    registry.register(ReadOnlyEcho())
    registry.register(WriteEcho())
    engine = ToolExecutionEngine(registry)
    calls = [
        ToolCallRequest(id="1", name="read_echo", arguments={"value": "a"}),
        ToolCallRequest(id="2", name="write_echo", arguments={"value": "b"}),
        ToolCallRequest(id="3", name="read_echo", arguments={"value": "c"}),
    ]

    messages = await engine.run_batch(calls, emit=collect)

    assert [message["tool_call_id"] for message in messages] == ["1", "2", "3"]
    assert [message["content"] for message in messages] == ["read:a", "write:b", "read:c"]
    assert [event["event"] for event in EVENTS if event["event"].startswith("tool_run_")] == [
        "tool_run_queued",
        "tool_run_queued",
        "tool_run_queued",
        "tool_run_started",
        "tool_run_completed",
        "tool_run_started",
        "tool_run_completed",
        "tool_run_started",
        "tool_run_completed",
    ]
```

- [ ] **Step 2: Run tests and confirm missing engine**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tool_execution_engine.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.tools.execution'
```

- [ ] **Step 3: Add runtime event helpers**

Modify `agent/runtime/events.py`:

```python
def tool_run_queued(*, id: str, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    return runtime_event("tool_run_queued", id=id, name=name, arguments=arguments or {})


def tool_run_started(*, id: str, name: str) -> dict[str, Any]:
    return runtime_event("tool_run_started", id=id, name=name)


def tool_run_completed(*, id: str, name: str, summary: str) -> dict[str, Any]:
    return runtime_event("tool_run_completed", id=id, name=name, summary=summary)


def tool_run_failed(*, id: str, name: str, message: str) -> dict[str, Any]:
    return runtime_event("tool_run_failed", id=id, name=name, message=message)


def tool_run_cancelled(*, id: str, name: str, reason: str) -> dict[str, Any]:
    return runtime_event("tool_run_cancelled", id=id, name=name, reason=reason)
```

- [ ] **Step 4: Add execution engine**

Create `agent/tools/execution.py`:

```python
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from loguru import logger

from ..providers import ToolCallRequest
from ..runtime import events as runtime_events
from .registry import ToolRegistry

StreamEmitter = Callable[[dict[str, Any]], Awaitable[None]]
ToolRunStatus = Literal["queued", "executing", "completed", "failed", "cancelled"]


@dataclass
class ToolRunState:
    id: str
    name: str
    arguments: dict[str, Any]
    status: ToolRunStatus = "queued"
    concurrency_safe: bool = False
    result: str | None = None
    error: str | None = None


class ToolExecutionEngine:
    def __init__(self, registry: ToolRegistry) -> None:
        self.registry = registry

    async def run_batch(
        self,
        tool_calls: list[ToolCallRequest],
        *,
        emit: StreamEmitter | None = None,
        run_one=None,
    ) -> list[dict[str, Any]]:
        states = [self._state_for_call(call) for call in tool_calls]
        if emit:
            for state in states:
                await emit(runtime_events.tool_run_queued(id=state.id, name=state.name, arguments=state.arguments))
        results_by_id: dict[str, str] = {}
        index = 0
        while index < len(tool_calls):
            state = states[index]
            if state.concurrency_safe:
                group_calls: list[ToolCallRequest] = []
                group_states: list[ToolRunState] = []
                while index < len(tool_calls) and states[index].concurrency_safe:
                    group_calls.append(tool_calls[index])
                    group_states.append(states[index])
                    index += 1
                gathered = await asyncio.gather(
                    *[self._run_state(call, item, emit=emit, run_one=run_one) for call, item in zip(group_calls, group_states, strict=True)],
                    return_exceptions=True,
                )
                for call, item, raw in zip(group_calls, group_states, gathered, strict=True):
                    if isinstance(raw, Exception):
                        content = f"Error: {raw}"
                        item.status = "failed"
                        item.error = str(raw)
                        results_by_id[call.id] = content
                        if emit:
                            await emit(runtime_events.tool_run_failed(id=call.id, name=call.name, message=str(raw)))
                    else:
                        results_by_id[call.id] = raw
                continue
            results_by_id[tool_calls[index].id] = await self._run_state(tool_calls[index], state, emit=emit, run_one=run_one)
            index += 1
        return [
            {
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": results_by_id.get(call.id, ""),
            }
            for call in tool_calls
        ]

    def _state_for_call(self, call: ToolCallRequest) -> ToolRunState:
        tool = self.registry.get(call.name)
        concurrency_safe = bool(tool is not None and tool.is_concurrency_safe(call.arguments))
        return ToolRunState(
            id=call.id,
            name=call.name,
            arguments=call.arguments,
            concurrency_safe=concurrency_safe,
        )

    async def _run_state(
        self,
        call: ToolCallRequest,
        state: ToolRunState,
        *,
        emit: StreamEmitter | None,
        run_one,
    ) -> str:
        state.status = "executing"
        if emit:
            await emit(runtime_events.tool_run_started(id=state.id, name=state.name))
        try:
            if run_one is None:
                content = await asyncio.to_thread(self.registry.execute, call.name, call.arguments)
            else:
                content = await run_one(call)
        except Exception as exc:
            logger.exception(f"Tool execution failed: {call.name}")
            state.status = "failed"
            state.error = str(exc)
            if emit:
                await emit(runtime_events.tool_run_failed(id=state.id, name=state.name, message=str(exc)))
            return f"Error: {exc}"
        state.status = "completed"
        state.result = content
        if emit and not str(content).startswith("Error:"):
            await emit(runtime_events.tool_run_completed(id=state.id, name=state.name, summary=str(content)))
        return str(content)
```

- [ ] **Step 5: Wire runner to engine with the current `_run_tool`**

Modify `agent/runner.py` imports:

```python
from .tools.execution import ToolExecutionEngine
```

Add to `__init__` parameters:

```python
        tool_execution_engine: ToolExecutionEngine | None = None,
```

Add inside `__init__`:

```python
        self.tool_execution_engine = tool_execution_engine or ToolExecutionEngine(registry)
```

Replace `_execute_tool_calls()` body with a compatibility wrapper:

```python
        results_by_id: dict[str, str] = {}

        async def run_one(call: ToolCallRequest) -> str:
            await self._emit_tool_call(call, emit)
            content = await self._run_tool(call, emit, clarification=clarification)
            results_by_id[call.id] = content
            self._maybe_pause_for_control(content, tool_calls, results_by_id)
            if not content.startswith("Error:"):
                await self._emit_tool_result(call, content, emit)
            return content

        return await self.tool_execution_engine.run_batch(tool_calls, emit=emit, run_one=run_one)
```

Keep `_run_tool()` unchanged in this task.

- [ ] **Step 6: Run focused engine and runner tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tool_execution_engine.py tests/unit/test_runner_behavior_contract.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit execution engine**

Run:

```bash
git add agent/tools/execution.py agent/runtime/events.py agent/runner.py tests/unit/test_tool_execution_engine.py
git commit -m "refactor: add tool execution engine"
```

Expected: commit succeeds.

## Phase 4: Permission Pipeline v2

### Task 5: Introduce `allow|ask|deny` Permission Behavior Without Breaking Ask Cards

**Files:**
- Modify: `agent/permissions/models.py`
- Create: `agent/permissions/pipeline.py`
- Create: `agent/permissions/resolvers.py`
- Modify: `agent/permissions/manager.py`
- Create: `tests/unit/test_permission_pipeline_v2.py`

- [ ] **Step 1: Write tests for behavior-based permission decisions**

Create `tests/unit/test_permission_pipeline_v2.py`:

```python
from agent.permissions.models import PermissionBehavior, PermissionDecision
from agent.permissions.pipeline import PermissionPipeline


def test_behavior_ask_keeps_requires_approval_compatibility() -> None:
    decision = PermissionDecision.ask(tool_name="run_command", reason="high impact", arguments={"command": "git push"})

    assert decision.behavior == PermissionBehavior.ASK.value
    assert decision.requires_approval is True
    assert decision.allowed is False


def test_pipeline_denies_plan_write_tool() -> None:
    pipeline = PermissionPipeline()

    decision = pipeline.assess("write_file", {"path": "a.txt"}, mode="plan", registry=None)

    assert decision.behavior == PermissionBehavior.DENY.value
    assert "Plan mode" in decision.reason


def test_pipeline_allows_read_tool_in_plan_mode(fake_registry) -> None:
    pipeline = PermissionPipeline()

    decision = pipeline.assess("read_file", {"path": "README.md"}, mode="plan", registry=fake_registry(read_only=True))

    assert decision.behavior == PermissionBehavior.ALLOW.value
```

In the same file, define `fake_registry`:

```python
import pytest


class FakeTool:
    def __init__(self, read_only: bool) -> None:
        self.read_only = read_only


class FakeRegistry:
    def __init__(self, read_only: bool) -> None:
        self.tool = FakeTool(read_only)

    def get(self, name: str):
        return self.tool


@pytest.fixture
def fake_registry():
    return lambda read_only: FakeRegistry(read_only)
```

- [ ] **Step 2: Run tests and confirm new names are missing**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_permission_pipeline_v2.py -q
```

Expected:

```text
ImportError
```

- [ ] **Step 3: Extend permission models compatibly**

Modify `agent/permissions/models.py`:

```python
class PermissionBehavior(StrEnum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"
```

Add fields to `PermissionDecision`:

```python
    behavior: str = PermissionBehavior.ALLOW.value
    updated_arguments: dict[str, Any] | None = None
    content_blocks: list[dict[str, Any]] | None = None
```

Update constructors:

```python
    @classmethod
    def allow(cls, *, tool_name: str, arguments: dict[str, Any] | None = None) -> PermissionDecision:
        return cls(allowed=True, behavior=PermissionBehavior.ALLOW.value, tool_name=tool_name, arguments=arguments or {})

    @classmethod
    def deny(cls, *, tool_name: str, reason: str, arguments: dict[str, Any] | None = None) -> PermissionDecision:
        return cls(
            allowed=False,
            behavior=PermissionBehavior.DENY.value,
            risk=RiskLevel.HIGH.value,
            reason=reason,
            tool_name=tool_name,
            arguments=arguments or {},
        )

    @classmethod
    def ask(
        cls,
        *,
        tool_name: str,
        reason: str,
        arguments: dict[str, Any] | None = None,
        risk: str = RiskLevel.HIGH.value,
    ) -> PermissionDecision:
        return cls(
            allowed=False,
            requires_approval=True,
            behavior=PermissionBehavior.ASK.value,
            risk=risk,
            reason=reason,
            tool_name=tool_name,
            arguments=arguments or {},
        )
```

Keep `approval()` as a compatibility alias:

```python
        return cls.ask(tool_name=tool_name, reason=reason, arguments=arguments, risk=risk)
```

- [ ] **Step 4: Add pipeline wrapper around existing policy**

Create `agent/permissions/pipeline.py`:

```python
from __future__ import annotations

from typing import Any

from .models import PermissionDecision
from .policy import PermissionPolicy


class PermissionPipeline:
    def __init__(self, policy: PermissionPolicy | None = None) -> None:
        self.policy = policy or PermissionPolicy()

    def assess(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None,
        *,
        mode: str,
        registry=None,
        non_interactive: bool = False,
    ) -> PermissionDecision:
        args = arguments or {}
        tool = registry.get(tool_name) if registry is not None else None
        check_permissions = getattr(tool, "check_permissions", None)
        if callable(check_permissions):
            tool_decision = check_permissions(args)
            if isinstance(tool_decision, PermissionDecision) and not tool_decision.allowed:
                return tool_decision
        decision = self.policy.assess(tool_name, args, mode, registry=registry)
        if non_interactive and decision.requires_approval:
            return PermissionDecision.deny(
                tool_name=tool_name,
                arguments=args,
                reason=f"non-interactive permission resolver cannot ask: {decision.reason}",
            )
        return decision
```

Create `agent/permissions/resolvers.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

from .models import PermissionDecision


@dataclass(frozen=True)
class PermissionResolution:
    decision: PermissionDecision
    pause_result: str | None = None


class NonInteractivePermissionResolver:
    def resolve(self, decision: PermissionDecision) -> PermissionResolution:
        if decision.requires_approval:
            denied = PermissionDecision.deny(
                tool_name=decision.tool_name,
                arguments=decision.arguments or {},
                reason=f"permission requires user approval in a non-interactive context: {decision.reason}",
            )
            return PermissionResolution(decision=denied)
        return PermissionResolution(decision=decision)
```

- [ ] **Step 5: Switch manager to pipeline**

Modify `agent/permissions/manager.py` imports:

```python
from .pipeline import PermissionPipeline
```

In `__init__`, add:

```python
        self.pipeline = PermissionPipeline(self.policy)
```

Replace:

```python
        return self.policy.assess(tool_name, args, self.control_manager.mode, registry=registry)
```

with:

```python
        return self.pipeline.assess(tool_name, args, mode=self.control_manager.mode, registry=registry)
```

- [ ] **Step 6: Run permission tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_permission_pipeline_v2.py tests/unit/test_permissions.py tests/unit/test_control.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit permission pipeline**

Run:

```bash
git add agent/permissions tests/unit/test_permission_pipeline_v2.py
git commit -m "feat: add permission pipeline v2"
```

Expected: commit succeeds.

## Phase 5: Query State Transitions

### Task 6: Extract Transition Reasons and Pure Transition Helpers

**Files:**
- Create: `agent/query_state/__init__.py`
- Create: `agent/query_state/models.py`
- Create: `agent/query_state/transitions.py`
- Create: `tests/unit/test_query_state.py`
- Modify: `agent/runner.py`

- [ ] **Step 1: Write tests for transition helpers**

Create `tests/unit/test_query_state.py`:

```python
from agent.query_state.models import QueryState, TransitionReason
from agent.query_state.transitions import empty_response_retry, length_recovery, max_turns_reached


def test_empty_response_retry_adds_nudge_until_limit() -> None:
    state = QueryState(history=[], turn_count=1, empty_retries=0)

    transition = empty_response_retry(state, max_empty_retries=2)

    assert transition is not None
    assert transition.reason == TransitionReason.EMPTY_RESPONSE_RETRY.value
    assert transition.next_state.empty_retries == 1
    assert transition.next_state.history[-1]["role"] == "user"


def test_empty_response_retry_returns_none_after_limit() -> None:
    state = QueryState(history=[], turn_count=1, empty_retries=2)

    transition = empty_response_retry(state, max_empty_retries=2)

    assert transition is None


def test_length_recovery_appends_assistant_and_continue_message() -> None:
    state = QueryState(history=[], turn_count=1, length_retries=0)

    transition = length_recovery(state, reply="abc", turn_id="turn_1", max_length_recoveries=3)

    assert transition is not None
    assert transition.reason == TransitionReason.LENGTH_RECOVERY.value
    assert transition.next_state.length_retries == 1
    assert transition.next_state.history[0] == {"role": "assistant", "content": "abc", "turn_id": "turn_1"}


def test_max_turns_reached_returns_final_message() -> None:
    state = QueryState(history=[], turn_count=12)

    transition = max_turns_reached(state, max_turns=12, turn_id="turn_1")

    assert transition is not None
    assert transition.reason == TransitionReason.MAX_TURNS_REACHED.value
    assert "达到 max_turns=12" in transition.final_reply
```

- [ ] **Step 2: Run tests and confirm missing query_state package**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_query_state.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.query_state'
```

- [ ] **Step 3: Add query state models**

Create `agent/query_state/models.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class TransitionReason(StrEnum):
    EMPTY_RESPONSE_RETRY = "empty_response_retry"
    LENGTH_RECOVERY = "length_recovery"
    MAX_TURNS_REACHED = "max_turns_reached"
    NEXT_TURN = "next_turn"
    PLAN_PAUSE = "plan_pause"
    ASK_PAUSE = "ask_pause"
    TOOL_FOLLOWUP = "tool_followup"


@dataclass(frozen=True)
class QueryState:
    history: list[dict[str, Any]] = field(default_factory=list)
    turn_count: int = 0
    transition: str | None = None
    empty_retries: int = 0
    length_retries: int = 0
    paused: bool = False


@dataclass(frozen=True)
class QueryTransition:
    reason: str
    next_state: QueryState
    emit: list[dict[str, Any]] = field(default_factory=list)
    final_reply: str | None = None
```

Create `agent/query_state/__init__.py`:

```python
from .models import QueryState, QueryTransition, TransitionReason

__all__ = ["QueryState", "QueryTransition", "TransitionReason"]
```

- [ ] **Step 4: Add pure transition helpers**

Create `agent/query_state/transitions.py`:

```python
from __future__ import annotations

from .models import QueryState, QueryTransition, TransitionReason


def empty_response_retry(state: QueryState, *, max_empty_retries: int) -> QueryTransition | None:
    if state.empty_retries >= max_empty_retries:
        return None
    history = [
        *state.history,
        {"role": "user", "content": "（上一轮无任何输出，请继续推进或给出最终答复）"},
    ]
    next_state = QueryState(
        history=history,
        turn_count=state.turn_count,
        transition=TransitionReason.EMPTY_RESPONSE_RETRY.value,
        empty_retries=state.empty_retries + 1,
        length_retries=state.length_retries,
    )
    return QueryTransition(
        reason=TransitionReason.EMPTY_RESPONSE_RETRY.value,
        next_state=next_state,
        emit=[{
            "event": "tool_error",
            "name": "_empty_response",
            "message": f"empty response, retry {next_state.empty_retries}/{max_empty_retries}",
        }],
    )


def length_recovery(
    state: QueryState,
    *,
    reply: str,
    turn_id: str | None,
    max_length_recoveries: int,
) -> QueryTransition | None:
    if state.length_retries >= max_length_recoveries:
        return None
    history = list(state.history)
    if reply:
        message = {"role": "assistant", "content": reply}
        if turn_id:
            message["turn_id"] = turn_id
        history.append(message)
    history.append({
        "role": "user",
        "content": "（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）",
    })
    next_state = QueryState(
        history=history,
        turn_count=state.turn_count,
        transition=TransitionReason.LENGTH_RECOVERY.value,
        empty_retries=state.empty_retries,
        length_retries=state.length_retries + 1,
    )
    return QueryTransition(
        reason=TransitionReason.LENGTH_RECOVERY.value,
        next_state=next_state,
        emit=[{
            "event": "tool_error",
            "name": "_length_truncation",
            "message": f"truncated, continuing {next_state.length_retries}/{max_length_recoveries}",
        }],
    )


def max_turns_reached(state: QueryState, *, max_turns: int | None, turn_id: str | None) -> QueryTransition | None:
    if max_turns is None or state.turn_count < max_turns:
        return None
    reply = f"（达到 max_turns={max_turns} 上限，未办妥；history 中已有部分进展）"
    message = {"role": "assistant", "content": reply}
    if turn_id:
        message["turn_id"] = turn_id
    next_state = QueryState(
        history=[*state.history, message],
        turn_count=state.turn_count,
        transition=TransitionReason.MAX_TURNS_REACHED.value,
        empty_retries=state.empty_retries,
        length_retries=state.length_retries,
    )
    return QueryTransition(
        reason=TransitionReason.MAX_TURNS_REACHED.value,
        next_state=next_state,
        final_reply=reply,
    )
```

- [ ] **Step 5: Run query state tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_query_state.py -q
```

Expected:

```text
4 passed
```

- [ ] **Step 6: Integrate helpers into runner one branch at a time**

Modify only the empty response branch first:

```python
from .query_state.models import QueryState
from .query_state.transitions import empty_response_retry
```

Inside the empty response branch in `step_async()`, replace the inline retry update with:

```python
                state = QueryState(
                    history=history,
                    turn_count=turns,
                    empty_retries=empty_retries,
                    length_retries=length_retries,
                )
                transition = empty_response_retry(state, max_empty_retries=_MAX_EMPTY_RETRIES)
                if transition is not None:
                    empty_retries = transition.next_state.empty_retries
                    history[:] = transition.next_state.history
                    if emit:
                        for event in transition.emit:
                            await emit(event)
                    continue
```

Leave length recovery and max turns in runner until this branch is verified.

- [ ] **Step 7: Run runner and query state tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_query_state.py tests/unit/test_runner_behavior_contract.py -q
```

Expected: all tests pass.

- [ ] **Step 8: Commit query state foundation**

Run:

```bash
git add agent/query_state agent/runner.py tests/unit/test_query_state.py
git commit -m "refactor: add query transition helpers"
```

Expected: commit succeeds.

## Phase 5.5: Project Execution and Plan Runtime v2

Claude Code's practical project-writing ability is not just the while loop. The important workflow is:

```text
enter plan mode
-> read-only codebase exploration
-> write a concrete plan
-> present plan for approval
-> exit plan mode only after approval
-> execute plan step by step
-> keep todos/plan state current
-> run verification commands
-> diagnose failures and continue
-> finish only with verification evidence
```

Claude Code source anchors for this phase:

- `/Users/anhuike/Documents/workspace/claude-code-source-code/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`
- `/Users/anhuike/Documents/workspace/claude-code-source-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`
- `/Users/anhuike/Documents/workspace/claude-code-source-code/src/tools/TodoWriteTool/TodoWriteTool.ts`
- `/Users/anhuike/Documents/workspace/claude-code-source-code/src/commands/plan/plan.tsx`
- `/Users/anhuike/Documents/workspace/claude-code-source-code/src/commands/init-verifiers.ts`

Emperor already has `ask_user`, `propose_plan`, Plan mode, Ask/Plan pause, and `update_todos`. The missing layer is a durable project-execution runtime that turns a plan from markdown into an executable state object with steps, files, commands, verification evidence, and recovery.

### Task 6A: Durable Structured Plan Store

**Files:**
- Create: `agent/plans/__init__.py`
- Create: `agent/plans/models.py`
- Create: `agent/plans/store.py`
- Create: `tests/unit/test_plan_store.py`
- Modify: `agent/control/models.py`

- [ ] **Step 1: Write failing tests for structured plan persistence**

Create `tests/unit/test_plan_store.py`:

```python
from agent.plans.models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus
from agent.plans.store import PlanStore


def test_plan_store_round_trips_structured_plan(tmp_path) -> None:
    store = PlanStore(tmp_path)
    record = PlanRecord(
        id="plan_1",
        title="Upgrade runner",
        summary="Extract context pipeline",
        status=PlanStatus.DRAFT.value,
        created_at=100.0,
        updated_at=100.0,
        source_interaction_id="plan_interaction_1",
        steps=[
            PlanStep(
                id="step_1",
                title="Add tests",
                status=PlanStepStatus.PENDING.value,
                files=["tests/unit/test_context_pipeline.py"],
                commands=[".venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q"],
                acceptance=["test_context_pipeline.py passes"],
            )
        ],
    )

    store.save(record)

    loaded = store.get("plan_1")
    assert loaded == record
    assert store.latest().id == "plan_1"


def test_plan_store_backs_up_corrupt_index(tmp_path) -> None:
    store = PlanStore(tmp_path)
    store.index_file.write_text("{bad json", encoding="utf-8")

    assert store.list() == []
    assert list(store.plan_dir.glob("index.json.corrupt-*"))
```

- [ ] **Step 2: Run test and confirm package is missing**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_store.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.plans'
```

- [ ] **Step 3: Add plan models**

Create `agent/plans/models.py`:

```python
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class PlanStatus(StrEnum):
    DRAFT = "draft"
    WAITING_APPROVAL = "waiting_approval"
    APPROVED = "approved"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PlanStepStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    DONE = "done"
    FAILED = "failed"
    BLOCKED = "blocked"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class PlanStep:
    id: str
    title: str
    status: str = PlanStepStatus.PENDING.value
    description: str = ""
    files: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    acceptance: list[str] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    risk: str = "medium"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "PlanStep":
        return cls(
            id=str(raw["id"]),
            title=str(raw["title"]),
            status=str(raw.get("status") or PlanStepStatus.PENDING.value),
            description=str(raw.get("description") or ""),
            files=[str(item) for item in raw.get("files") or []],
            commands=[str(item) for item in raw.get("commands") or []],
            acceptance=[str(item) for item in raw.get("acceptance") or []],
            evidence=[item for item in raw.get("evidence") or [] if isinstance(item, dict)],
            risk=str(raw.get("risk") or "medium"),
        )


@dataclass(frozen=True)
class PlanRecord:
    id: str
    title: str
    summary: str
    status: str
    created_at: float
    updated_at: float
    source_interaction_id: str | None = None
    approved_at: float | None = None
    completed_at: float | None = None
    plan_markdown: str = ""
    assumptions: list[str] = field(default_factory=list)
    steps: list[PlanStep] = field(default_factory=list)
    verification: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["steps"] = [step.to_dict() for step in self.steps]
        return payload

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "PlanRecord":
        return cls(
            id=str(raw["id"]),
            title=str(raw["title"]),
            summary=str(raw["summary"]),
            status=str(raw["status"]),
            created_at=float(raw["created_at"]),
            updated_at=float(raw["updated_at"]),
            source_interaction_id=raw.get("source_interaction_id"),
            approved_at=raw.get("approved_at"),
            completed_at=raw.get("completed_at"),
            plan_markdown=str(raw.get("plan_markdown") or ""),
            assumptions=[str(item) for item in raw.get("assumptions") or []],
            steps=[PlanStep.from_dict(item) for item in raw.get("steps") or [] if isinstance(item, dict)],
            verification=[item for item in raw.get("verification") or [] if isinstance(item, dict)],
            metadata=dict(raw.get("metadata") or {}),
        )
```

Create `agent/plans/__init__.py`:

```python
from .models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus
from .store import PlanStore

__all__ = ["PlanRecord", "PlanStatus", "PlanStep", "PlanStepStatus", "PlanStore"]
```

- [ ] **Step 4: Add durable plan store**

Create `agent/plans/store.py`:

```python
from __future__ import annotations

import json
import time
from pathlib import Path
from uuid import uuid4

from .models import PlanRecord


class PlanStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.plan_dir = self.root / "memory" / "plans"
        self.index_file = self.plan_dir / "index.json"
        self.plan_dir.mkdir(parents=True, exist_ok=True)
        if not self.index_file.exists():
            self._write({})

    def list(self) -> list[PlanRecord]:
        data = self._read()
        return [PlanRecord.from_dict(item) for item in data.values()]

    def get(self, plan_id: str) -> PlanRecord | None:
        payload = self._read().get(plan_id)
        return PlanRecord.from_dict(payload) if isinstance(payload, dict) else None

    def latest(self) -> PlanRecord | None:
        plans = self.list()
        return max(plans, key=lambda item: item.updated_at) if plans else None

    def save(self, record: PlanRecord) -> None:
        data = self._read()
        data[record.id] = record.to_dict()
        self._write(data)

    def _read(self) -> dict:
        try:
            raw = json.loads(self.index_file.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            corrupt = self.index_file.with_name(f"index.json.corrupt-{int(time.time())}")
            self.index_file.replace(corrupt)
            self._write({})
            return {}
        return raw if isinstance(raw, dict) else {}

    def _write(self, data: dict) -> None:
        tmp = self.index_file.with_name(f".{self.index_file.name}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.index_file)
```

- [ ] **Step 5: Add plan id reference to control interaction metadata**

Do not add a top-level field to `Interaction` yet. Store linkage in `Interaction.meta["plan_id"]` so old control state files remain compatible.

Add this assertion to `tests/unit/test_control.py` when `PlanStore` is wired in Task 6B:

```python
assert manager.payload()["pending"]["meta"]["plan_id"].startswith("plan_")
```

- [ ] **Step 6: Run plan store tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_store.py -q
```

Expected:

```text
2 passed
```

- [ ] **Step 7: Commit plan store**

Run:

```bash
git add agent/plans tests/unit/test_plan_store.py
git commit -m "feat: add durable plan store"
```

Expected: commit succeeds.

### Task 6B: Upgrade `propose_plan` From Markdown Preview to Structured Plan Draft

**Files:**
- Modify: `agent/control/manager.py`
- Modify: `agent/control/tools.py`
- Modify: `agent/loop.py`
- Create: `tests/unit/test_plan_runtime.py`

- [ ] **Step 1: Write failing tests for structured `propose_plan`**

Create `tests/unit/test_plan_runtime.py`:

```python
from pathlib import Path

from agent.control import ControlManager, ProposePlanTool
from agent.plans.store import PlanStore


def test_propose_plan_persists_structured_steps(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.plan_store = PlanStore(tmp_path)
    manager.set_mode("plan")
    tool = ProposePlanTool(manager)

    result = tool.execute(
        title="Runner upgrade",
        summary="Extract context pipeline",
        plan_markdown="# Plan\n\n- Add context pipeline",
        steps=[
            {
                "id": "step_1",
                "title": "Add failing tests",
                "files": ["tests/unit/test_context_pipeline.py"],
                "commands": [".venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q"],
                "acceptance": ["context pipeline tests pass"],
            }
        ],
        assumptions=["keep provider behavior unchanged"],
        risk_level="medium",
    )

    assert result.startswith("__CONTROL_PAUSE__:")
    pending = manager.payload()["pending"]
    plan_id = pending["meta"]["plan_id"]
    saved = manager.plan_store.get(plan_id)
    assert saved is not None
    assert saved.steps[0].id == "step_1"
    assert saved.steps[0].commands == [".venv/bin/python -m pytest tests/unit/test_context_pipeline.py -q"]
```

- [ ] **Step 2: Run test and confirm current schema rejects `steps`**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_runtime.py::test_propose_plan_persists_structured_steps -q
```

Expected: failure because `ProposePlanTool.execute()` does not accept `steps`.

- [ ] **Step 3: Add `steps` schema to `ProposePlanTool`**

Modify `agent/control/tools.py` imports:

```python
from ..tools.schema import ArraySchema, ObjectSchema, StringSchema
```

Inside `ProposePlanTool.parameters`, add a `step` object:

```python
        step = ObjectSchema(
            "计划步骤",
            properties={
                "id": StringSchema("稳定步骤 id，如 step_1", min_length=1, max_length=64),
                "title": StringSchema("步骤标题", min_length=1, max_length=160),
                "description": StringSchema("步骤说明", max_length=1000, nullable=True),
                "files": ArraySchema("涉及文件", items=StringSchema("文件路径", max_length=240), max_items=30),
                "commands": ArraySchema("验证或执行命令", items=StringSchema("命令", max_length=300), max_items=12),
                "acceptance": ArraySchema("验收条件", items=StringSchema("验收条件", max_length=300), max_items=12),
                "risk": StringSchema("风险级别", enum=["low", "medium", "high"], nullable=True),
            },
            required=["id", "title"],
        )
```

Add to properties:

```python
                "steps": ArraySchema(
                    "结构化执行步骤。每一步必须可验证；复杂项目至少 2 步。",
                    items=step,
                    max_items=30,
                    nullable=True,
                ).to_json_schema(),
```

Update `execute()` signature:

```python
        steps: list[dict[str, Any]] | None = None,
```

Pass into manager:

```python
            steps=steps or [],
```

- [ ] **Step 4: Persist structured draft in `ControlManager.create_plan`**

Modify `agent/control/manager.py` imports:

```python
from uuid import uuid4
from ..plans import PlanRecord, PlanStatus, PlanStep, PlanStore
```

Add optional store in `__init__`:

```python
        self.plan_store = PlanStore(root)
```

Update `create_plan()` signature:

```python
        steps: list[dict[str, Any]] | None = None,
```

Before `interaction = Interaction.plan(...)`, build a `PlanRecord`:

```python
        plan_id = f"plan_{uuid4().hex[:12]}"
        now = now_ts()
        structured_steps = [
            PlanStep(
                id=str(item.get("id") or f"step_{index}"),
                title=str(item.get("title") or "").strip()[:160],
                description=str(item.get("description") or "").strip(),
                files=[str(path) for path in item.get("files") or []],
                commands=[str(command) for command in item.get("commands") or []],
                acceptance=[str(rule) for rule in item.get("acceptance") or []],
                risk=str(item.get("risk") or "medium"),
            )
            for index, item in enumerate(steps or [], start=1)
            if isinstance(item, dict) and str(item.get("title") or "").strip()
        ]
        self.plan_store.save(PlanRecord(
            id=plan_id,
            title=title,
            summary=summary,
            status=PlanStatus.WAITING_APPROVAL.value,
            created_at=now,
            updated_at=now,
            source_interaction_id=None,
            plan_markdown=plan_markdown,
            assumptions=assumptions or [],
            steps=structured_steps,
            metadata={"risk_level": risk_level},
        ))
```

Pass metadata into `Interaction.plan()`:

```python
            meta={**(meta or {}), "plan_id": plan_id},
```

- [ ] **Step 5: Mark plan approved when user approves PlanCard**

Inside `ControlManager.approve()`, after `updated = interaction.touch(...)`, load the plan id:

```python
        plan_id = str(updated.meta.get("plan_id") or "")
        if plan_id:
            record = self.plan_store.get(plan_id)
            if record is not None:
                self.plan_store.save(PlanRecord.from_dict({
                    **record.to_dict(),
                    "status": PlanStatus.APPROVED.value,
                    "approved_at": now_ts(),
                    "updated_at": now_ts(),
                }))
```

- [ ] **Step 6: Run plan runtime and control tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_runtime.py tests/unit/test_control.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit structured plan drafts**

Run:

```bash
git add agent/control agent/plans tests/unit/test_plan_runtime.py
git commit -m "feat: persist structured plan drafts"
```

Expected: commit succeeds.

### Task 6C: Plan Step Execution State and Todo Synchronization

**Files:**
- Create: `agent/plans/execution.py`
- Modify: `agent/tools/todo.py`
- Modify: `agent/runner.py`
- Create: `tests/unit/test_plan_execution_state.py`

- [ ] **Step 1: Write tests for step state transitions**

Create `tests/unit/test_plan_execution_state.py`:

```python
from agent.plans.execution import PlanExecutionState
from agent.plans.models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus


def sample_plan() -> PlanRecord:
    return PlanRecord(
        id="plan_1",
        title="Build feature",
        summary="Two steps",
        status=PlanStatus.APPROVED.value,
        created_at=1.0,
        updated_at=1.0,
        steps=[
            PlanStep(id="step_1", title="Edit code"),
            PlanStep(id="step_2", title="Run tests"),
        ],
    )


def test_start_next_step_marks_single_active_step() -> None:
    state = PlanExecutionState(sample_plan())

    updated = state.start_next_step()

    assert updated.steps[0].status == PlanStepStatus.ACTIVE.value
    assert updated.steps[1].status == PlanStepStatus.PENDING.value


def test_complete_active_step_moves_to_next() -> None:
    state = PlanExecutionState(sample_plan())
    running = state.start_next_step()

    completed = PlanExecutionState(running).complete_step("step_1", evidence={"command": "pytest", "exit_code": 0})

    assert completed.steps[0].status == PlanStepStatus.DONE.value
    assert completed.steps[0].evidence == [{"command": "pytest", "exit_code": 0}]
    assert completed.steps[1].status == PlanStepStatus.PENDING.value
```

- [ ] **Step 2: Run tests and confirm missing execution module**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_execution_state.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.plans.execution'
```

- [ ] **Step 3: Add plan execution state helper**

Create `agent/plans/execution.py`:

```python
from __future__ import annotations

import time
from dataclasses import replace
from typing import Any

from .models import PlanRecord, PlanStatus, PlanStep, PlanStepStatus


class PlanExecutionState:
    def __init__(self, plan: PlanRecord) -> None:
        self.plan = plan

    def start_next_step(self) -> PlanRecord:
        if any(step.status == PlanStepStatus.ACTIVE.value for step in self.plan.steps):
            return self.plan
        steps: list[PlanStep] = []
        activated = False
        for step in self.plan.steps:
            if not activated and step.status == PlanStepStatus.PENDING.value:
                steps.append(replace(step, status=PlanStepStatus.ACTIVE.value))
                activated = True
            else:
                steps.append(step)
        return replace(
            self.plan,
            status=PlanStatus.EXECUTING.value,
            updated_at=time.time(),
            steps=steps,
        )

    def complete_step(self, step_id: str, *, evidence: dict[str, Any]) -> PlanRecord:
        steps = [
            replace(step, status=PlanStepStatus.DONE.value, evidence=[*step.evidence, evidence])
            if step.id == step_id
            else step
            for step in self.plan.steps
        ]
        status = PlanStatus.COMPLETED.value if all(step.status == PlanStepStatus.DONE.value for step in steps) else PlanStatus.EXECUTING.value
        return replace(
            self.plan,
            status=status,
            completed_at=time.time() if status == PlanStatus.COMPLETED.value else self.plan.completed_at,
            updated_at=time.time(),
            steps=steps,
        )

    def fail_step(self, step_id: str, *, evidence: dict[str, Any]) -> PlanRecord:
        steps = [
            replace(step, status=PlanStepStatus.FAILED.value, evidence=[*step.evidence, evidence])
            if step.id == step_id
            else step
            for step in self.plan.steps
        ]
        return replace(
            self.plan,
            status=PlanStatus.FAILED.value,
            updated_at=time.time(),
            steps=steps,
        )
```

- [ ] **Step 4: Add todo sync helper**

Modify `agent/tools/todo.py`. Add this method to `TodoStore`:

```python
    def sync_from_plan_steps(self, steps: list[dict]) -> str:
        todos = []
        status_map = {
            "pending": "pending",
            "active": "in_progress",
            "done": "completed",
            "failed": "pending",
            "blocked": "pending",
            "skipped": "completed",
        }
        for index, step in enumerate(steps, start=1):
            title = str(step.get("title") or "").strip()
            if not title:
                continue
            todos.append({
                "id": index,
                "content": title,
                "status": status_map.get(str(step.get("status") or "pending"), "pending"),
            })
        return self.update(todos)
```

- [ ] **Step 5: Add runner nudge for approved plan with no active step**

After plan approval, runner receives `[CONTROL:PLAN_APPROVED]`. Extend `ControlManager._approval_message()` to include:

```python
            "\n\n[PLAN_EXECUTION]\n"
            "- Convert the approved plan into todos before editing.\n"
            "- Keep exactly one plan step active while executing.\n"
            "- Run each step's verification commands before marking the step done.\n"
```

This is a prompt-level bridge until the structured `PlanExecutionState` is wired directly into runner state.

- [ ] **Step 6: Run plan execution tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_execution_state.py tests/unit/test_control.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit plan execution state**

Run:

```bash
git add agent/plans/execution.py agent/tools/todo.py agent/control/manager.py tests/unit/test_plan_execution_state.py
git commit -m "feat: add plan execution state"
```

Expected: commit succeeds.

### Task 6D: Verification Gate for Real Project Work

**Files:**
- Create: `agent/plans/verification.py`
- Modify: `agent/runtime/events.py`
- Create: `tests/unit/test_plan_verification.py`

- [ ] **Step 1: Write tests for verification result parsing**

Create `tests/unit/test_plan_verification.py`:

```python
from agent.plans.verification import VerificationCommand, VerificationResult


def test_verification_result_records_success() -> None:
    result = VerificationResult.from_completed(
        VerificationCommand(command=".venv/bin/python -m pytest tests/unit/test_plan_store.py -q"),
        exit_code=0,
        stdout="2 passed",
        stderr="",
    )

    assert result.passed is True
    assert result.summary == "2 passed"


def test_verification_result_records_failure() -> None:
    result = VerificationResult.from_completed(
        VerificationCommand(command="make check"),
        exit_code=2,
        stdout="",
        stderr="ruff failed",
    )

    assert result.passed is False
    assert result.summary == "ruff failed"
```

- [ ] **Step 2: Run tests and confirm missing module**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_verification.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.plans.verification'
```

- [ ] **Step 3: Add verification models**

Create `agent/plans/verification.py`:

```python
from __future__ import annotations

import time
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class VerificationCommand:
    command: str
    cwd: str | None = None
    timeout_seconds: int = 300

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class VerificationResult:
    command: str
    exit_code: int
    passed: bool
    summary: str
    stdout_tail: str
    stderr_tail: str
    checked_at: float

    @classmethod
    def from_completed(
        cls,
        command: VerificationCommand,
        *,
        exit_code: int,
        stdout: str,
        stderr: str,
    ) -> "VerificationResult":
        summary = (stdout or stderr or f"exit_code={exit_code}").strip().splitlines()[-1][:500]
        return cls(
            command=command.command,
            exit_code=exit_code,
            passed=exit_code == 0,
            summary=summary,
            stdout_tail=stdout[-4000:],
            stderr_tail=stderr[-4000:],
            checked_at=time.time(),
        )

    def to_dict(self) -> dict:
        return asdict(self)
```

- [ ] **Step 4: Add verification runtime events**

Modify `agent/runtime/events.py`:

```python
def plan_verification_start(*, plan_id: str, step_id: str, command: str) -> dict[str, Any]:
    return runtime_event("plan_verification_start", plan_id=plan_id, step_id=step_id, command=command)


def plan_verification_done(*, plan_id: str, step_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("plan_verification_done", plan_id=plan_id, step_id=step_id, result=result)
```

- [ ] **Step 5: Run verification tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_verification.py tests/unit/test_runtime_events.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit verification models**

Run:

```bash
git add agent/plans/verification.py agent/runtime/events.py tests/unit/test_plan_verification.py
git commit -m "feat: add plan verification records"
```

Expected: commit succeeds.

### Task 6E: Plan Runtime API and Frontend Projection

**Files:**
- Create: `agent/web/routes/plans.py`
- Modify: `agent/web/app.py`
- Modify: `agent/web/container.py`
- Modify: `desktop/src/renderer/src/types.ts`
- Create: `desktop/src/renderer/src/runtime/handlers/plans.ts`
- Create: `desktop/src/renderer/src/runtime/planProjection.test.ts`
- Modify: `desktop/src/renderer/src/composables/useRuntime.ts`

- [ ] **Step 1: Write frontend projection test for plan lifecycle**

Create `desktop/src/renderer/src/runtime/planProjection.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { applyPlanEvent, type PlanProjection } from './handlers/plans'

describe('plan projection', () => {
  it('updates step status and verification evidence', () => {
    let projection: PlanProjection = { plans: [] }
    projection = applyPlanEvent(projection, {
      event: 'plan_runtime_update',
      plan: {
        id: 'plan_1',
        title: 'Build feature',
        status: 'executing',
        steps: [{ id: 'step_1', title: 'Run tests', status: 'active' }],
      },
    })
    projection = applyPlanEvent(projection, {
      event: 'plan_verification_done',
      plan_id: 'plan_1',
      step_id: 'step_1',
      result: { command: 'pytest', passed: true, summary: '2 passed' },
    })

    expect(projection.plans[0]?.steps[0]?.status).toBe('active')
    expect(projection.plans[0]?.steps[0]?.evidence?.[0]?.summary).toBe('2 passed')
  })
})
```

- [ ] **Step 2: Run frontend test and confirm missing handler**

Run:

```bash
npm --prefix desktop run test -- planProjection
```

Expected: failure because `runtime/handlers/plans.ts` does not exist.

- [ ] **Step 3: Add backend plan route**

Create `agent/web/routes/plans.py`:

```python
from __future__ import annotations

from aiohttp import web


def setup(app: web.Application) -> None:
    app.router.add_get("/api/plans", list_plans)
    app.router.add_get("/api/plans/{plan_id}", get_plan)


async def list_plans(request: web.Request) -> web.Response:
    store = request.app["container"].plan_store
    return web.json_response({"plans": [item.to_dict() for item in store.list()]})


async def get_plan(request: web.Request) -> web.Response:
    store = request.app["container"].plan_store
    plan = store.get(request.match_info["plan_id"])
    if plan is None:
        raise web.HTTPNotFound(reason="plan not found")
    return web.json_response({"plan": plan.to_dict()})
```

Wire it in `agent/web/app.py` using the existing route setup pattern.

- [ ] **Step 4: Add frontend plan types**

Modify `desktop/src/renderer/src/types.ts`:

```typescript
export interface RuntimePlanStep {
  id: string
  title: string
  status: string
  description?: string
  files?: string[]
  commands?: string[]
  acceptance?: string[]
  evidence?: Array<Record<string, unknown>>
  risk?: string
}

export interface RuntimePlanRecord {
  id: string
  title: string
  summary?: string
  status: string
  steps: RuntimePlanStep[]
  planMarkdown?: string
  assumptions?: string[]
  verification?: Array<Record<string, unknown>>
}
```

Add event variants:

```typescript
  | { event: 'plan_runtime_update'; plan?: RuntimePlanRecord }
  | { event: 'plan_step_update'; plan_id?: string; step?: RuntimePlanStep }
  | { event: 'plan_verification_start'; plan_id?: string; step_id?: string; command?: string }
  | { event: 'plan_verification_done'; plan_id?: string; step_id?: string; result?: Record<string, unknown> }
```

- [ ] **Step 5: Add frontend plan projection handler**

Create `desktop/src/renderer/src/runtime/handlers/plans.ts`:

```typescript
import type { RuntimePlanRecord, RuntimePlanStep, WsEvent } from '../../types'

export interface PlanProjection {
  plans: RuntimePlanRecord[]
}

type PlanEvent = Extract<WsEvent, {
  event: 'plan_runtime_update' | 'plan_step_update' | 'plan_verification_start' | 'plan_verification_done'
}>

export function applyPlanEvent(projection: PlanProjection, event: PlanEvent): PlanProjection {
  if (event.event === 'plan_runtime_update') {
    if (!event.plan?.id) return projection
    const existing = projection.plans.findIndex((plan) => plan.id === event.plan?.id)
    const plans = [...projection.plans]
    if (existing >= 0) plans[existing] = { ...plans[existing], ...event.plan }
    else plans.push(event.plan)
    return { plans }
  }
  const planId = event.plan_id
  if (!planId) return projection
  return {
    plans: projection.plans.map((plan) => {
      if (plan.id !== planId) return plan
      if (event.event === 'plan_step_update' && event.step?.id) {
        return { ...plan, steps: upsertStep(plan.steps || [], event.step) }
      }
      if (event.event === 'plan_verification_done' && event.step_id && event.result) {
        return {
          ...plan,
          steps: (plan.steps || []).map((step) =>
            step.id === event.step_id
              ? { ...step, evidence: [...(step.evidence || []), event.result || {}] }
              : step,
          ),
        }
      }
      return plan
    }),
  }
}

function upsertStep(steps: RuntimePlanStep[], step: RuntimePlanStep): RuntimePlanStep[] {
  const existing = steps.findIndex((item) => item.id === step.id)
  const next = [...steps]
  if (existing >= 0) next[existing] = { ...next[existing], ...step }
  else next.push(step)
  return next
}
```

- [ ] **Step 6: Wire `useRuntime.ts`**

Add:

```typescript
import { applyPlanEvent, type PlanProjection } from '../runtime/handlers/plans'
```

Inside `useRuntime`:

```typescript
  const planProjection = reactive<PlanProjection>({ plans: [] })
```

Inside event handler:

```typescript
    if (
      data.event === 'plan_runtime_update' ||
      data.event === 'plan_step_update' ||
      data.event === 'plan_verification_start' ||
      data.event === 'plan_verification_done'
    ) {
      const next = applyPlanEvent({ plans: planProjection.plans }, data)
      planProjection.plans.splice(0, planProjection.plans.length, ...next.plans)
      return
    }
```

Return `planProjection` from `useRuntime`.

- [ ] **Step 7: Run frontend and backend plan tests**

Run:

```bash
npm --prefix desktop run test -- planProjection
.venv/bin/python -m pytest tests/unit/test_plan_runtime.py tests/unit/test_control.py -q
```

Expected: all tests pass.

- [ ] **Step 8: Commit Plan Runtime API and projection**

Run:

```bash
git add agent/web/routes/plans.py agent/web/app.py agent/web/container.py desktop/src/renderer/src/types.ts desktop/src/renderer/src/runtime/handlers/plans.ts desktop/src/renderer/src/runtime/planProjection.test.ts desktop/src/renderer/src/composables/useRuntime.ts
git commit -m "feat: expose plan runtime projection"
```

Expected: commit succeeds.

## Phase 5.6: Project Execution and Plan Runtime v3

Phase 5.5 made plans durable and executable. Phase 5.6 makes them reliable for real project work. The design reference is `docs/claude-code-core-design/07-project-execution-plan-runtime.md`.

Claude Code behaviors to absorb:

- `EnterPlanMode` is a permission-mode transition, not a prose response.
- Plan mode repeatedly injects full/sparse/re-entry/exit reminders so compaction and resume do not erase the plan boundary.
- The plan artifact is the only writable object during planning.
- `ExitPlanMode` is the approval boundary and restores the previous permission mode.
- `TodoWrite` keeps one active task and refuses to treat blocked or failed work as completed.
- Verification output is part of the completion contract, not a final-response afterthought.

### Task 6F: Plan Decision Policy

**Files:**
- Create: `agent/control/plan_policy.py`
- Modify: `agent/control/manager.py`
- Modify: `agent/runner.py`
- Create: `tests/unit/test_plan_decision_policy.py`

- [x] **Step 1: Write policy tests**

Create `tests/unit/test_plan_decision_policy.py` with these cases:

- A request mentioning architecture, refactor, multiple modules, deployment, deletion, permissions, data migration, or unclear acceptance returns `required`.
- A request likely touching 3+ steps or adding a feature returns `recommended`.
- A typo fix, single-file obvious bug, pure question, or user-provided approved implementation plan returns `proceed`.
- A request inside existing Plan mode returns `proceed` because Plan mode is already active.

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_decision_policy.py -q
```

Expected before implementation: import failure for `agent.control.plan_policy`.

- [x] **Step 2: Add `PlanDecisionPolicy`**

Add a dataclass result:

```python
@dataclass(frozen=True)
class PlanDecision:
    behavior: Literal["required", "recommended", "proceed"]
    reason: str
    signals: list[str]
```

Add `PlanDecisionPolicy.assess(user_message, *, mode, has_pending)` with deterministic rules first. Do not call an LLM in this phase.

- [x] **Step 3: Wire policy as a pre-write guard**

In `AgentRunner`, before non-read-only tools execute under `ask_before_edit` or `auto`, ask `ControlManager` whether the latest user request requires planning. If `required`, return a control tool result that asks the model to enter Plan mode or triggers `ask_user` with a clear reason. Keep simple work unblocked.

- [x] **Step 4: Verify**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_decision_policy.py tests/unit/test_control.py tests/unit/test_runner_state.py -q
```

Expected: all tests pass.

Actual verification:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_decision_policy.py tests/unit/test_control.py tests/unit/test_runner_state.py -q
.venv/bin/python -m ruff check agent/control agent/runner.py tests/unit/test_plan_decision_policy.py tests/unit/test_control.py
```

Result: `26 passed`; ruff passed.

### Task 6G: Plan Draft State and Phases

**Files:**
- Modify: `agent/plans/models.py`
- Modify: `agent/plans/store.py`
- Modify: `agent/control/manager.py`
- Create: `tests/unit/test_plan_draft_state.py`

- [x] **Step 1: Write draft-state tests**

Test that a draft can record:

- `phase`: `exploring`, `questioning`, `designing`, `reviewing`, `ready_for_approval`, `approved`, `executing`.
- `discoveries`: file path, line reference, summary, source tool or subagent.
- `open_questions` and `resolved_questions`.
- `alternatives_considered`.
- `recommended_approach`.
- `verification_strategy`.

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_draft_state.py -q
```

Expected before implementation: model fields missing.

- [x] **Step 2: Extend plan models compatibly**

Add optional fields to `PlanRecord.metadata` first, or add frozen dataclasses with backward-compatible `from_dict()`. Existing `memory/plans/index.json` files must still load.

- [x] **Step 3: Capture Ask answers into draft state**

When Plan mode uses `ask_user`, store questions in `open_questions`. When the user answers, move them into `resolved_questions` and preserve the freeform note.

- [x] **Step 4: Verify**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_draft_state.py tests/unit/test_plan_runtime.py tests/unit/test_control.py -q
```

Expected: all tests pass.

Actual verification:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_draft_state.py tests/unit/test_plan_runtime.py tests/unit/test_control.py tests/unit/test_plan_decision_policy.py tests/unit/test_runner_state.py -q
.venv/bin/python -m ruff check agent/plans agent/control agent/runner.py tests/unit/test_plan_draft_state.py tests/unit/test_plan_runtime.py tests/unit/test_control.py tests/unit/test_plan_decision_policy.py
```

Result: `40 passed`; ruff passed.

### Task 6H: Plan Quality Gate

**Files:**
- Modify: `agent/control/tools.py`
- Modify: `agent/control/manager.py`
- Modify: `agent/plans/models.py`
- Create: `tests/unit/test_plan_quality_gate.py`

- [x] **Step 1: Add failing tests for weak plans**

Reject `propose_plan` when:

- No step has files, discoveries, or clear scope.
- No verification command or manual verification rule exists.
- A step title is generic, such as "fix issue" or "improve code", without concrete acceptance.
- A high-risk step has no risk note or rollback path.

Accept a plan with concrete steps, target files, acceptance checks, and verification.

- [x] **Step 2: Implement `PlanQualityGate`**

Return a structured tool error that the model can repair:

```text
Error: plan quality gate failed
- step_2 has no verification command or manual check
- step_3 is high risk but has no rollback note
```

Do not create a pending PlanCard for a rejected plan.

- [x] **Step 3: Verify**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_quality_gate.py tests/unit/test_plan_runtime.py -q
```

Expected: all tests pass.

Actual verification:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_quality_gate.py tests/unit/test_plan_runtime.py tests/unit/test_control.py tests/unit/test_plan_draft_state.py -q
.venv/bin/python -m ruff check agent/plans agent/control tests/unit/test_plan_quality_gate.py tests/unit/test_plan_runtime.py tests/unit/test_control.py tests/unit/test_plan_draft_state.py
```

Result: `32 passed`; ruff passed.

### Task 6I: Evidence Gate for Step Completion

**Files:**
- Modify: `agent/tools/todo.py`
- Modify: `agent/control/manager.py`
- Modify: `agent/runner.py`
- Create: `tests/unit/test_plan_evidence_gate.py`

- [x] **Step 1: Add failing evidence tests**

Cases:

- Marking an active step completed without verification evidence returns an error when the step declares commands.
- A failed verification result prevents completion.
- A passing verification result allows completion.
- A blocked step requires `blocked_reason` or an `ask_user` interaction.

- [x] **Step 2: Add explicit step identity**

Extend todo items with optional `plan_step_id`; stop relying only on list index. Keep index compatibility for old history and tests.

- [x] **Step 3: Enforce completion**

`ControlManager.sync_plan_from_todos()` should reject a completion transition if required evidence is missing. The tool result should be model-readable and should not corrupt `PlanRecord`.

- [x] **Step 4: Verify**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_evidence_gate.py tests/unit/test_plan_runtime.py tests/unit/test_plan_verification.py -q
```

Expected: all tests pass.

Actual verification:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_evidence_gate.py tests/unit/test_plan_runtime.py tests/unit/test_plan_verification.py tests/unit/test_control.py tests/unit/test_plan_quality_gate.py tests/unit/test_plan_draft_state.py -q
.venv/bin/python -m ruff check agent/plans agent/control agent/runner.py agent/tools/todo.py tests/unit/test_plan_evidence_gate.py tests/unit/test_plan_runtime.py tests/unit/test_plan_verification.py tests/unit/test_control.py
```

Result: `41 passed`; ruff passed.

### Task 6J: Plan Runtime Recovery Attachments

**Files:**
- Create: `agent/plans/context.py`
- Modify: `agent/context_pipeline/pipeline.py`
- Modify: `agent/compactor.py`
- Create: `tests/unit/test_plan_context_attachment.py`

- [x] **Step 1: Add attachment tests**

Projecting context with an executing plan should inject a compact meta message containing:

- plan id, title, status.
- active step id/title/status.
- failed steps with latest evidence summary.
- pending steps count.
- open questions or blocked reason.
- relevant file/artifact references.

Completed plans should not be injected unless the current user message explicitly asks about past plan history.

- [x] **Step 2: Implement `PlanContextBuilder`**

Build small model-visible text from `PlanStore.latest()` with strict size limits. Keep full evidence in runtime/artifacts; the model sees summaries and refs.

- [x] **Step 3: Wire into context projection**

Add an optional `plan_context_provider` to `ContextPipeline`. `AgentRunner` supplies it when `control_manager` exists. `Compactor` also accepts a runtime context provider so compaction prompts preserve plan state.

- [x] **Step 4: Verify**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_context_attachment.py tests/unit/test_context_pipeline.py tests/unit/test_plan_runtime.py -q
```

Expected: all tests pass.

Actual verification:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_context_attachment.py tests/unit/test_context_pipeline.py tests/unit/test_plan_runtime.py tests/unit/test_compactor.py -q
.venv/bin/python -m ruff check agent/plans agent/context_pipeline agent/runner.py agent/compactor.py agent/loop.py tests/unit/test_plan_context_attachment.py tests/unit/test_context_pipeline.py tests/unit/test_plan_runtime.py tests/unit/test_compactor.py
```

Result: `22 passed`; ruff passed.

### Task 6K: Independent Verification Gate

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Modify: `agent/control/manager.py`
- Modify: `agent/runner.py`
- Modify: `agent/subagents/registry.py`
- Create: `tests/unit/test_plan_independent_verification.py`

- [x] **Step 1: Add gate tests**

Trigger independent verification when a plan or turn has:

- 3+ changed files.
- backend/API/permission/scheduler/runtime changes.
- deletion, deployment, external send, or security-sensitive operations.

The final answer gate should require either:

- a verification subagent PASS with command evidence, or
- an explicit user-approved waiver stored in the plan evidence.

- [x] **Step 2: Add verification request model**

Add a small `VerificationReviewRequest` metadata record with changed files, plan id, commands run, and risk signals.

- [x] **Step 3: Wire reviewer dispatch conservatively**

Use existing subagent dispatch only outside Plan mode and only when no Ask/Plan pending exists. If dispatch is unavailable, block final completion with an `ask_user` question rather than silently skipping.

- [x] **Step 4: Verify**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_independent_verification.py tests/unit/test_plan_runtime.py tests/unit/test_runner_state.py -q
```

Expected: all tests pass.

Result:

```bash
.venv/bin/python -m pytest tests/unit/test_plan_independent_verification.py tests/unit/test_plan_runtime.py tests/unit/test_runner_state.py tests/unit/test_agent_prompt_contracts.py -q
```

Result: `27 passed`.

### Task 6L: Project Execution Web Projection

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Modify: `desktop/src/renderer/src/runtime/handlers/plans.ts`
- Modify: `desktop/src/renderer/src/components/chat/PlanCard.vue`
- Create or modify: `desktop/src/renderer/src/runtime/planProjection.test.ts`

- [x] **Step 1: Add projection tests**

Test that replayed events show:

- active step.
- failed verification summary.
- blocked reason.
- open questions count.
- independent verification status.

- [x] **Step 2: Render execution-focused state**

`PlanCard` should show the current execution state first. Long plan markdown remains secondary; users need to see what is active, what failed, and what evidence exists.

- [x] **Step 3: Verify**

Run:

```bash
npm --prefix desktop run test -- planProjection
npm --prefix desktop run build
```

Expected: tests and build pass.

Result:

```bash
npm --prefix desktop run test -- planProjection
npm --prefix desktop run typecheck
```

Result: `6 passed`; typecheck passed. Full `make check` was run after implementation.

## Phase 6: Task Framework and Sidechain Transcript

### Task 7: Durable Task Store

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Create: `agent/tasks/__init__.py`
- Create: `agent/tasks/models.py`
- Create: `agent/tasks/store.py`
- Create: `tests/unit/test_tasks_store.py`

- [x] **Step 1: Write task store tests**

Create `tests/unit/test_tasks_store.py`:

```python
from agent.tasks.models import TaskKind, TaskRecord, TaskStatus
from agent.tasks.store import TaskStore


def test_task_store_round_trips_records(tmp_path) -> None:
    store = TaskStore(tmp_path)
    record = TaskRecord(
        id="task_1",
        kind=TaskKind.SUBAGENT.value,
        status=TaskStatus.RUNNING.value,
        title="inspect files",
        source="dispatch_subagent",
        turn_id="turn_1",
        started_at=123.0,
    )

    store.upsert(record)

    assert store.get("task_1") == record
    assert store.list()[0].id == "task_1"


def test_task_store_marks_corrupt_index(tmp_path) -> None:
    store = TaskStore(tmp_path)
    store.index_file.write_text("{bad json", encoding="utf-8")

    records = store.list()

    assert records == []
    assert list(store.tasks_dir.glob("index.json.corrupt-*"))
```

- [x] **Step 2: Run tests and confirm missing package**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tasks_store.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.tasks'
```

- [x] **Step 3: Add task models**

Create `agent/tasks/models.py`:

```python
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class TaskKind(StrEnum):
    TURN = "turn"
    SUBAGENT = "subagent"
    TEAM_WAKE = "team_wake"
    SCHEDULER_RUN = "scheduler_run"
    WATCHLIST = "watchlist"
    SHELL = "shell"


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class TaskRecord:
    id: str
    kind: str
    status: str
    title: str
    source: str
    started_at: float
    turn_id: str | None = None
    tool_call_id: str | None = None
    job_id: str | None = None
    ended_at: float | None = None
    output_path: str | None = None
    transcript_path: str | None = None
    progress: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TaskRecord":
        return cls(
            id=str(payload["id"]),
            kind=str(payload["kind"]),
            status=str(payload["status"]),
            title=str(payload["title"]),
            source=str(payload["source"]),
            started_at=float(payload["started_at"]),
            turn_id=payload.get("turn_id"),
            tool_call_id=payload.get("tool_call_id"),
            job_id=payload.get("job_id"),
            ended_at=payload.get("ended_at"),
            output_path=payload.get("output_path"),
            transcript_path=payload.get("transcript_path"),
            progress=dict(payload.get("progress") or {}),
            metadata=dict(payload.get("metadata") or {}),
        )
```

Create `agent/tasks/__init__.py`:

```python
from .models import TaskKind, TaskRecord, TaskStatus
from .store import TaskStore

__all__ = ["TaskKind", "TaskRecord", "TaskStatus", "TaskStore"]
```

- [x] **Step 4: Add task store**

Create `agent/tasks/store.py`:

```python
from __future__ import annotations

import json
import time
from pathlib import Path
from uuid import uuid4

from .models import TaskRecord


class TaskStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.tasks_dir = self.root / "memory" / "tasks"
        self.index_file = self.tasks_dir / "index.json"
        self.tasks_dir.mkdir(parents=True, exist_ok=True)
        if not self.index_file.exists():
            self._write({})

    def list(self) -> list[TaskRecord]:
        data = self._read()
        return [TaskRecord.from_dict(item) for item in data.values()]

    def get(self, task_id: str) -> TaskRecord | None:
        data = self._read()
        payload = data.get(task_id)
        return TaskRecord.from_dict(payload) if isinstance(payload, dict) else None

    def upsert(self, record: TaskRecord) -> None:
        data = self._read()
        data[record.id] = record.to_dict()
        self._write(data)

    def _read(self) -> dict:
        try:
            raw = json.loads(self.index_file.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            corrupt = self.index_file.with_name(f"index.json.corrupt-{int(time.time())}")
            self.index_file.replace(corrupt)
            self._write({})
            return {}
        return raw if isinstance(raw, dict) else {}

    def _write(self, data: dict) -> None:
        tmp = self.index_file.with_name(f".{self.index_file.name}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.index_file)
```

- [x] **Step 5: Run task store tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tasks_store.py -q
```

Expected:

```text
2 passed
```

- [x] **Step 6: Commit task store**

Run:

```bash
git add agent/tasks tests/unit/test_tasks_store.py
git commit -m "feat: add durable task store"
```

Expected: commit succeeds.

### Task 8: Sidechain Transcript Store

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Create: `agent/tasks/sidechain.py`
- Create: `tests/unit/test_sidechain_transcript.py`

- [x] **Step 1: Write sidechain tests**

Create `tests/unit/test_sidechain_transcript.py`:

```python
from agent.tasks.sidechain import SidechainTranscript


def test_sidechain_appends_and_reads_pages(tmp_path) -> None:
    transcript = SidechainTranscript(tmp_path, "task_1")
    transcript.append({"role": "user", "content": "start"})
    transcript.append({"role": "assistant", "content": "done"})

    page = transcript.read(offset=0, limit=10)

    assert page["nextOffset"] == 2
    assert [item["role"] for item in page["messages"]] == ["user", "assistant"]


def test_sidechain_skips_bad_lines(tmp_path) -> None:
    transcript = SidechainTranscript(tmp_path, "task_1")
    transcript.path.parent.mkdir(parents=True, exist_ok=True)
    transcript.path.write_text('{"role":"user","content":"ok"}\n{bad json}\n', encoding="utf-8")

    page = transcript.read(offset=0, limit=10)

    assert len(page["messages"]) == 1
    assert page["messages"][0]["content"] == "ok"
```

- [x] **Step 2: Run tests and confirm missing module**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_sidechain_transcript.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'agent.tasks.sidechain'
```

- [x] **Step 3: Add sidechain transcript**

Create `agent/tasks/sidechain.py`:

```python
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class SidechainTranscript:
    def __init__(self, root: Path | str, task_id: str) -> None:
        self.root = Path(root)
        self.task_id = task_id
        self.path = self.root / "memory" / "tasks" / task_id / "transcript.jsonl"

    def append(self, message: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(message)
        payload.setdefault("task_id", self.task_id)
        payload.setdefault("sidechain", True)
        payload.setdefault("ts", time.time())
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def extend(self, messages: list[dict[str, Any]]) -> None:
        for message in messages:
            self.append(message)

    def read(self, *, offset: int = 0, limit: int = 100) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        next_offset = 0
        if not self.path.exists():
            return {"messages": [], "nextOffset": 0, "path": str(self.path)}
        with self.path.open("r", encoding="utf-8") as file:
            for line_number, line in enumerate(file):
                next_offset = line_number + 1
                if line_number < offset:
                    continue
                if len(messages) >= limit:
                    break
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict):
                    messages.append(payload)
        return {"messages": messages, "nextOffset": min(next_offset, offset + len(messages)), "path": str(self.path)}
```

- [x] **Step 4: Run sidechain tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_sidechain_transcript.py -q
```

Expected:

```text
2 passed
```

- [x] **Step 5: Commit sidechain store**

Run:

```bash
git add agent/tasks/sidechain.py tests/unit/test_sidechain_transcript.py
git commit -m "feat: add sidechain transcript store"
```

Expected: commit succeeds.

## Phase 7: Runtime Events and Frontend Projection

### Task 9: Add Task Lifecycle Events

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Modify: `agent/runtime/events.py`
- Modify: `desktop/src/renderer/src/types.ts`
- Create: `desktop/src/renderer/src/runtime/handlers/tasks.ts`
- Create: `desktop/src/renderer/src/runtime/taskProjection.test.ts`
- Modify: `desktop/src/renderer/src/composables/useRuntime.ts`

- [x] **Step 1: Add frontend projection tests first**

Create `desktop/src/renderer/src/runtime/taskProjection.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { applyTaskEvent, type TaskProjection } from './handlers/tasks'

describe('task projection', () => {
  it('creates and completes a task from replayed events', () => {
    let projection: TaskProjection = { tasks: [] }
    projection = applyTaskEvent(projection, {
      event: 'task_started',
      task: {
        id: 'task_1',
        kind: 'subagent',
        status: 'running',
        title: 'inspect',
        source: 'dispatch_subagent',
        startedAt: 1,
      },
    })
    projection = applyTaskEvent(projection, {
      event: 'task_done',
      task: {
        id: 'task_1',
        kind: 'subagent',
        status: 'completed',
        title: 'inspect',
        source: 'dispatch_subagent',
        startedAt: 1,
        endedAt: 2,
      },
    })

    expect(projection.tasks).toHaveLength(1)
    expect(projection.tasks[0]?.status).toBe('completed')
  })
})
```

- [x] **Step 2: Run frontend test and confirm missing handler**

Run:

```bash
npm --prefix desktop run test -- taskProjection
```

Expected: failure because `./handlers/tasks` does not exist.

- [x] **Step 3: Add backend event helpers**

Modify `agent/runtime/events.py`:

```python
def task_started(task: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("task_started", task=task)


def task_progress(task: dict[str, Any], *, progress: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("task_progress", task=task, progress=progress)


def task_output(task: dict[str, Any], *, offset: int, chunk: str) -> dict[str, Any]:
    return runtime_event("task_output", task=task, offset=offset, chunk=chunk)


def task_done(task: dict[str, Any]) -> dict[str, Any]:
    return runtime_event("task_done", task=task)


def task_error(task: dict[str, Any], *, error: str) -> dict[str, Any]:
    return runtime_event("task_error", task=task, error=error)


def task_cancelled(task: dict[str, Any], *, reason: str = "cancelled") -> dict[str, Any]:
    return runtime_event("task_cancelled", task=task, reason=reason)
```

- [x] **Step 4: Add frontend task types**

Modify `desktop/src/renderer/src/types.ts` near runtime event types:

```typescript
export interface RuntimeTaskRecord {
  id: string
  kind: string
  status: string
  title: string
  source: string
  startedAt?: number
  endedAt?: number | null
  turnId?: string | null
  toolCallId?: string | null
  jobId?: string | null
  outputPath?: string | null
  transcriptPath?: string | null
  progress?: Record<string, unknown>
  metadata?: Record<string, unknown>
}
```

Add event variants to `WsEvent`:

```typescript
  | { event: 'task_started'; task?: RuntimeTaskRecord }
  | { event: 'task_progress'; task?: RuntimeTaskRecord; progress?: Record<string, unknown> }
  | { event: 'task_output'; task?: RuntimeTaskRecord; offset?: number; chunk?: string }
  | { event: 'task_done'; task?: RuntimeTaskRecord }
  | { event: 'task_error'; task?: RuntimeTaskRecord; error?: string }
  | { event: 'task_cancelled'; task?: RuntimeTaskRecord; reason?: string }
```

- [x] **Step 5: Add task projection helper**

Create `desktop/src/renderer/src/runtime/handlers/tasks.ts`:

```typescript
import type { RuntimeTaskRecord, WsEvent } from '../../types'

export interface TaskProjection {
  tasks: RuntimeTaskRecord[]
}

type TaskEvent = Extract<WsEvent, {
  event: 'task_started' | 'task_progress' | 'task_output' | 'task_done' | 'task_error' | 'task_cancelled'
}>

export function applyTaskEvent(projection: TaskProjection, event: TaskEvent): TaskProjection {
  if (!event.task?.id) return projection
  const existing = projection.tasks.findIndex((task) => task.id === event.task?.id)
  const nextTask: RuntimeTaskRecord = {
    ...(existing >= 0 ? projection.tasks[existing] : {}),
    ...event.task,
  }
  if (event.event === 'task_progress' && event.progress) {
    nextTask.progress = { ...(nextTask.progress || {}), ...event.progress }
  }
  const tasks = [...projection.tasks]
  if (existing >= 0) tasks[existing] = nextTask
  else tasks.push(nextTask)
  return { tasks }
}
```

- [x] **Step 6: Wire `useRuntime.ts` to consume task events**

Modify imports:

```typescript
import { applyTaskEvent, type TaskProjection } from '../runtime/handlers/tasks'
```

Inside `useRuntime`, add:

```typescript
  const taskProjection = reactive<TaskProjection>({ tasks: [] })
```

Inside `applyRuntimeEvent`, before scheduler/team branches:

```typescript
    if (
      data.event === 'task_started' ||
      data.event === 'task_progress' ||
      data.event === 'task_output' ||
      data.event === 'task_done' ||
      data.event === 'task_error' ||
      data.event === 'task_cancelled'
    ) {
      const next = applyTaskEvent({ tasks: taskProjection.tasks }, data)
      taskProjection.tasks.splice(0, taskProjection.tasks.length, ...next.tasks)
      return
    }
```

Return `taskProjection` from `useRuntime` public API.

- [x] **Step 7: Run frontend task projection test**

Run:

```bash
npm --prefix desktop run test -- taskProjection
```

Expected: test passes.

- [x] **Step 8: Commit runtime event projection**

Run:

```bash
git add agent/runtime/events.py desktop/src/renderer/src/types.ts desktop/src/renderer/src/runtime/handlers/tasks.ts desktop/src/renderer/src/runtime/taskProjection.test.ts desktop/src/renderer/src/composables/useRuntime.ts
git commit -m "feat: add task runtime projection"
```

Expected: commit succeeds.

## Phase 8: Subagent and Team Sidechain Migration

### Task 10: Register Subagent Runs as Tasks

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Modify: `agent/tools/dispatch.py`
- Modify: `agent/loop.py`
- Modify: `agent/web/container.py`
- Create: `tests/unit/test_subagent_task_sidechain.py`

- [x] **Step 1: Write tests for dispatch task registration**

Create `tests/unit/test_subagent_task_sidechain.py`:

```python
from agent.tasks.models import TaskKind, TaskStatus
from agent.tasks.store import TaskStore


def test_subagent_task_record_shape(tmp_path) -> None:
    store = TaskStore(tmp_path)
    task_id = "subagent_1"
    record = {
        "id": task_id,
        "kind": TaskKind.SUBAGENT.value,
        "status": TaskStatus.RUNNING.value,
        "title": "read files",
        "source": "dispatch_subagent",
        "started_at": 1.0,
        "turn_id": "turn_1",
        "tool_call_id": "call_1",
        "transcript_path": "memory/tasks/subagent_1/transcript.jsonl",
    }

    from agent.tasks.models import TaskRecord

    store.upsert(TaskRecord.from_dict(record))

    loaded = store.get(task_id)
    assert loaded is not None
    assert loaded.kind == "subagent"
    assert loaded.transcript_path.endswith("transcript.jsonl")
```

- [x] **Step 2: Run the shape test**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_subagent_task_sidechain.py -q
```

Expected: test passes after Task 7 is merged.

- [x] **Step 3: Add task manager injection to dispatch tool**

Modify `DispatchSubagentTool.__init__` signature:

```python
                 runner_factory,
                 task_manager=None):
```

Add:

```python
        self._task_manager = task_manager
```

Inside `execute()`, after `subagent_id = f"sub_{counter}"`, create a task when task manager exists:

```python
            task_record = None
            if self._task_manager is not None:
                task_record = self._task_manager.start_task(
                    kind="subagent",
                    title=purpose or task[:80],
                    source="dispatch_subagent",
                    tool_call_id=parent_call_id,
                    metadata={"agent_type": agent_type},
                )
```

When `history` is initialized, append the task input to sidechain:

```python
            if task_record is not None:
                self._task_manager.append_sidechain(task_record.id, history[0])
```

When final succeeds:

```python
                if task_record is not None:
                    self._task_manager.append_sidechain(task_record.id, {"role": "assistant", "content": final})
                    self._task_manager.complete_task(task_record.id, summary=final[:500])
```

When exception occurs:

```python
                if task_record is not None:
                    self._task_manager.fail_task(task_record.id, error=str(exc))
```

- [x] **Step 4: Add a minimal TaskManager before wiring all call sites**

Create `agent/tasks/manager.py`:

```python
from __future__ import annotations

import time
from pathlib import Path
from uuid import uuid4

from .models import TaskKind, TaskRecord, TaskStatus
from .sidechain import SidechainTranscript
from .store import TaskStore


class TaskManager:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.store = TaskStore(self.root)

    def start_task(
        self,
        *,
        kind: str,
        title: str,
        source: str,
        turn_id: str | None = None,
        tool_call_id: str | None = None,
        metadata: dict | None = None,
    ) -> TaskRecord:
        prefix = {
            TaskKind.SUBAGENT.value: "subagent",
            TaskKind.TEAM_WAKE.value: "team",
            TaskKind.SCHEDULER_RUN.value: "scheduler",
        }.get(kind, "task")
        task_id = f"{prefix}_{uuid4().hex[:12]}"
        transcript = SidechainTranscript(self.root, task_id)
        record = TaskRecord(
            id=task_id,
            kind=kind,
            status=TaskStatus.RUNNING.value,
            title=title,
            source=source,
            started_at=time.time(),
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            transcript_path=str(transcript.path.relative_to(self.root)),
            metadata=metadata or {},
        )
        self.store.upsert(record)
        return record

    def append_sidechain(self, task_id: str, message: dict) -> None:
        SidechainTranscript(self.root, task_id).append(message)

    def complete_task(self, task_id: str, *, summary: str = "") -> None:
        record = self.store.get(task_id)
        if record is None:
            return
        self.store.upsert(TaskRecord(
            **{**record.to_dict(), "status": TaskStatus.COMPLETED.value, "ended_at": time.time(), "progress": {"summary": summary}},
        ))

    def fail_task(self, task_id: str, *, error: str) -> None:
        record = self.store.get(task_id)
        if record is None:
            return
        self.store.upsert(TaskRecord(
            **{**record.to_dict(), "status": TaskStatus.FAILED.value, "ended_at": time.time(), "progress": {"error": error}},
        ))
```

Update `agent/tasks/__init__.py`:

```python
from .manager import TaskManager
from .models import TaskKind, TaskRecord, TaskStatus
from .store import TaskStore

__all__ = ["TaskKind", "TaskManager", "TaskRecord", "TaskStatus", "TaskStore"]
```

- [x] **Step 5: Wire task manager in composition root**

Modify `agent/loop.py` where tools are registered:

```python
from .tasks import TaskManager
```

Create once near other stores:

```python
task_manager = TaskManager(root)
```

Pass `task_manager=task_manager` to `DispatchSubagentTool`.

- [x] **Step 6: Run subagent-related tests**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_subagent_task_sidechain.py tests/unit/test_team.py tests/unit/test_loop_sessions.py -q
```

Expected: all tests pass.

- [x] **Step 7: Commit subagent task registration**

Run:

```bash
git add agent/tasks/manager.py agent/tasks/__init__.py agent/tools/dispatch.py agent/loop.py tests/unit/test_subagent_task_sidechain.py
git commit -m "feat: record subagent sidechain tasks"
```

Expected: commit succeeds.

## Phase 9: Advanced Context Budget and Reactive Compact

### Task 11: File-Backed Tool Result Store

Status: done in branch `codex/plan-runtime-v2`.

**Files:**
- Modify: `agent/context_pipeline/models.py`
- Modify: `agent/context_pipeline/tool_results.py`
- Create: `tests/unit/test_tool_result_store.py`

- [x] **Step 1: Write tests for stable replacement records**

Create `tests/unit/test_tool_result_store.py`:

```python
from agent.context_pipeline.tool_results import ToolResultStore


def test_tool_result_store_reuses_replacement_record(tmp_path) -> None:
    store = ToolResultStore(tmp_path)
    record1 = store.persist_large_result("turn_1", "call_1", "grep", "x" * 9000, preview_chars=100)
    record2 = store.persist_large_result("turn_1", "call_1", "grep", "x" * 9000, preview_chars=100)

    assert record1 == record2
    assert record1.preview.startswith("x" * 100)
    assert (tmp_path / record1.artifact_path).exists()
```

- [x] **Step 2: Run tests and confirm missing store**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tool_result_store.py -q
```

Expected: import failure for `ToolResultStore`.

- [x] **Step 3: Add replacement record model**

Modify `agent/context_pipeline/models.py`:

```python
@dataclass(frozen=True)
class ToolResultReplacementRecord:
    turn_id: str
    tool_call_id: str
    tool_name: str
    artifact_path: str
    preview: str
    original_chars: int
```

- [x] **Step 4: Add file-backed store**

Modify `agent/context_pipeline/tool_results.py`:

```python
import hashlib
import json
from pathlib import Path

from .models import ToolResultReplacementRecord


class ToolResultStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.dir = self.root / "memory" / "tool-results"
        self.dir.mkdir(parents=True, exist_ok=True)

    def persist_large_result(
        self,
        turn_id: str,
        tool_call_id: str,
        tool_name: str,
        content: str,
        *,
        preview_chars: int = 1000,
    ) -> ToolResultReplacementRecord:
        digest = hashlib.sha256(f"{turn_id}:{tool_call_id}:{content}".encode("utf-8")).hexdigest()[:16]
        artifact = self.dir / f"{digest}.txt"
        meta = self.dir / f"{digest}.json"
        if not artifact.exists():
            artifact.write_text(content, encoding="utf-8")
        preview = content[:preview_chars]
        record = ToolResultReplacementRecord(
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            artifact_path=str(artifact.relative_to(self.root)),
            preview=preview,
            original_chars=len(content),
        )
        if not meta.exists():
            meta.write_text(json.dumps(record.__dict__, ensure_ascii=False, indent=2), encoding="utf-8")
        return record
```

- [x] **Step 5: Run tool result store test**

Run:

```bash
.venv/bin/python -m pytest tests/unit/test_tool_result_store.py -q
```

Expected:

```text
1 passed
```

- [x] **Step 6: Commit tool result store**

Run:

```bash
git add agent/context_pipeline tests/unit/test_tool_result_store.py
git commit -m "feat: add file-backed tool result store"
```

Expected: commit succeeds.

Focused verification result for Tasks 7-11:

```bash
.venv/bin/python -m pytest tests/unit/test_tasks_store.py tests/unit/test_sidechain_transcript.py tests/unit/test_subagent_task_sidechain.py tests/unit/test_tool_result_store.py tests/unit/test_context_pipeline.py tests/unit/test_runner_state.py -q
npm --prefix desktop run test -- taskProjection planProjection
```

Result: Python `20 passed`; frontend runtime projection `7 passed`.

## Final Verification

Run these commands after each phase and before creating a PR:

```bash
rg -n "T[B]D|TO[D]O|待[定]|待[补]|place[Hh]older|implement[ ]later|fill[ ]in details" docs/superpowers/plans docs/claude-code-core-design
git diff --check
.venv/bin/python -m pytest tests/unit/test_context_pipeline.py tests/unit/test_tool_protocol_v2.py tests/unit/test_tool_execution_engine.py tests/unit/test_permission_pipeline_v2.py tests/unit/test_query_state.py tests/unit/test_tasks_store.py tests/unit/test_sidechain_transcript.py tests/unit/test_tool_result_store.py -q
.venv/bin/python -m pytest tests/unit/test_plan_store.py tests/unit/test_plan_runtime.py tests/unit/test_plan_execution_state.py tests/unit/test_plan_verification.py -q
npm --prefix desktop run test -- planProjection taskProjection
make check
```

Expected:

- The `rg` command prints no matches.
- `git diff --check` prints no whitespace errors.
- Focused pytest commands pass.
- Focused frontend runtime projection tests pass.
- `make check` passes after all runtime code changes are complete.

## Explicit Non-Goals

- Do not port React/Ink components.
- Do not embed Anthropic beta headers or request-only fields in core abstractions.
- Do not add automatic destructive-operation approval.
- Do not replace TeamStore with TaskStore.
- Do not let task sidechain transcript become the main conversation history.
- Do not treat `plan_markdown` as the only source of truth once `PlanRecord` exists.
- Do not mark plan steps complete without command output or explicit evidence.
- Do not use task store for secrets, model keys, MCP config, or local preferences.

## Self-Review

Spec coverage:

- Claude Code `query()` state machine maps to Phase 5 and runner integration.
- Tool object protocol maps to Phase 2.
- Streaming execution maps to Phase 3, with future `add_tool()` queue left for a later provider event upgrade.
- Permission pipeline maps to Phase 4.
- Real project execution and Plan Runtime maps to Phase 5.5.
- Context budget and tool result storage map to Phase 1 and Phase 9.
- Task runtime, sidechain transcript, and Team/Scheduler mapping map to Phase 6 through Phase 8.
- Runtime replay and frontend event projection maps to Phase 7 plus plan projection in Phase 5.5.

Type consistency:

- `TaskRecord` fields use snake_case in Python and convert to camelCase only in API/frontend work.
- `ToolResult.model_content` remains the model-visible string; `display_summary` remains UI-facing.
- `PermissionDecision.behavior` coexists with `allowed` and `requires_approval` during migration.
- `ContextProjection.messages` is the only field the runner sends to the provider.
- `PlanRecord.steps[].status` is the durable execution state; `TodoStore` is a user-visible projection.
- `VerificationResult.passed` is based on command exit code, not model self-assessment.

Execution order:

1. Characterization tests.
2. Context pipeline extraction.
3. Tool Protocol v2 adapter.
4. Tool execution engine.
5. Permission Pipeline v2.
6. Query transition helpers.
7. Project Execution and Plan Runtime v2.
8. Task store and sidechain.
9. Subagent/Team/Scheduler task registration.
10. Frontend task and plan projection.
11. Advanced tool result store and reactive context recovery.
