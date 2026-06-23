from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from agent.control import AskUserTool, ControlManager, ProposePlanTool, TurnPaused
from agent.plans.context import PlanContextBuilder
from agent.plans.models import PlanDiscovery, PlanDraftState, PlanStatus, PlanStep
from agent.plans.quality import PlanQualityGate
from agent.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from agent.runner import AgentRunner
from agent.tools import GrepTool, ReadFileTool, ToolRegistry


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[LLMResponse]):
        super().__init__(default_model="fake")
        self.responses = responses

    async def chat(self, **kwargs: Any) -> LLMResponse:
        if self.responses:
            return self.responses.pop(0)
        return LLMResponse(content="done")


def test_plan_discovery_round_trips_through_plan_store(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")

    record = manager.record_plan_discovery(
        source="read_file",
        summary="Read runner tool execution path.",
        files=["agent/runner.py"],
        symbols=["AgentRunner.step_async"],
        evidence_refs=["agent/runner.py#L140-L220"],
    )

    assert record is not None
    loaded = manager.plan_store.get(record.id)
    discovery = loaded.draft.discoveries[0]
    assert discovery["source"] == "read_file"
    assert discovery["summary"] == "Read runner tool execution path."
    assert discovery["files"] == ["agent/runner.py"]
    assert discovery["symbols"] == ["AgentRunner.step_async"]
    assert discovery["evidence_refs"] == ["agent/runner.py#L140-L220"]
    assert loaded.draft.relevant_files == ["agent/runner.py"]


def test_plan_quality_requires_step_to_reference_discovery() -> None:
    discovery = PlanDiscovery(
        id="disc_runner",
        source="grep",
        summary="Found runner plan guard code.",
        files=["agent/runner.py"],
        evidence_refs=["grep:PLAN_GUARD_REQUIRED"],
        created_at=1.0,
    )
    draft = PlanDraftState(discoveries=[discovery.to_dict()])
    unreferenced = PlanStep(
        id="step_1",
        title="Update plan guard",
        description="",
        commands=[".venv/bin/python -m pytest tests/unit/test_control.py -q"],
        risk="low",
    )
    referenced = replace(unreferenced, discovery_refs=["disc_runner"])

    weak = PlanQualityGate().assess(steps=[unreferenced], draft=draft)
    strong = PlanQualityGate().assess(steps=[referenced], draft=draft)

    assert not weak.ok
    assert "step_1 has no target files, discovery reference, or concrete scope" in weak.errors
    assert strong.ok


def test_propose_plan_accepts_step_discovery_refs(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    record = manager.record_plan_discovery(
        source="grep",
        summary="Found runner plan guard code.",
        files=["agent/runner.py"],
        evidence_refs=["grep:PLAN_GUARD_REQUIRED"],
    )
    discovery_id = record.draft.discoveries[0]["id"]
    result = ProposePlanTool(manager).execute(
        title="Runner guard plan",
        summary="Use discovery evidence to update plan guard.",
        plan_markdown="# Plan\n\n- Update runner guard\n\n## Verification\n- pytest",
        steps=[
            {
                "id": "step_1",
                "title": "Update runner guard",
                "description": "",
                "discovery_refs": [discovery_id],
                "commands": [".venv/bin/python -m pytest tests/unit/test_control.py -q"],
                "risk": "low",
            }
        ],
        assumptions=[],
        risk_level="low",
    )

    assert result.startswith("__CONTROL_PAUSE__:")
    pending = manager.payload()["pending"]
    saved = manager.plan_store.get(pending["meta"]["plan_id"])
    assert saved.steps[0].discovery_refs == [discovery_id]


@pytest.mark.anyio
async def test_runner_records_read_and_grep_discoveries_in_plan_mode(tmp_path: Path) -> None:
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / "runner.py").write_text(
        "class AgentRunner:\n    def step_async(self):\n        return 'PLAN_GUARD_REQUIRED'\n",
        encoding="utf-8",
    )
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    registry = ToolRegistry()
    registry.register(ReadFileTool(tmp_path))
    registry.register(GrepTool(tmp_path))
    registry.register(AskUserTool(manager))
    registry.register(ProposePlanTool(manager))
    provider = FakeProvider([
        LLMResponse(
            content="",
            tool_calls=[
                ToolCallRequest(
                    id="call_read",
                    name="read_file",
                    arguments={"path": "agent/runner.py", "offset": 1, "limit": 2},
                ),
                ToolCallRequest(
                    id="call_grep",
                    name="grep",
                    arguments={"pattern": "PLAN_GUARD_REQUIRED", "path": "agent", "output_mode": "files_with_matches"},
                ),
            ],
            finish_reason="tool_calls",
        ),
        LLMResponse(content="Use runner plan guard discovery in the plan."),
    ])
    runner = AgentRunner(
        provider=provider,
        model="fake",
        registry=registry,
        system_prompt="system",
        control_manager=manager,
    )

    with pytest.raises(TurnPaused):
        await runner.step_async([{"role": "user", "content": "Plan the runner guard upgrade"}])

    record = manager.plan_store.latest()
    discoveries = record.draft.discoveries
    by_source = {item["source"]: item for item in discoveries}
    assert set(by_source) == {"read_file", "grep"}
    assert by_source["read_file"]["files"] == ["agent/runner.py"]
    assert by_source["read_file"]["evidence_refs"] == ["agent/runner.py#L1-L2"]
    assert by_source["grep"]["files"] == ["agent/runner.py"]
    assert "PLAN_GUARD_REQUIRED" in by_source["grep"]["summary"]


def test_plan_context_builder_includes_recent_discoveries(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    record = manager.record_plan_discovery(
        source="grep",
        summary="Found existing plan guard in runner.",
        files=["agent/runner.py"],
        evidence_refs=["grep:PLAN_GUARD_REQUIRED"],
    )
    manager.plan_store.save(replace(record, status=PlanStatus.EXECUTING.value))

    content = PlanContextBuilder(manager.plan_store).message_for([
        {"role": "user", "content": "continue approved plan"},
    ])["content"]

    assert "discovery: grep Found existing plan guard in runner." in content
    assert "  discovery_file: agent/runner.py" in content
    assert "  evidence_ref: grep:PLAN_GUARD_REQUIRED" in content
