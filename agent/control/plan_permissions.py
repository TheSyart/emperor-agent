"""Plan permission token lifecycle (issue / consume / revoke).

Extracted verbatim from ControlManager (no behavior change). Operates on the shared
plan_store via the owning ControlManager; high-risk commands are never issued a token.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from ..permissions import PlanPermissionToken, permission_argument_hash
from ..permissions.resolvers import is_high_risk_command
from ..plans import PlanRecord, PlanStepStatus
from .models import now_ts
from .plan_helpers import _metadata_without_plan_permission_tokens

_PLAN_PERMISSION_TOKEN_TTL_SECONDS = 3600.0


class PlanPermissionTokenManager:
    def __init__(self, control_manager) -> None:
        self._cm = control_manager

    def issue(self, record: PlanRecord) -> PlanRecord:
        now = now_ts()
        tokens: list[dict[str, Any]] = []
        for step in record.steps:
            if step.status != PlanStepStatus.ACTIVE.value:
                continue
            for command in step.commands:
                text = str(command or "")
                if not text.strip() or is_high_risk_command(text):
                    continue
                tokens.append(
                    PlanPermissionToken(
                        plan_id=record.id,
                        step_id=step.id,
                        tool_name="run_command",
                        argument_hash=permission_argument_hash({"command": text}),
                        expires_at=now + _PLAN_PERMISSION_TOKEN_TTL_SECONDS,
                        uses_remaining=1,
                        reason="approved plan active step verification command",
                    ).to_dict()
                )
        metadata = dict(record.metadata)
        metadata["permission_tokens"] = tokens
        return replace(record, metadata=metadata)

    def consume(
        self,
        *,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> PlanPermissionToken | None:
        record = self._cm._latest_executable_plan()
        if record is None:
            return None
        active_step_ids = {
            step.id
            for step in record.steps
            if step.status == PlanStepStatus.ACTIVE.value
        }
        if not active_step_ids:
            return None
        now = now_ts()
        target_hash = permission_argument_hash(arguments or {})
        tokens_raw = record.metadata.get("permission_tokens") or []
        if not isinstance(tokens_raw, list):
            return None
        kept: list[dict[str, Any]] = []
        consumed: PlanPermissionToken | None = None
        changed = False
        for item in tokens_raw:
            if not isinstance(item, dict):
                changed = True
                continue
            token = PlanPermissionToken.from_dict(item)
            if (
                token.plan_id != record.id
                or token.step_id not in active_step_ids
                or token.expires_at <= now
                or token.uses_remaining <= 0
            ):
                changed = True
                continue
            if (
                consumed is None
                and token.tool_name == tool_name
                and token.argument_hash == target_hash
            ):
                consumed = token
                changed = True
                remaining = replace(token, uses_remaining=token.uses_remaining - 1)
                if remaining.uses_remaining > 0:
                    kept.append(remaining.to_dict())
                continue
            kept.append(token.to_dict())
        if changed:
            metadata = dict(record.metadata)
            metadata["permission_tokens"] = kept
            self._cm.plan_store.save(replace(record, updated_at=now, metadata=metadata))
        return consumed

    def revoke(
        self,
        *,
        plan_id: str | None = None,
        reason: str = "revoked",
    ) -> PlanRecord | None:
        record = self._cm.plan_store.get(plan_id) if plan_id else self._cm._latest_executable_plan()
        if record is None:
            return None
        if not record.metadata.get("permission_tokens"):
            return record
        metadata = _metadata_without_plan_permission_tokens(record.metadata, reason=reason)
        updated = replace(record, updated_at=now_ts(), metadata=metadata)
        self._cm.plan_store.save(updated)
        return updated
