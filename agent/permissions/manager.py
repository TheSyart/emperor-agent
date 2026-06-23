from __future__ import annotations

import json
from typing import Any

from ..control.tools import make_pause_result
from .models import PermissionDecision, PermissionTraceEntry
from .policy import PermissionPolicy
from .resolvers import is_high_risk_command


class PermissionManager:
    def __init__(self, control_manager):
        self.control_manager = control_manager
        self.policy = PermissionPolicy()
        self._approved_once: set[str] = set()
        self._denied_once: set[str] = set()

    def assess(self, tool_name: str, arguments: dict[str, Any] | None, *, registry=None) -> PermissionDecision:
        args = arguments or {}
        fingerprint = _fingerprint(tool_name, args)
        if fingerprint in self._approved_once:
            self._approved_once.remove(fingerprint)
            return PermissionDecision.allow(tool_name=tool_name, arguments=args, rule="user.approved_once")
        if fingerprint in self._denied_once:
            self._denied_once.remove(fingerprint)
            return PermissionDecision.deny(
                tool_name=tool_name,
                arguments=args,
                reason="user denied this high-risk operation",
                rule="user.denied_once",
            )
        plan_decision = self._approved_plan_command_decision(tool_name, args)
        if plan_decision is not None:
            return plan_decision
        return self.policy.assess(tool_name, args, self.control_manager.mode, registry=registry)

    def require_approval(
        self,
        decision: PermissionDecision,
        *,
        parent_call_id: str | None = None,
    ) -> str:
        interaction = self.control_manager.create_ask(
            questions=[
                {
                    "id": "permission",
                    "header": "权限",
                    "question": f"是否允许执行高风险操作 `{decision.tool_name}`？",
                    "options": [
                        {"label": "允许", "description": "批准本次操作，Agent 可继续执行。"},
                        {"label": "拒绝", "description": "不执行本次操作，让 Agent 改用更安全方案。"},
                    ],
                }
            ],
            context=self._context(decision),
            parent_call_id=parent_call_id,
            meta={
                "permission": {
                    "fingerprint": _fingerprint(decision.tool_name, decision.arguments or {}),
                    "tool_name": decision.tool_name,
                    "risk": decision.risk,
                    "reason": decision.reason,
                    "rule": decision.rule,
                    "trace": [
                        {"rule": item.rule, "outcome": item.outcome, "detail": item.detail}
                        for item in decision.trace
                    ],
                    "arguments": decision.arguments or {},
                }
            },
        )
        return make_pause_result(interaction.to_dict())

    def record_answer(self, interaction) -> None:
        permission = getattr(interaction, "meta", {}).get("permission") if getattr(interaction, "meta", None) else None
        if not isinstance(permission, dict):
            return
        fingerprint = str(permission.get("fingerprint") or "")
        if not fingerprint:
            return
        answer = interaction.answers.get("permission")
        choice = ""
        if isinstance(answer, dict):
            choice = str(answer.get("choice") or answer.get("freeform") or "")
        else:
            choice = str(answer or "")
        normalized = choice.strip().lower()
        if "允许" in normalized or "approve" in normalized or "allow" in normalized or "yes" == normalized:
            self._approved_once.add(fingerprint)
            self._denied_once.discard(fingerprint)
            return
        self._denied_once.add(fingerprint)
        self._approved_once.discard(fingerprint)

    @staticmethod
    def _context(decision: PermissionDecision) -> str:
        return "\n".join([
            "Permission Guard",
            f"risk: {decision.risk}",
            f"rule: {decision.rule}",
            f"reason: {decision.reason}",
            f"tool: {decision.tool_name}",
            "trace:",
            json.dumps(
                [{"rule": item.rule, "outcome": item.outcome, "detail": item.detail} for item in decision.trace],
                ensure_ascii=False,
                indent=2,
            )[:1200],
            "arguments:",
            json.dumps(decision.arguments or {}, ensure_ascii=False, indent=2)[:1600],
        ])

    def _approved_plan_command_decision(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> PermissionDecision | None:
        if tool_name != "run_command":
            return None
        command = str(arguments.get("command") or "")
        if not command or is_high_risk_command(command):
            return None
        target_provider = getattr(self.control_manager, "plan_verification_target", None)
        if not callable(target_provider):
            return None
        target = target_provider(command)
        if not target:
            return None
        return PermissionDecision.allow(
            tool_name=tool_name,
            arguments=arguments,
            rule="plan.approved_command",
            trace=(
                PermissionTraceEntry("plan.active_step_command", "allow", str(target.get("step_id") or "")),
            ),
        )


def _fingerprint(tool_name: str, arguments: dict[str, Any]) -> str:
    try:
        encoded = json.dumps(arguments or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = json.dumps(_json_safe(arguments or {}), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"{tool_name}:{encoded}"


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
