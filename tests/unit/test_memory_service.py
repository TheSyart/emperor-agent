from __future__ import annotations

import pytest

from agent.web.services.memory_service import validate_episode_date


@pytest.mark.parametrize("date", ["2026-05-20", "1999-01-01"])
def test_validate_episode_date_accepts_calendar_dates(date: str) -> None:
    assert validate_episode_date(date) == date


@pytest.mark.parametrize(
    "date",
    [
        "",
        "MEMORY.local",
        "watchlist",
        "../2026-05-20",
        "2026-5-1",
        "2026-02-31",
        "2026-05-20.md",
    ],
)
def test_validate_episode_date_rejects_non_episode_names(date: str) -> None:
    with pytest.raises(ValueError, match="YYYY-MM-DD"):
        validate_episode_date(date)
