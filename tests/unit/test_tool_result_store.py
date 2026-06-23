from __future__ import annotations

from agent.context_pipeline.tool_results import ToolResultStore


def test_tool_result_store_reuses_replacement_record(tmp_path) -> None:
    store = ToolResultStore(tmp_path)
    record1 = store.persist_large_result("turn_1", "call_1", "grep", "x" * 9000, preview_chars=100)
    record2 = store.persist_large_result("turn_1", "call_1", "grep", "x" * 9000, preview_chars=100)

    assert record1 == record2
    assert record1.preview.startswith("x" * 100)
    assert (tmp_path / record1.artifact_path).exists()
