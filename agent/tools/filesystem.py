"""File system tools: read, write, edit, list."""
from __future__ import annotations

import difflib
import re
import stat
from io import BytesIO
from pathlib import Path
from typing import Any

from loguru import logger

from .base import Tool, tool_parameters
from .context import ToolExecutionContext
from .results import ToolArtifact, ToolResult


class _FsTool(Tool):
    _IGNORE_DIRS = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
    }

    def __init__(self, workspace: Path | object | None = None):
        self._workspace = workspace

    def _workspace_root(self) -> Path | None:
        if self._workspace is None:
            return None
        path = getattr(self._workspace, "path", None)
        if path is not None:
            return Path(path).resolve()
        return Path(self._workspace).resolve()  # type: ignore[arg-type]

    def _resolve(self, path: str) -> Path:
        p = Path(path).expanduser()
        workspace = self._workspace_root()
        if not p.is_absolute() and workspace:
            p = workspace / p
        p = p.resolve()
        if workspace is not None:
            ws = workspace.resolve()
            try:
                p.relative_to(ws)
            except ValueError as exc:
                raise ValueError(
                    f"Path outside workspace: {path} -> {p} "
                    f"(workspace: {ws})"
                ) from exc
        return p

    def _display_path(self, path: Path) -> str:
        workspace = self._workspace_root()
        if workspace:
            try:
                return path.relative_to(workspace).as_posix()
            except ValueError:
                pass
        return path.as_posix()


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
    description = "安全读取文本/PDF/附件 sidecar 内容，支持 offset/limit 分页。输出格式：行号|内容。"
    max_result_chars = 24_000
    _DEFAULT_LIMIT = 2000
    _MAX_CHARS = 128_000
    _MAX_FILE_BYTES = 5 * 1024 * 1024

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
                mode = fp.stat().st_mode
            except OSError as exc:
                return f"Error: Cannot stat file: {exc}"
            if not stat.S_ISREG(mode):
                return f"Error: Not a regular file: {path}"

            read_path = _sidecar_path(fp) or fp
            size = read_path.stat().st_size
            if size > self._MAX_FILE_BYTES:
                return (
                    f"Error: File too large: {read_path} has {size} bytes "
                    f"(limit {self._MAX_FILE_BYTES})"
                )

            text = _read_text_like(read_path)
            if text is None:
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
            logger.warning(f"[read_file] {e}")
            return f"Error reading file: {e}"

    def map_result(self, result: Any, context: ToolExecutionContext) -> ToolResult:
        text = str(result)
        if text.startswith("Error:"):
            return ToolResult.from_text(text, is_error=True)
        args = context.arguments or {}
        requested_path = str(args.get("path") or "")
        display_path = requested_path
        byte_size: int | None = None
        try:
            resolved = self._resolve(requested_path)
            display_path = self._display_path(resolved)
            read_path = _sidecar_path(resolved) or resolved
            byte_size = read_path.stat().st_size
        except Exception as exc:
            logger.debug(f"[read_file.map_result] metadata fallback for {requested_path}: {exc}")

        line_start, line_end, total_lines, truncated = _read_file_line_metadata(text)
        summary = (
            f"read_file {display_path} lines {line_start}-{line_end} of {total_lines}"
            if line_start and line_end and total_lines
            else f"read_file {display_path} ({len(text)} chars)"
        )
        metadata: dict[str, Any] = {
            "tool": "read_file",
            "path": display_path,
            "line_start": line_start,
            "line_end": line_end,
            "total_lines": total_lines,
            "truncated": truncated,
        }
        metadata = {key: value for key, value in metadata.items() if value is not None}
        return ToolResult(
            model_content=text,
            display_summary=summary,
            raw_content=text,
            artifacts=[ToolArtifact(path=display_path, kind="source_file", bytes=byte_size)],
            metadata=metadata,
        )


def _read_file_line_metadata(text: str) -> tuple[int | None, int | None, int | None, bool]:
    showing = re.search(r"\(Showing lines (\d+)-(\d+) of (\d+)\.", text)
    if showing:
        return int(showing.group(1)), int(showing.group(2)), int(showing.group(3)), True
    end = re.search(r"\(End of file .+?(\d+) lines total\)", text)
    if end:
        total = int(end.group(1))
        numbered = [
            line for line in text.splitlines()
            if re.match(r"^\d+\|", line)
        ]
        line_start = _line_number_from_numbered_line(numbered[0]) if numbered else None
        line_end = _line_number_from_numbered_line(numbered[-1]) if numbered else None
        return line_start, line_end, total, False
    return None, None, None, False


def _line_number_from_numbered_line(line: str) -> int | None:
    match = re.match(r"^(\d+)\|", line)
    return int(match.group(1)) if match else None


def _sidecar_path(path: Path) -> Path | None:
    if path.name.endswith(".txt"):
        return None
    sidecar = path.with_name(path.name + ".txt")
    return sidecar if sidecar.is_file() else None


def _read_text_like(path: Path) -> str | None:
    if path.suffix.lower() == ".pdf":
        return _extract_pdf_text(path.read_bytes())
    try:
        return path.read_text(encoding="utf-8").replace("\r\n", "\n")
    except UnicodeDecodeError:
        return None


def _extract_pdf_text(raw: bytes) -> str | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        logger.warning("pypdf not installed; PDF text extraction skipped")
        return None
    try:
        reader = PdfReader(BytesIO(raw))
        parts = []
        for page in reader.pages:
            try:
                parts.append(page.extract_text() or "")
            except Exception as exc:
                logger.debug(f"pdf page extract failed: {exc}")
        text = "\n\n".join(part for part in parts if part).strip()
        return text or None
    except Exception as exc:
        logger.warning(f"pdf parse failed: {exc}")
        return None


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
        self._last_write_result = None
        try:
            fp = self._resolve(path)
            existed = fp.is_file()
            before = ""
            if existed:
                try:
                    before = fp.read_text(encoding="utf-8").replace("\r\n", "\n")
                except UnicodeDecodeError:
                    before = ""
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(content, encoding="utf-8")
            display_path = self._display_path(fp)
            after = content.replace("\r\n", "\n")
            self._last_write_result = {
                "path": display_path,
                "content_chars": len(content),
                "content_bytes": len(content.encode("utf-8")),
                "file_bytes": fp.stat().st_size,
                "operation": "overwrote" if existed else "created",
                "diff": _unified_text_diff(
                    before,
                    after,
                    before_label=f"{display_path} (before)" if existed else "/dev/null",
                    after_label=display_path,
                ),
            }
            return f"Successfully wrote {len(content)} characters to {fp}"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            logger.warning(f"[write_file] {e}")
            return f"Error writing file: {e}"

    def map_result(self, result: Any, context: ToolExecutionContext) -> ToolResult:
        text = str(result)
        if text.startswith("Error:"):
            return ToolResult.from_text(text, is_error=True)
        args = context.arguments or {}
        path = str(args.get("path") or "")
        record = getattr(self, "_last_write_result", None) or {}
        display_path = str(record.get("path") or path)
        content = str(args.get("content") or "")
        metadata = {
            "tool": "write_file",
            "path": display_path,
            "operation": record.get("operation") or "wrote",
            "content_chars": record.get("content_chars", len(content)),
            "content_bytes": record.get("content_bytes", len(content.encode("utf-8"))),
            "diff": record.get("diff") or _unified_text_diff(
                "",
                content,
                before_label="/dev/null",
                after_label=display_path,
            ),
        }
        return ToolResult(
            model_content=text,
            display_summary=f"write_file {display_path} ({metadata['content_chars']} chars)",
            raw_content=text,
            artifacts=[
                ToolArtifact(
                    path=display_path,
                    kind="source_file",
                    bytes=_optional_int(record.get("file_bytes")),
                )
            ],
            metadata=metadata,
        )


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
    stripped_old = [prep(line) for line in old_lines]
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


def _unified_text_diff(
    before: str,
    after: str,
    *,
    before_label: str,
    after_label: str,
) -> str:
    return "".join(difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=before_label,
        tofile=after_label,
    ))


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


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
        self._last_edit_result = None
        try:
            fp = self._resolve(path)
            if not fp.exists():
                if old_text == "":
                    fp.parent.mkdir(parents=True, exist_ok=True)
                    fp.write_text(new_text, encoding="utf-8")
                    display_path = self._display_path(fp)
                    self._last_edit_result = {
                        "path": display_path,
                        "operation": "created",
                        "replacements": 0,
                        "replace_all": bool(replace_all),
                        "file_bytes": fp.stat().st_size,
                        "diff": _unified_text_diff(
                            "",
                            new_text.replace("\r\n", "\n"),
                            before_label="/dev/null",
                            after_label=display_path,
                        ),
                    }
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
                display_path = self._display_path(fp)
                self._last_edit_result = {
                    "path": display_path,
                    "operation": "edited",
                    "replacements": 0,
                    "replace_all": bool(replace_all),
                    "file_bytes": fp.stat().st_size,
                    "diff": _unified_text_diff(
                        content,
                        new_text.replace("\r\n", "\n"),
                        before_label=f"{display_path} (before)",
                        after_label=f"{display_path} (after)",
                    ),
                }
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
            display_path = self._display_path(fp)
            normalized_new_content = new_content.replace("\r\n", "\n")
            self._last_edit_result = {
                "path": display_path,
                "operation": "edited",
                "replacements": len(selected),
                "replace_all": bool(replace_all),
                "file_bytes": fp.stat().st_size,
                "diff": _unified_text_diff(
                    content,
                    normalized_new_content,
                    before_label=f"{display_path} (before)",
                    after_label=f"{display_path} (after)",
                ),
            }
            return f"Successfully edited {fp}"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            logger.warning(f"[edit_file] {e}")
            return f"Error editing file: {e}"

    def map_result(self, result: Any, context: ToolExecutionContext) -> ToolResult:
        text = str(result)
        if text.startswith("Error:") or text.startswith("Warning:"):
            return ToolResult.from_text(text, is_error=text.startswith("Error:"))
        args = context.arguments or {}
        path = str(args.get("path") or "")
        record = getattr(self, "_last_edit_result", None) or {}
        display_path = str(record.get("path") or path)
        replacements = _optional_int(record.get("replacements")) or 0
        label = "replacement" if replacements == 1 else "replacements"
        summary = (
            f"edit_file {display_path} (created)"
            if record.get("operation") == "created"
            else f"edit_file {display_path} ({replacements} {label})"
        )
        metadata = {
            "tool": "edit_file",
            "path": display_path,
            "operation": record.get("operation") or "edited",
            "replacements": replacements,
            "replace_all": bool(args.get("replace_all", False)),
            "diff": record.get("diff") or "",
        }
        return ToolResult(
            model_content=text,
            display_summary=summary,
            raw_content=text,
            artifacts=[
                ToolArtifact(
                    path=display_path,
                    kind="source_file",
                    bytes=_optional_int(record.get("file_bytes")),
                )
            ],
            metadata=metadata,
        )
