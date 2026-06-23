from __future__ import annotations

from pathlib import Path

from agent.control import ControlManager
from agent.plans.models import PlanDraftPhase, PlanDraftState, PlanRecord, PlanStatus


def test_plan_draft_state_round_trips_and_old_records_default(tmp_path: Path) -> None:
    record = PlanRecord.from_dict({
        "id": "plan_1",
        "title": "Upgrade runner",
        "summary": "Add structured planning",
        "status": PlanStatus.DRAFT.value,
        "created_at": 1,
        "updated_at": 2,
        "draft": {
            "phase": PlanDraftPhase.DESIGNING.value,
            "discoveries": [
                {
                    "path": "agent/runner.py",
                    "line": 274,
                    "summary": "Tool calls execute before any plan guard.",
                    "source": "read_file",
                }
            ],
            "relevant_files": ["agent/runner.py", "agent/control/manager.py"],
            "open_questions": [{"id": "scope", "question": "迁移范围是什么？"}],
            "resolved_questions": [{"id": "risk", "answer": "保守迁移", "freeform": "先后端"}],
            "alternatives_considered": ["只靠 prompt", "结构化 plan draft"],
            "recommended_approach": "结构化 plan draft",
            "verification_strategy": [".venv/bin/python -m pytest tests/unit/test_plan_draft_state.py -q"],
            "last_context_refresh_at": 3,
        },
    })

    loaded = PlanRecord.from_dict(record.to_dict())

    assert loaded.draft.phase == PlanDraftPhase.DESIGNING.value
    assert loaded.draft.discoveries[0]["path"] == "agent/runner.py"
    assert loaded.draft.relevant_files == ["agent/runner.py", "agent/control/manager.py"]
    assert loaded.draft.open_questions[0]["id"] == "scope"
    assert loaded.draft.resolved_questions[0]["freeform"] == "先后端"
    assert loaded.draft.alternatives_considered == ["只靠 prompt", "结构化 plan draft"]
    assert loaded.draft.recommended_approach == "结构化 plan draft"
    assert loaded.draft.verification_strategy == [
        ".venv/bin/python -m pytest tests/unit/test_plan_draft_state.py -q"
    ]
    assert PlanRecord.from_dict({
        "id": "old",
        "title": "Old plan",
        "summary": "Legacy payload",
        "status": PlanStatus.DRAFT.value,
        "created_at": 1,
        "updated_at": 1,
    }).draft == PlanDraftState()


def test_create_plan_persists_ready_for_approval_draft(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")

    interaction = manager.create_plan(
        title="Plan runtime",
        summary="Persist draft state",
        plan_markdown="# Plan\n\n- Add draft state",
        steps=[
            {
                "id": "step_1",
                "title": "Add draft tests",
                "files": ["tests/unit/test_plan_draft_state.py"],
                "commands": [".venv/bin/python -m pytest tests/unit/test_plan_draft_state.py -q"],
            }
        ],
        assumptions=["keep existing plan records compatible"],
        risk_level="medium",
    )

    saved = manager.plan_store.get(interaction.meta["plan_id"])

    assert saved is not None
    assert saved.draft.phase == PlanDraftPhase.READY_FOR_APPROVAL.value
    assert saved.draft.relevant_files == ["tests/unit/test_plan_draft_state.py"]
    assert saved.draft.recommended_approach == "Persist draft state"
    assert saved.draft.verification_strategy == [
        ".venv/bin/python -m pytest tests/unit/test_plan_draft_state.py -q"
    ]


def test_plan_mode_ask_records_open_and_resolved_questions(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    interaction = manager.create_ask(
        questions=[
            {
                "id": "scope",
                "header": "范围",
                "question": "这次是否包含 WebUI 展示？",
                "options": [
                    {"label": "仅后端", "description": "先落持久化和恢复接口"},
                    {"label": "含 WebUI", "description": "同时展示草稿阶段"},
                ],
            }
        ],
        context="Plan draft 需要确认展示范围。",
    )
    plan_id = interaction.meta["plan_id"]

    draft = manager.plan_store.get(plan_id).draft
    assert draft.phase == PlanDraftPhase.QUESTIONING.value
    assert draft.open_questions == [
        {
            "interaction_id": interaction.id,
            "id": "scope",
            "header": "范围",
            "question": "这次是否包含 WebUI 展示？",
            "options": ["仅后端", "含 WebUI"],
            "context": "Plan draft 需要确认展示范围。",
        }
    ]

    manager.answer(interaction.id, {"scope": {"choice": "仅后端", "freeform": "WebUI 下一步再做"}})
    resolved = manager.plan_store.get(plan_id).draft

    assert resolved.open_questions == []
    assert resolved.resolved_questions == [
        {
            "interaction_id": interaction.id,
            "id": "scope",
            "header": "范围",
            "question": "这次是否包含 WebUI 展示？",
            "answer": "仅后端",
            "freeform": "WebUI 下一步再做",
            "context": "Plan draft 需要确认展示范围。",
        }
    ]


def test_plan_comment_returns_record_to_reviewing_and_reuses_draft(tmp_path: Path) -> None:
    manager = ControlManager(tmp_path)
    manager.set_mode("plan")
    interaction = manager.create_plan(
        title="Initial plan",
        summary="First approach",
        plan_markdown="# Plan\n\n- First approach",
        steps=[{"id": "step_1", "title": "Implement first approach"}],
        assumptions=[],
        risk_level="medium",
    )
    plan_id = interaction.meta["plan_id"]

    manager.comment(interaction.id, "补充迁移风险和回滚路径。")
    commented = manager.plan_store.get(plan_id)

    assert commented.status == PlanStatus.DRAFT.value
    assert commented.draft.phase == PlanDraftPhase.REVIEWING.value
    assert commented.metadata["revisions"][0]["plan_markdown"] == "# Plan\n\n- First approach"
    assert commented.metadata["revisions"][0]["comment"] == "补充迁移风险和回滚路径。"

    revised = manager.create_plan(
        title="Revised plan",
        summary="Second approach",
        plan_markdown="# Plan\n\n- Second approach",
        steps=[{"id": "step_1", "title": "Implement second approach"}],
        assumptions=[],
        risk_level="medium",
    )
    saved = manager.plan_store.get(revised.meta["plan_id"])

    assert revised.meta["plan_id"] == plan_id
    assert saved.draft.phase == PlanDraftPhase.READY_FOR_APPROVAL.value
    assert saved.metadata["revisions"][0]["comment"] == "补充迁移风险和回滚路径。"
