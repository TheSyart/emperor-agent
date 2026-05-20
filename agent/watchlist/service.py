from __future__ import annotations

import inspect
import json
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from loguru import logger

from ..model_router import ModelRouter
from ..telemetry import TokenTracker
from .models import WatchlistDecision
from .store import WatchlistStore


DecisionFn = Callable[[str, list[str]], WatchlistDecision | Awaitable[WatchlistDecision]]


class WatchlistService:
    def __init__(
        self,
        root: Path,
        *,
        model_router: ModelRouter | None = None,
        token_tracker: TokenTracker | None = None,
        decider: DecisionFn | None = None,
    ):
        self.root = Path(root).resolve()
        self.store = WatchlistStore(self.root)
        self.model_router = model_router
        self.token_tracker = token_tracker
        self.decider = decider

    def payload(self) -> dict[str, Any]:
        return self.store.payload()

    def read(self) -> str:
        return self.store.read()

    def write(self, content: str) -> dict[str, Any]:
        self.store.write(content)
        return self.payload()

    async def check(self) -> WatchlistDecision:
        content = self.store.read()
        items = self.store.active_items()
        if not items:
            decision = WatchlistDecision.skip("watchlist has no active items")
            self.store.write_decision(decision)
            return decision
        if self.decider:
            result = self.decider(content, items)
            decision = await result if inspect.isawaitable(result) else result
        else:
            decision = await self._decide_with_model(content, items)
        decision.checked_at = decision.checked_at or time.time()
        self.store.write_decision(decision)
        return decision

    async def _decide_with_model(self, content: str, items: list[str]) -> WatchlistDecision:
        if self.model_router is None:
            return WatchlistDecision.skip("model router is unavailable")
        route = self.model_router.route("watchlist_check", task=content)
        snapshot = route.snapshot
        prompt = _decision_prompt(content=content, items=items)
        try:
            resp = await snapshot.provider.chat(
                model=snapshot.model,
                max_tokens=min(1200, snapshot.generation.max_tokens),
                temperature=0,
                reasoning_effort=snapshot.generation.reasoning_effort,
                messages=prompt,
                tools=None,
            )
        except Exception as exc:
            fallback = route.fallback
            if fallback is None:
                raise
            logger.warning("watchlist secondary fallback: {} -> {} because {}", snapshot.model, fallback.model, exc)
            snapshot = fallback
            resp = await fallback.provider.chat(
                model=fallback.model,
                max_tokens=min(1200, fallback.generation.max_tokens),
                temperature=0,
                reasoning_effort=fallback.generation.reasoning_effort,
                messages=prompt,
                tools=None,
            )
        if self.token_tracker and resp.usage:
            self.token_tracker.record(
                snapshot.model,
                resp.usage,
                provider=snapshot.provider_name,
                usage_type="watchlist_check",
                model_role=snapshot.model_role,
            )
        decision = _parse_decision(resp.content or "")
        decision.model = snapshot.model
        decision.provider = snapshot.provider_name
        decision.model_role = snapshot.model_role
        return decision


def _decision_prompt(*, content: str, items: list[str]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You are a local watchlist decision filter. Decide if the agent should proactively run now. "
                "Return strict JSON only: {\"action\":\"skip|run\",\"reason\":\"...\",\"message\":\"...\"}. "
                "Choose skip unless there is a concrete, timely, user-relevant action. Never include hidden reasoning."
            ),
        },
        {
            "role": "user",
            "content": (
                "Current watchlist markdown:\n"
                f"{content}\n\n"
                "Active items:\n"
                + "\n".join(f"- {item}" for item in items)
            ),
        },
    ]


def _parse_decision(text: str) -> WatchlistDecision:
    raw = text.strip()
    match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if match:
        raw = match.group(0)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return WatchlistDecision.skip("watchlist model returned non-JSON decision")
    if not isinstance(parsed, dict):
        return WatchlistDecision.skip("watchlist model returned invalid decision")
    decision = WatchlistDecision.from_dict(parsed)
    decision.reason = _clean(decision.reason)[:500]
    decision.message = _clean(decision.message)[:1200]
    if decision.action == "run" and not decision.message:
        decision.action = "skip"
        decision.reason = decision.reason or "run decision had no actionable message"
    return decision


def _clean(value: str) -> str:
    return " ".join(str(value or "").split())
