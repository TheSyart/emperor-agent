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
