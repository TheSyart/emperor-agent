from __future__ import annotations
import re
import urllib.request
from html.parser import HTMLParser

from .base import Tool
from .schema import StringSchema, IntegerSchema


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts: list[str] = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip = True

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = False
        if tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4"):
            self._parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self._parts.append(data)

    def get_text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", "".join(self._parts)).strip()


def _fetch(url: str, extract_mode: str = "text", max_chars: int = 8000) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return f"Error fetching {url}: {e}"

    if extract_mode == "text":
        parser = _TextExtractor()
        parser.feed(raw)
        text = parser.get_text()
    else:
        text = raw

    return text[:max_chars]


class WebFetch(Tool):
    name = "web_fetch"
    description = "获取指定 URL 的网页内容，支持文本提取模式"
    read_only = True

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "url":          StringSchema("要访问的完整 URL").to_json_schema(),
                "extract_mode": StringSchema(
                    "提取模式：text（纯文本，默认）或 raw（原始 HTML）",
                    enum=["text", "raw"],
                ).to_json_schema(),
                "max_chars":    IntegerSchema(
                    "最大返回字符数，默认 8000", minimum=1,
                ).to_json_schema(),
            },
            "required": ["url"],
        }

    def execute(self, url: str, extract_mode: str = "text", max_chars: int = 8000) -> str:
        print(f"[网页获取]: {url}")
        return _fetch(url, extract_mode, max_chars)
