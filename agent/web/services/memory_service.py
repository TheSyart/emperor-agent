from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from aiohttp import web
from loguru import logger

from ...attachments import ref_to_json

if TYPE_CHECKING:
    from ..state import WebUIState


class MemoryService:
    def __init__(self, state: WebUIState):
        self.state = state

    async def get_memory(self, request: web.Request) -> web.Response:
        return self.state._json(self.memory())

    async def post_memory(self, request: web.Request) -> web.Response:
        body = await self.state._body(request)
        content = str(body.get("content") or "")
        path = self.state.root / "memory" / "MEMORY.local.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        self.state.loop.refresh_runtime_context()
        return self.state._json({
            "path": "memory/MEMORY.local.md",
            "content": path.read_text(encoding="utf-8"),
        })

    async def get_memory_episode(self, request: web.Request) -> web.Response:
        date = request.query.get("date", "")
        if not date or ".." in date or "/" in date or "\\" in date:
            raise web.HTTPBadRequest(reason="Invalid date")
        path = self.state.root / "memory" / f"{date}.md"
        if not path.exists():
            raise web.HTTPNotFound(reason=f"Episode not found: {date}")
        return self.state._json({"date": date, "content": path.read_text(encoding="utf-8")})

    async def post_memory_episode(self, request: web.Request) -> web.Response:
        body = await self.state._body(request)
        date = str(body.get("date") or "")
        content = str(body.get("content") or "")
        if not date or ".." in date or "/" in date or "\\" in date:
            raise web.HTTPBadRequest(reason="Invalid date")
        path = self.state.root / "memory" / f"{date}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        return self.state._json({"date": date, "content": path.read_text(encoding="utf-8")})

    async def get_watchlist(self, request: web.Request) -> web.Response:
        return self.state._json(self.state.watchlist_service.payload())

    async def post_watchlist(self, request: web.Request) -> web.Response:
        body = await self.state._body(request)
        return self.state._json(self.state.watchlist_service.write(str(body.get("content") or "")))

    async def post_watchlist_check(self, request: web.Request) -> web.Response:
        self.state.watchlist_service.model_router = self.state.loop.model_router
        decision = await self.state.watchlist_service.check()
        return self.state._json({
            "decision": decision.to_dict(),
            "watchlist": self.state.watchlist_service.payload(),
        })

    async def get_tokens(self, request: web.Request) -> web.Response:
        return self.state._json(self.tokens())

    def memory(self) -> dict[str, Any]:
        memory_dir = self.state.root / "memory"
        episodes = []
        if memory_dir.exists():
            episodes = [
                self.state._rel(path)
                for path in sorted(memory_dir.glob("*.md"))
                if path.name not in {"MEMORY.md", "MEMORY.local.md"}
            ]
        turn_ids = self.state.loop.memory.load_unarchived_turn_ids()
        return {
            "long_term": self.state.loop.memory.read_memory(),
            "today_episode": self.state.loop.memory.read_today_episode(),
            "episodes": episodes,
            "tokens": self.state.loop.token_tracker.stats_by_date(),
            "tokensByModel": self.state.loop.token_tracker.stats_by_provider_model(),
            "tokensByUsageType": self.state.loop.token_tracker.stats_by_usage_type(),
            "tokenTotals": self.state.loop.token_tracker.totals(),
            "history": self.state.loop.memory.history_stats(),
            "runtime": self.state.runtime_events.stats(active_turn_ids=turn_ids),
            "schedulerMaintenance": self._scheduler_maintenance(),
            "watchlist": self.state.watchlist_service.payload(),
        }

    def tokens(self) -> dict[str, Any]:
        tracker = self.state.loop.token_tracker
        return {
            "totals": tracker.totals(),
            "byDate": tracker.stats_by_date(),
            "byModel": tracker.stats_by_provider_model(),
            "byUsageType": tracker.stats_by_usage_type(),
            "byDateModel": tracker.stats_by_date_model(),
            "byHour": tracker.stats_by_hour(),
            "streak": tracker.streak_metrics(),
            "sessions": tracker.session_count(),
            "messages": self._count_history_messages(),
            "recentCalls": tracker.recent_calls(),
            "recentCacheCalls": tracker.recent_cache_calls(),
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
        }

    def runtime(self) -> dict[str, Any]:
        turn_ids = self.state.loop.memory.load_unarchived_turn_ids()
        return {
            "latestSeq": self.state.event_seq,
            "scope": "unarchived",
            "events": self.state.runtime_events.events_for_turns(
                turn_ids,
                limit=self.state.max_event_log,
            ),
        }

    def _scheduler_maintenance(self) -> dict[str, Any]:
        jobs = [
            job for job in self.state.loop.scheduler_service.list_jobs(include_disabled=True)
            if job.protected
        ]
        return {
            "jobs": len(jobs),
            "enabled": len([job for job in jobs if job.enabled]),
            "nextRunAtMs": min(
                (job.state.next_run_at_ms for job in jobs if job.enabled and job.state.next_run_at_ms),
                default=None,
            ),
            "lastError": next(
                (job.state.last_error for job in jobs if job.state.last_status == "error" and job.state.last_error),
                None,
            ),
        }

    def unarchived_history(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for item in self.state.loop.memory.load_unarchived_history():
            role = item.get("role")
            content = item.get("content")
            if role not in {"user", "assistant"}:
                continue
            text = self._history_display_content(item, content)
            out: dict[str, Any] = {"role": role, "content": text}
            if isinstance(item.get("turn_id"), str):
                out["turn_id"] = item["turn_id"]
            ids = item.get("attachments")
            if isinstance(ids, list) and ids:
                refs = []
                for aid in ids:
                    if not isinstance(aid, str):
                        continue
                    ref = self.state.attachments.get(aid)
                    if ref is not None:
                        refs.append(ref_to_json(ref))
                if refs:
                    out["attachments"] = refs
            items.append(out)
        return items

    def _count_history_messages(self) -> int:
        history_file = self.state.loop.memory.history_file
        if not history_file.exists():
            return 0
        count = 0
        try:
            with history_file.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if row.get("role") in {"user", "assistant"}:
                        count += 1
        except OSError as exc:
            logger.warning(f"history.jsonl read failed: {exc}")
        return count

    def _history_display_content(self, item: dict[str, Any], content: Any) -> str:
        display = item.get("displayContent")
        if isinstance(display, str):
            return display
        text = self._extract_text_content(content)
        if item.get("role") == "user" and isinstance(item.get("attachments"), list):
            return self._strip_attachment_sidecars(text)
        return text

    @staticmethod
    def _extract_text_content(content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
            return "".join(parts)
        return ""

    @staticmethod
    def _strip_attachment_sidecars(text: str) -> str:
        patterns = (
            r"\n*\[附件 [^\]]+ 提取文本\]\n.*?\n\[/附件 [^\]]+\]",
            r"\n*\[附件 [^\]]+ 已落盘[^\]]*\]",
            r"\n*\[图片附件 [^\]]+（当前模型未标记视觉，已忽略；可在 /model 测试视觉激活）\]",
            r"\n*\[图片附件 [^\]]+ 编码失败：[^\]]+\]",
            r"\n*\[已落盘: [^\]]+\]",
        )
        cleaned = text
        for pattern in patterns:
            cleaned = re.sub(pattern, "", cleaned, flags=re.DOTALL)
        return cleaned.strip()
