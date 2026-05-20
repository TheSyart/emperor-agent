"""Tests for filesystem tools path resolution and workspace fence."""

from pathlib import Path

import pytest

from agent.tools import filesystem
from agent.tools.filesystem import ReadFileTool, WriteFileTool


class TestResolvePath:
    """Verify path resolution respects workspace boundaries."""

    def test_relative_path_within_workspace(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        result = tool._resolve("foo/bar.txt")
        assert result == (tmp_path / "foo" / "bar.txt").resolve()

    def test_absolute_path_allowed_when_no_workspace(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=None)
        target = tmp_path / "test.txt"
        result = tool._resolve(str(target))
        assert result == target.resolve()

    def test_path_traversal_blocked(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        with pytest.raises(ValueError, match="Path outside workspace"):
            tool._resolve("../escaped.txt")

    def test_deep_traversal_blocked(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        with pytest.raises(ValueError, match="Path outside workspace"):
            tool._resolve("foo/../../../etc/passwd")

    def test_absolute_path_blocked_with_workspace(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        with pytest.raises(ValueError, match="Path outside workspace"):
            tool._resolve("/etc/passwd")

    def test_expanduser_blocked(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        with pytest.raises(ValueError, match="Path outside workspace"):
            tool._resolve("~/.ssh/id_rsa")


class TestReadFileTool:
    """Verify read_file tool operations."""

    def test_read_file(self, tmp_path: Path) -> None:
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello world\nline 2\n")
        tool = ReadFileTool(workspace=tmp_path)
        result = tool.execute(path="test.txt")
        assert "hello world" in result

    def test_read_nonexistent_file(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        result = tool.execute(path="does_not_exist.txt")
        assert result.startswith("Error")

    def test_read_outside_workspace(self, tmp_path: Path) -> None:
        tool = ReadFileTool(workspace=tmp_path)
        result = tool.execute(path="/etc/passwd")
        assert result.startswith("Error")

    def test_read_uses_attachment_sidecar_first(self, tmp_path: Path) -> None:
        original = tmp_path / "sample.pdf"
        sidecar = tmp_path / "sample.pdf.txt"
        original.write_bytes(b"%PDF binary")
        sidecar.write_text("extracted text\n")
        tool = ReadFileTool(workspace=tmp_path)

        result = tool.execute(path="sample.pdf")

        assert "extracted text" in result

    def test_read_pdf_extracts_text(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        pdf = tmp_path / "sample.pdf"
        pdf.write_bytes(b"%PDF fake")
        monkeypatch.setattr(filesystem, "_extract_pdf_text", lambda raw: "pdf text")
        tool = ReadFileTool(workspace=tmp_path)

        result = tool.execute(path="sample.pdf")

        assert "pdf text" in result

    def test_read_rejects_large_file(self, tmp_path: Path) -> None:
        large = tmp_path / "large.txt"
        large.write_bytes(b"x" * (ReadFileTool._MAX_FILE_BYTES + 1))
        tool = ReadFileTool(workspace=tmp_path)

        result = tool.execute(path="large.txt")

        assert result.startswith("Error: File too large")

    def test_read_rejects_binary_file(self, tmp_path: Path) -> None:
        binary = tmp_path / "binary.bin"
        binary.write_bytes(b"\xff\xfe\x00\x00")
        tool = ReadFileTool(workspace=tmp_path)

        result = tool.execute(path="binary.bin")

        assert result.startswith("Error: Cannot read binary file")


class TestWriteFileTool:
    """Verify write_file tool operations."""

    def test_write_file(self, tmp_path: Path) -> None:
        tool = WriteFileTool(workspace=tmp_path)
        tool.execute(path="new_file.txt", content="hello world")
        assert (tmp_path / "new_file.txt").read_text() == "hello world"

    def test_write_outside_workspace(self, tmp_path: Path) -> None:
        tool = WriteFileTool(workspace=tmp_path)
        result = tool.execute(path="/etc/passwd", content="evil")
        assert result.startswith("Error")
