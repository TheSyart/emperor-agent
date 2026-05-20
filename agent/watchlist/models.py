from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal


@dataclass
class WatchlistDecision:
    action: Literal["skip", "run"] = "skip"
    reason: str = ""
    message: str = ""
    checked_at: float = 0.0
    model: str | None = None
    provider: str | None = None
    model_role: str | None = None

    @classmethod
    def skip(cls, reason: str) -> "WatchlistDecision":
        return cls(action="skip", reason=reason, checked_at=time.time())

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "WatchlistDecision":
        action = str(raw.get("action") or "skip").lower()
        if action not in {"skip", "run"}:
            action = "skip"
        return cls(
            action=action,  # type: ignore[arg-type]
            reason=str(raw.get("reason") or ""),
            message=str(raw.get("message") or ""),
            checked_at=float(raw.get("checked_at") or raw.get("checkedAt") or time.time()),
            model=str(raw.get("model") or "") or None,
            provider=str(raw.get("provider") or "") or None,
            model_role=str(raw.get("model_role") or raw.get("modelRole") or "") or None,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "reason": self.reason,
            "message": self.message,
            "checkedAt": self.checked_at,
            "model": self.model,
            "provider": self.provider,
            "modelRole": self.model_role,
        }
