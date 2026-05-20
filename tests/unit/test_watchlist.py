from __future__ import annotations

import asyncio
from pathlib import Path

from agent.watchlist import WatchlistDecision, WatchlistService, WatchlistStore


def test_watchlist_store_initializes_local_file(tmp_path: Path) -> None:
    store = WatchlistStore(tmp_path)

    assert "Watchlist" in store.read()
    assert store.active_items() == []


def test_watchlist_service_skips_empty_watchlist(tmp_path: Path) -> None:
    service = WatchlistService(tmp_path)

    decision = asyncio.run(service.check())

    assert decision.action == "skip"
    assert service.payload()["lastDecision"]["action"] == "skip"


def test_watchlist_service_uses_fake_decider_for_run(tmp_path: Path) -> None:
    async def decider(_content: str, items: list[str]) -> WatchlistDecision:
        return WatchlistDecision(action="run", reason="due", message=f"Handle {items[0]}")

    service = WatchlistService(tmp_path, decider=decider)
    service.write("- 检查项目跟进\n")

    decision = asyncio.run(service.check())

    assert decision.action == "run"
    assert "项目跟进" in decision.message
    assert service.payload()["lastDecision"]["action"] == "run"
