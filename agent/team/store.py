from __future__ import annotations

import json
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from .models import SCHEMA_VERSION, TeamMember, TeamStatus, validate_actor_name, validate_member_name


class TeamStore:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.team_dir = self.root / ".team"
        self.config_file = self.team_dir / "config.json"
        self.inbox_dir = self.team_dir / "inbox"
        self.threads_dir = self.team_dir / "threads"
        self.checkpoints_dir = self.team_dir / "checkpoints"
        self.cursors_dir = self.team_dir / "cursors"
        self._json_lock = RLock()
        self._ensure()
        self.mark_stale_working_offline()

    def _ensure(self) -> None:
        for path in (
            self.team_dir,
            self.inbox_dir,
            self.threads_dir,
            self.checkpoints_dir,
            self.cursors_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        if not self.config_file.exists():
            self.save_config({"version": SCHEMA_VERSION, "team_name": "default", "members": []})

    def load_config(self) -> dict[str, Any]:
        with self._json_lock:
            try:
                raw = json.loads(self.config_file.read_text(encoding="utf-8") or "{}")
            except (json.JSONDecodeError, OSError):
                raw = {}
        if not isinstance(raw, dict):
            raw = {}
        members = []
        for item in raw.get("members") or []:
            if not isinstance(item, dict):
                continue
            try:
                members.append(TeamMember.from_dict(item).to_dict())
            except ValueError:
                continue
        return {
            "version": int(raw.get("version") or SCHEMA_VERSION),
            "team_name": str(raw.get("team_name") or raw.get("teamName") or "default"),
            "members": members,
        }

    def save_config(self, config: dict[str, Any]) -> None:
        payload = {
            "version": int(config.get("version") or SCHEMA_VERSION),
            "team_name": str(config.get("team_name") or "default"),
            "members": config.get("members") or [],
        }
        with self._json_lock:
            self._atomic_write_json(self.config_file, payload)

    def list_members(self) -> list[TeamMember]:
        return [TeamMember.from_dict(item) for item in self.load_config().get("members", [])]

    def get_member(self, name: str) -> TeamMember | None:
        safe = validate_member_name(name)
        for member in self.list_members():
            if member.name == safe:
                return member
        return None

    def upsert_member(self, member: TeamMember) -> TeamMember:
        validate_member_name(member.name)
        with self._json_lock:
            config = self.load_config()
            members = []
            replaced = False
            for item in config.get("members") or []:
                current = TeamMember.from_dict(item)
                if current.name == member.name:
                    members.append(member.to_dict())
                    replaced = True
                else:
                    members.append(current.to_dict())
            if not replaced:
                members.append(member.to_dict())
            config["members"] = members
            self.save_config(config)
        return member

    def update_member(self, name: str, **fields: Any) -> TeamMember:
        with self._json_lock:
            member = self.get_member(name)
            if member is None:
                raise ValueError(f"unknown teammate: {name}")
            data = member.to_dict()
            data.update(fields)
            updated = TeamMember.from_dict(data)
            return self.upsert_member(updated)

    def mark_stale_working_offline(self) -> None:
        with self._json_lock:
            changed = False
            members = []
            for member in self.list_members():
                if member.status == TeamStatus.WORKING.value:
                    member = member.touch(status=TeamStatus.OFFLINE.value, last_error=None)
                    changed = True
                members.append(member.to_dict())
            if changed:
                config = self.load_config()
                config["members"] = members
                self.save_config(config)

    def inbox_path(self, actor: str) -> Path:
        safe = validate_actor_name(actor)
        return self.inbox_dir / f"{safe}.jsonl"

    def thread_path(self, name: str) -> Path:
        safe = validate_member_name(name)
        return self.threads_dir / f"{safe}.json"

    def checkpoint_path(self, name: str) -> Path:
        safe = validate_member_name(name)
        return self.checkpoints_dir / f"{safe}.json"

    def cursor_path(self, actor: str) -> Path:
        safe = validate_actor_name(actor)
        return self.cursors_dir / f"{safe}.json"

    def read_thread(self, name: str) -> list[dict[str, Any]]:
        path = self.thread_path(name)
        if not path.exists():
            return []
        with self._json_lock:
            try:
                raw = json.loads(path.read_text(encoding="utf-8") or "{}")
            except (json.JSONDecodeError, OSError):
                return []
        messages = raw.get("messages") if isinstance(raw, dict) else None
        return list(messages) if isinstance(messages, list) else []

    def write_thread(self, name: str, messages: list[dict[str, Any]]) -> None:
        with self._json_lock:
            self._atomic_write_json(
                self.thread_path(name),
                {"version": SCHEMA_VERSION, "member": validate_member_name(name), "messages": messages},
            )

    def read_checkpoint(self, name: str) -> list[dict[str, Any]] | None:
        payload = self.read_checkpoint_payload(name)
        if payload is None:
            return None
        return payload["messages"]

    def read_checkpoint_payload(self, name: str) -> dict[str, Any] | None:
        path = self.checkpoint_path(name)
        if not path.exists():
            return None
        with self._json_lock:
            try:
                raw = json.loads(path.read_text(encoding="utf-8") or "{}")
            except (json.JSONDecodeError, OSError):
                return None
        if isinstance(raw, list):
            messages = raw
            raw_payload: dict[str, Any] = {}
        elif isinstance(raw, dict):
            messages = raw.get("messages")
            raw_payload = raw
        else:
            return None
        if not isinstance(messages, list):
            return None

        payload: dict[str, Any] = {
            "version": int(raw_payload.get("version") or SCHEMA_VERSION),
            "member": validate_member_name(name),
            "messages": list(messages),
        }
        for key in ("pending_cursor_start", "pending_cursor_end"):
            if key in raw_payload:
                try:
                    payload[key] = max(0, int(raw_payload[key]))
                except (TypeError, ValueError):
                    pass
        ids = raw_payload.get("pending_message_ids")
        if isinstance(ids, list):
            payload["pending_message_ids"] = [str(item) for item in ids]
        return payload

    def write_checkpoint(
        self,
        name: str,
        messages: list[dict[str, Any]],
        *,
        pending_cursor_start: int | None = None,
        pending_cursor_end: int | None = None,
        pending_message_ids: list[str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "version": SCHEMA_VERSION,
            "member": validate_member_name(name),
            "messages": messages,
        }
        if pending_cursor_start is not None:
            payload["pending_cursor_start"] = max(0, int(pending_cursor_start))
        if pending_cursor_end is not None:
            payload["pending_cursor_end"] = max(0, int(pending_cursor_end))
        if pending_message_ids is not None:
            payload["pending_message_ids"] = [str(item) for item in pending_message_ids]
        with self._json_lock:
            self._atomic_write_json(self.checkpoint_path(name), payload)

    def clear_checkpoint(self, name: str) -> None:
        with self._json_lock:
            self.checkpoint_path(name).unlink(missing_ok=True)

    def read_cursor(self, actor: str) -> int:
        path = self.cursor_path(actor)
        if not path.exists():
            return 0
        with self._json_lock:
            try:
                raw = json.loads(path.read_text(encoding="utf-8") or "{}")
            except (json.JSONDecodeError, OSError):
                return 0
        return max(0, int(raw.get("inbox") or 0))

    def write_cursor(self, actor: str, offset: int) -> None:
        with self._json_lock:
            self._atomic_write_json(self.cursor_path(actor), {"inbox": max(0, int(offset))})

    @staticmethod
    def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)
