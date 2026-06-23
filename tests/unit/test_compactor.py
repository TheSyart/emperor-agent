from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from agent.compactor import Compactor
from agent.memory import MemoryStore
from agent.providers.base import LLMProvider, LLMResponse
from agent.telemetry import TokenTracker

VALID_COMPACTION = """
<episode>
## 12:00 测试压缩
- 已整理旧对话。
</episode>
<updated_memory>
# 长期记忆

已更新。
</updated_memory>
<updated_user>
# 用户偏好

保持简洁。
</updated_user>
"""


class QueueProvider(LLMProvider):
    def __init__(self, responses: list[str | Exception]):
        super().__init__(default_model="fake-model")
        self.responses = list(responses)
        self.prompts: list[str] = []

    async def chat(self, **kwargs: Any) -> LLMResponse:
        self.prompts.append(kwargs["messages"][0]["content"])
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return LLMResponse(content=item, usage={"input": 3, "output": 2})


def _memory(tmp_path: Path) -> MemoryStore:
    user_file = tmp_path / "templates" / "USER.local.md"
    user_file.parent.mkdir(parents=True)
    user_file.write_text("# 用户偏好\n\n原始。\n", encoding="utf-8")
    store = MemoryStore(tmp_path / "memory", user_file)
    store.write_memory("# 长期记忆\n\n原始。\n")
    return store


def _history(size: int = 12) -> list[dict[str, str]]:
    return [{"role": "user", "content": f"turn {idx}"} for idx in range(size)]


def test_compactor_repairs_missing_xml_tags_before_writing(tmp_path: Path) -> None:
    provider = QueueProvider([
        "<episode>only episode</episode><updated_memory>new</updated_memory>",
        VALID_COMPACTION,
    ])
    tracker = TokenTracker(tmp_path / "memory" / "tokens.jsonl")
    store = _memory(tmp_path)
    compactor = Compactor(provider, "fake-model", store, token_tracker=tracker)

    recent = asyncio.run(compactor.compact_async(_history()))

    assert len(recent) == compactor.K
    assert len(provider.prompts) == 2
    assert "Invalid response" in provider.prompts[1]
    assert "已更新" in store.read_memory()
    assert "保持简洁" in store.read_user()
    assert "测试压缩" in store.read_today_episode()
    rows = [
        json.loads(line)
        for line in (tmp_path / "memory" / "tokens.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert rows[-1]["route_reason"] == "memory_compaction"
    assert rows[-1]["estimated_input_tokens"] > 0


def test_compactor_preserves_memory_when_repair_still_invalid(tmp_path: Path) -> None:
    provider = QueueProvider([
        "<episode>only episode</episode>",
        "<updated_memory>missing other tags</updated_memory>",
    ])
    store = _memory(tmp_path)
    compactor = Compactor(provider, "fake-model", store)
    history = _history()

    result = asyncio.run(compactor.compact_async(history))

    assert result == history
    assert "原始" in store.read_memory()
    assert "原始" in store.read_user()
    diagnostics = store.memory_dir / "compact_diagnostics.jsonl"
    assert diagnostics.exists()
    payload = json.loads(diagnostics.read_text(encoding="utf-8").splitlines()[-1])
    assert payload["event"] == "compact_parse_failed"
    assert "episode" in payload["missing_tags"]


def test_compactor_prompt_includes_runtime_context_attachment(tmp_path: Path) -> None:
    provider = QueueProvider([VALID_COMPACTION])
    store = _memory(tmp_path)
    compactor = Compactor(
        provider,
        "fake-model",
        store,
        runtime_context_provider=lambda messages: {
            "role": "system",
            "content": "[PLAN_RUNTIME_CONTEXT]\nplan_id: plan_1\nactive_step: step_1",
        },
    )

    asyncio.run(compactor.compact_async(_history()))

    assert "[PLAN_RUNTIME_CONTEXT]" in provider.prompts[0]
    assert "plan_id: plan_1" in provider.prompts[0]
