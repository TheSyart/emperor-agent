"""File system tools: read, write, edit, list."""
from __future__ import annotations

import difflib
import os
from pathlib import Path
from typing import Any

from .base import Tool, tool_parameters


class _FsTool(Tool):
    _IGNORE_DIRS = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
    }

    def __init__(self, workspace: Path | None = None):
        self._workspace = workspace

    def _resolve(self, path: str) -> Path:
        p = Path(path).expanduser()
        if not p.is_absolute() and self._workspace:
            p = self._workspace / p
        return p.resolve()


@tool_parameters({
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "文件路径"},
        "offset": {"type": "integer", "description": "起始行号（从1开始，默认1）", "minimum": 1},
        "limit": {"type": "integer", "description": "最大读取行数（默认2000）", "minimum": 1},
    },
    "required": ["path"],
})
class ReadFileTool(_FsTool):
    name = "read_file"
    description = "读取文本文件内容，支持 offset/limit 分页。输出格式：行号|内容。"
    _DEFAULT_LIMIT = 2000
    _MAX_CHARS = 128_000

    @property
    def read_only(self) -> bool:
        return True

    def execute(self, path: str, offset: int = 1, limit: int | None = None, **kwargs: Any) -> str:
        try:
            fp = self._resolve(path)
            if not fp.exists():
                return f"Error: File not found: {path}"
            if not fp.is_file():
                return f"Error: Not a file: {path}"

            try:
                text = fp.read_text(encoding="utf-8").replace("\r\n", "\n")
            except UnicodeDecodeError:
                return f"Error: Cannot read binary file: {path}"

            lines = text.splitlines()
            total = len(lines)
            if offset < 1:
                offset = 1
            if offset > total:
                return f"Error: offset {offset} is beyond end of file ({total} lines)"

            start = offset - 1
            end = min(start + (limit or self._DEFAULT_LIMIT), total)
            numbered = [f"{start + i + 1}| {line}" for i, line in enumerate(lines[start:end])]
            result = "\n".join(numbered)

            if len(result) > self._MAX_CHARS:
                trimmed, chars = [], 0
                for line in numbered:
                    chars += len(line) + 1
                    if chars > self._MAX_CHARS:
                        break
                    trimmed.append(line)
                end = start + len(trimmed)
                result = "\n".join(trimmed)

            if end < total:
                result += f"\n\n(Showing lines {offset}-{end} of {total}. Use offset={end + 1} to continue.)"
            else:
                result += f"\n\n(End of file — {total} lines total)"
            return result
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error reading file: {e}"


@tool_parameters({
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "文件路径"},
        "content": {"type": "string", "description": "写入内容"},
    },
    "required": ["path", "content"],
})
class WriteFileTool(_FsTool):
    name = "write_file"
    description = "写入文件（覆盖已有内容）。部分编辑请用 edit_file。"

    def execute(self, path: str, content: str, **kwargs: Any) -> str:
        try:
            fp = self._resolve(path)
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(content, encoding="utf-8")
            return f"Successfully wrote {len(content)} characters to {fp}"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error writing file: {e}"


# ---------------------------------------------------------------------------
# EditFileTool — smart text replacement with fallback matching
# ---------------------------------------------------------------------------

_QUOTE_TABLE = str.maketrans({
    "\u2018": "'", "\u2019": "'",
    "\u201c": '"', "\u201d": '"',
})


def _normalize_quotes(s: str) -> str:
    return s.translate(_QUOTE_TABLE)


def _find_exact(content: str, old: str) -> list[tuple[int, int]]:
    matches, start = [], 0
    while True:
        idx = content.find(old, start)
        if idx == -1:
            break
        matches.append((idx, idx + len(old)))
        start = idx + max(1, len(old))
    return matches


def _find_trimmed(content: str, old: str, normalize: bool = False) -> list[tuple[int, int]]:
    old_lines = old.splitlines()
    if not old_lines:
        return []
    content_lines = content.splitlines(keepends=True)
    if len(content_lines) < len(old_lines):
        return []

    offsets, pos = [], 0
    for line in content_lines:
        offsets.append(pos)
        pos += len(line)
    offsets.append(pos)

    prep = (lambda s: _normalize_quotes(s.strip())) if normalize else str.strip
    stripped_old = [prep(l) for l in old_lines]
    w = len(old_lines)
    matches = []
    for i in range(len(content_lines) - w + 1):
        window = [prep(content_lines[i + j].rstrip("\n\r")) for j in range(w)]
        if window != stripped_old:
            continue
        start = offsets[i]
        end = offsets[i + w]
        if content_lines[i + w - 1].endswith("\n"):
            end -= 1
        matches.append((start, end))
    return matches


def _find_matches(content: str, old: str) -> list[tuple[int, int]]:
    for finder in (
        lambda: _find_exact(content, old),
        lambda: _find_trimmed(content, old),
        lambda: _find_trimmed(content, old, normalize=True),
    ):
        m = finder()
        if m:
            return m
    return []


def _best_window(old: str, content: str) -> tuple[float, int]:
    lines = content.splitlines(keepends=True)
    old_lines = old.splitlines(keepends=True)
    w = max(1, len(old_lines))
    best_ratio, best_start = -1.0, 0
    for i in range(max(1, len(lines) - w + 1)):
        ratio = difflib.SequenceMatcher(None, old_lines, lines[i:i + w]).ratio()
        if ratio > best_ratio:
            best_ratio, best_start = ratio, i
    return best_ratio, best_start


@tool_parameters({
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "文件路径"},
        "old_text": {"type": "string", "description": "要替换的文本"},
        "new_text": {"type": "string", "description": "替换后的文本"},
        "replace_all": {"type": "boolean", "description": "替换所有匹配项（默认 false）"},
    },
    "required": ["path", "old_text", "new_text"],
})
class EditFileTool(_FsTool):
    name = "edit_file"
    description = (
        "替换文件中的文本。容忍缩进差异和引号风格差异。"
        "若 old_text 匹配多处，需提供更多上下文或设 replace_all=true。"
    )

    def execute(
        self, path: str, old_text: str, new_text: str,
        replace_all: bool = False, **kwargs: Any,
    ) -> str:
        try:
            fp = self._resolve(path)
            if not fp.exists():
                if old_text == "":
                    fp.parent.mkdir(parents=True, exist_ok=True)
                    fp.write_text(new_text, encoding="utf-8")
                    return f"Successfully created {fp}"
                return f"Error: File not found: {path}"

            raw = fp.read_bytes()
            uses_crlf = b"\r\n" in raw
            content = raw.decode("utf-8").replace("\r\n", "\n")
            norm_old = old_text.replace("\r\n", "\n")

            if old_text == "":
                if content.strip():
                    return f"Error: Cannot create file — {path} already exists and is not empty."
                fp.write_text(new_text, encoding="utf-8")
                return f"Successfully edited {fp}"

            matches = _find_matches(content, norm_old)
            if not matches:
                ratio, start = _best_window(norm_old, content)
                if ratio > 0.5:
                    best_lines = content.splitlines(keepends=True)
                    w = max(1, len(norm_old.splitlines()))
                    diff = "".join(difflib.unified_diff(
                        norm_old.splitlines(keepends=True),
                        best_lines[start:start + w],
                        fromfile="old_text (provided)",
                        tofile=f"{path} (actual, line {start + 1})",
                    ))
                    return f"Error: old_text not found in {path}.\nBest match ({ratio:.0%}) at line {start + 1}:\n{diff}"
                return f"Error: old_text not found in {path}."

            if len(matches) > 1 and not replace_all:
                lines = [content.count('\n', 0, s) + 1 for s, _ in matches]
                preview = ", ".join(f"line {n}" for n in lines[:3])
                return f"Warning: old_text appears {len(matches)} times at {preview}. Set replace_all=true or add more context."

            norm_new = new_text.replace("\r\n", "\n")
            selected = matches if replace_all else matches[:1]
            new_content = content
            for start, end in reversed(selected):
                actual = new_content[start:end]
                replacement = norm_new
                # consume trailing newline when deleting a line
                if replacement == "" and not actual.endswith("\n") and new_content[end:end + 1] == "\n":
                    end += 1
                new_content = new_content[:start] + replacement + new_content[end:]

            if uses_crlf:
                new_content = new_content.replace("\n", "\r\n")
            fp.write_bytes(new_content.encode("utf-8"))
            return f"Successfully edited {fp}"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error editing file: {e}"
