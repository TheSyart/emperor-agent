from agent.tasks.sidechain import SidechainTranscript


def test_sidechain_appends_and_reads_pages(tmp_path) -> None:
    transcript = SidechainTranscript(tmp_path, "task_1")
    transcript.append({"role": "user", "content": "start"})
    transcript.append({"role": "assistant", "content": "done"})

    page = transcript.read(offset=0, limit=10)

    assert page["nextOffset"] == 2
    assert [item["role"] for item in page["messages"]] == ["user", "assistant"]


def test_sidechain_skips_bad_lines(tmp_path) -> None:
    transcript = SidechainTranscript(tmp_path, "task_1")
    transcript.path.parent.mkdir(parents=True, exist_ok=True)
    transcript.path.write_text('{"role":"user","content":"ok"}\n{bad json}\n', encoding="utf-8")

    page = transcript.read(offset=0, limit=10)

    assert len(page["messages"]) == 1
    assert page["messages"][0]["content"] == "ok"
