"""Pure module-level helpers extracted from runner.py (no behavior change).

These are self-contained utilities used by AgentRunner; keeping them here keeps the
turn-loop module focused. `_estimate_messages_tokens` uses the shared
`content_text_size` from context_pipeline (identical to the former
`AgentRunner._content_text_size`).
"""

from __future__ import annotations

from typing import Any

from .context_pipeline.tool_results import content_text_size
from .providers import ToolCallRequest
from .tools.results import ToolResult

_TODO_ICON = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}


def _render_todos(todos: list[dict]) -> str:
    lines = []
    for t in todos:
        icon = _TODO_ICON.get(t.get("status", "pending"), "[?]")
        lines.append(f"  {icon} {t.get('id')}. {t.get('content', '')}")
    return "\n".join(lines)


def _summarize_tool_result(content: str, limit: int = 560) -> str:
    text = " ".join(str(content or "").split())
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def _plan_guard_message(call: ToolCallRequest, decision: Any) -> str:
    signals = ", ".join(getattr(decision, "signals", []) or [])
    reason = str(getattr(decision, "reason", "") or "high-impact work requires planning")
    readonly_scopes = "; ".join(getattr(decision, "recommended_readonly_scopes", []) or [])
    return "\n".join([
        "Error: PLAN_GUARD_REQUIRED",
        f"tool: {call.name}",
        f"reason: {reason}",
        f"signals: {signals}",
        f"readonly_scopes: {readonly_scopes}",
        "Before using write or high-impact tools for this request, enter Plan mode, perform read-only exploration, "
        "submit a concrete plan, and wait for user approval.",
    ])


def _plan_decision_contract(decision: Any) -> dict[str, Any]:
    to_runtime_contract = getattr(decision, "to_runtime_contract", None)
    if callable(to_runtime_contract):
        payload = to_runtime_contract()
    else:
        payload = {
            "decision": getattr(decision, "behavior", "proceed"),
            "reason": getattr(decision, "reason", ""),
            "triggers": getattr(decision, "signals", []) or [],
            "suggested_questions": [],
            "recommended_readonly_scopes": [],
        }
    return {
        "decision": str(payload.get("decision") or "proceed"),
        "reason": str(payload.get("reason") or ""),
        "triggers": [str(item) for item in payload.get("triggers") or []],
        "suggested_questions": [str(item) for item in payload.get("suggested_questions") or []],
        "recommended_readonly_scopes": [str(item) for item in payload.get("recommended_readonly_scopes") or []],
    }


def _discovery_files(source: str, result: ToolResult) -> list[str]:
    if source == "read_file":
        path = str(result.metadata.get("path") or "").strip()
        return [path] if path else [artifact.path for artifact in result.artifacts if artifact.path]
    if source == "grep":
        mode = str(result.metadata.get("output_mode") or "")
        lines = [
            line.strip()
            for line in result.model_content.splitlines()
            if line.strip() and not line.startswith("(")
        ]
        if mode == "content":
            return _dedupe_strings([
                line.split(":", 1)[0]
                for line in lines
                if ":" in line and not line[:1].isspace() and not line.startswith(">")
            ])
        if mode == "count":
            return _dedupe_strings([line.split(":", 1)[0] for line in lines if ": " in line])
        if result.model_content.startswith("No matches found"):
            return []
        return _dedupe_strings(lines)
    return []


def _discovery_evidence_refs(source: str, result: ToolResult, files: list[str]) -> list[str]:
    if source == "read_file":
        path = str(result.metadata.get("path") or (files[0] if files else "")).strip()
        start = result.metadata.get("line_start")
        end = result.metadata.get("line_end")
        if path and start and end:
            return [f"{path}#L{start}-L{end}"]
        return [path] if path else []
    if source == "grep":
        pattern = str(result.metadata.get("pattern") or "").strip()
        return [f"grep:{pattern}"] if pattern else []
    return []


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


def _latest_user_text(history: list[dict[str, Any]]) -> str:
    for message in reversed(history):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = [
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            ]
            return "\n".join(parts).strip()
        return str(content or "").strip()
    return ""


def _context_used_from_usage(usage: dict[str, int]) -> int:
    input_tokens = int(usage.get("input", usage.get("prompt_tokens", 0)) or 0)
    cache_read = int(usage.get("cache_read", usage.get("cache_read_input_tokens", 0)) or 0)
    cache_create = int(usage.get("cache_create", usage.get("cache_creation_input_tokens", 0)) or 0)
    return input_tokens + cache_read + cache_create


def _estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
    total_chars = 0
    for msg in messages:
        total_chars += content_text_size(msg.get("content"))
        for tool_call in msg.get("tool_calls") or []:
            total_chars += len(str(tool_call))
    return max(1, total_chars // 3)


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _control_interaction_event(interaction: dict[str, Any]) -> dict[str, Any]:
    event = "ask_request" if interaction.get("kind") == "ask" else "plan_draft"
    return {"event": event, "interaction": interaction}
