"""附件存储 + mime 校验 + PDF / 文本抽取 + 引用读写。

存储位置：`memory/attachments/YYYY-MM/{hash8}-{safe_name}.{ext}`
sidecar 文本（PDF / text/csv/json）：同目录 `<file>.txt`

ID 形如 `att_2026-05_abc12345`，反查时按 `month + hash8 + 任意名` 走 glob。
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections import OrderedDict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

from loguru import logger


_UTC8 = timezone(timedelta(hours=8))

ALLOWED_IMAGE_MIMES: frozenset[str] = frozenset({
    "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
})
ALLOWED_DOC_MIMES: frozenset[str] = frozenset({
    "application/pdf",
    "application/json",
    "text/csv",
    "text/plain",
    "text/markdown",
    "text/x-markdown",
})

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_DOC_BYTES = 25 * 1024 * 1024
TEXT_INLINE_LIMIT = 50_000           # sidecar 内联到 prompt 的字符上限
SIDECAR_SUFFIX = ".txt"

_EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/csv": "csv",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/x-markdown": "md",
}


@dataclass(frozen=True)
class AttachmentRef:
    id: str
    name: str
    mime: str
    size: int
    kind: str             # 'image' | 'document' | 'text'
    has_text: bool
    has_image: bool
    rel_path: str         # 相对仓库根
    text_rel_path: str | None


class AttachmentStore:
    """单用户本地工具，无并发问题；用 LRU 缓存 ref 反查避免反复 glob。"""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.base = self.root / "memory" / "attachments"
        self.base.mkdir(parents=True, exist_ok=True)
        self._cache: "OrderedDict[str, AttachmentRef]" = OrderedDict()
        self._cache_max = 64

    # ─── 写入 ─────────────────────────────────────────────
    def save(self, *, raw: bytes, name: str, mime: str) -> AttachmentRef:
        mime_l = (mime or "").lower().strip()
        is_image = mime_l in ALLOWED_IMAGE_MIMES
        is_doc = mime_l in ALLOWED_DOC_MIMES
        if not (is_image or is_doc):
            raise ValueError(f"unsupported mime: {mime_l!r}")

        size = len(raw)
        limit = MAX_IMAGE_BYTES if is_image else MAX_DOC_BYTES
        if size > limit:
            raise ValueError(
                f"file too large: {size} bytes (limit {limit} for {'image' if is_image else 'document'})"
            )

        hash8 = hashlib.sha256(raw).hexdigest()[:8]
        month = datetime.now(_UTC8).strftime("%Y-%m")
        ext = _EXT_BY_MIME.get(mime_l) or _ext_from_name(name) or "bin"
        safe = _safe_name(name)
        rel_dir = Path("memory") / "attachments" / month
        abs_dir = self.root / rel_dir
        abs_dir.mkdir(parents=True, exist_ok=True)
        file_name = f"{hash8}-{safe}.{ext}" if not safe.lower().endswith(f".{ext}") else f"{hash8}-{safe}"
        abs_path = abs_dir / file_name
        rel_path = (rel_dir / file_name).as_posix()
        if not abs_path.exists():
            abs_path.write_bytes(raw)

        text_rel: str | None = None
        has_text = False
        kind: str
        if is_image:
            kind = "image"
        else:
            # 文档：尝试抽文本
            text: str | None = None
            if mime_l == "application/pdf":
                text = _extract_pdf_text(raw)
                kind = "document"
            else:
                # text/* / json / csv → 直接 decode
                try:
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    text = None
                kind = "text"
            if text and text.strip():
                sidecar_name = file_name + SIDECAR_SUFFIX
                sidecar_abs = abs_dir / sidecar_name
                try:
                    sidecar_abs.write_text(text, encoding="utf-8")
                    text_rel = (rel_dir / sidecar_name).as_posix()
                    has_text = True
                except OSError as exc:
                    logger.warning(f"sidecar write failed for {file_name}: {exc}")

        ref = AttachmentRef(
            id=f"att_{month}_{hash8}",
            name=name or file_name,
            mime=mime_l,
            size=size,
            kind=kind,
            has_text=has_text,
            has_image=is_image,
            rel_path=rel_path,
            text_rel_path=text_rel,
        )
        self._cache_put(ref)
        return ref

    # ─── 读取 ─────────────────────────────────────────────
    def get(self, att_id: str) -> AttachmentRef | None:
        if not att_id or not att_id.startswith("att_"):
            return None
        cached = self._cache.get(att_id)
        if cached is not None:
            self._cache.move_to_end(att_id)
            return cached
        # att_2026-05_abc12345
        try:
            _, month, hash8 = att_id.split("_", 2)
        except ValueError:
            return None
        if not re.fullmatch(r"\d{4}-\d{2}", month) or not re.fullmatch(r"[0-9a-f]{8}", hash8):
            return None
        month_dir = self.base / month
        if not month_dir.is_dir():
            return None
        # 找 hash8-* 文件（排除 sidecar .txt）
        for path in month_dir.glob(f"{hash8}-*"):
            if path.name.endswith(SIDECAR_SUFFIX) and (path.with_name(path.name[: -len(SIDECAR_SUFFIX)])).exists():
                continue
            if not path.is_file():
                continue
            ref = self._build_ref_from_path(att_id, path)
            self._cache_put(ref)
            return ref
        return None

    def read_bytes(self, ref: AttachmentRef) -> bytes:
        return (self.root / ref.rel_path).read_bytes()

    def read_text(self, ref: AttachmentRef, limit: int = TEXT_INLINE_LIMIT) -> str:
        if not ref.has_text or not ref.text_rel_path:
            return ""
        path = self.root / ref.text_rel_path
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return ""
        if len(text) <= limit:
            return text
        head = text[: limit - 200]
        tail = text[-200:]
        return f"{head}\n...[truncated, total {len(text)} chars]...\n{tail}"

    # ─── 内部 ─────────────────────────────────────────────
    def _build_ref_from_path(self, att_id: str, abs_path: Path) -> AttachmentRef:
        rel_dir = abs_path.parent.relative_to(self.root).as_posix()
        rel_path = f"{rel_dir}/{abs_path.name}"
        sidecar = abs_path.with_name(abs_path.name + SIDECAR_SUFFIX)
        has_text = sidecar.exists()
        text_rel = f"{rel_dir}/{sidecar.name}" if has_text else None
        ext = abs_path.suffix.lower().lstrip(".")
        mime = _mime_from_ext(ext) or "application/octet-stream"
        is_image = mime in ALLOWED_IMAGE_MIMES
        kind = "image" if is_image else ("document" if mime == "application/pdf" else "text")
        size = abs_path.stat().st_size if abs_path.exists() else 0
        # 名字：去掉 hash8 前缀
        original_name = re.sub(r"^[0-9a-f]{8}-", "", abs_path.name, count=1)
        return AttachmentRef(
            id=att_id, name=original_name, mime=mime, size=size,
            kind=kind, has_text=has_text, has_image=is_image,
            rel_path=rel_path, text_rel_path=text_rel,
        )

    def _cache_put(self, ref: AttachmentRef) -> None:
        self._cache[ref.id] = ref
        self._cache.move_to_end(ref.id)
        while len(self._cache) > self._cache_max:
            self._cache.popitem(last=False)


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
        joined = "\n\n".join(p for p in parts if p).strip()
        return joined or None
    except Exception as exc:
        logger.warning(f"pdf parse failed: {exc}")
        return None


def _safe_name(name: str) -> str:
    """去掉路径分隔符与 ascii 控制字符；保 unicode（中文文件名合法）。"""
    if not name:
        return "unnamed"
    cleaned = name.replace("\\", "_").replace("/", "_")
    cleaned = "".join(ch for ch in cleaned if ch == "\t" or ord(ch) >= 32)
    cleaned = cleaned.strip(". ")
    if not cleaned:
        return "unnamed"
    if len(cleaned) > 80:
        stem, dot, ext = cleaned.rpartition(".")
        if dot and len(ext) <= 8:
            cleaned = stem[: 80 - len(ext) - 1] + "." + ext
        else:
            cleaned = cleaned[:80]
    return cleaned


def _ext_from_name(name: str) -> str | None:
    if "." not in name:
        return None
    ext = name.rsplit(".", 1)[1].lower()
    return ext if 1 <= len(ext) <= 8 and ext.isalnum() else None


def _mime_from_ext(ext: str) -> str | None:
    ext = (ext or "").lower()
    for mime, e in _EXT_BY_MIME.items():
        if e == ext:
            return mime
    return None


def encode_for_openai_block(ref: AttachmentRef, store: AttachmentStore) -> dict[str, Any]:
    """图片 → OpenAI image_url block（base64 data URL）。文档不调用此函数。"""
    if not ref.has_image:
        raise ValueError(f"attachment {ref.id} is not an image")
    raw = store.read_bytes(ref)
    b64 = base64.b64encode(raw).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{ref.mime};base64,{b64}"},
    }


def ref_to_json(ref: AttachmentRef) -> dict[str, Any]:
    """前端 AttachmentRef shape（camelCase）。"""
    return {
        "id": ref.id,
        "name": ref.name,
        "mime": ref.mime,
        "size": ref.size,
        "kind": ref.kind,
        "hasText": ref.has_text,
        "hasImage": ref.has_image,
        "path": ref.rel_path,
        "textPath": ref.text_rel_path,
    }
