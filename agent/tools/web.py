from __future__ import annotations

import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from loguru import logger

from .base import Tool
from .schema import IntegerSchema, StringSchema

_MAX_RESPONSE_BYTES = 1_000_000
_MAX_REDIRECTS = 5
_BLOCKED_HOSTS = {"localhost", "localhost.localdomain"}


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
    try:
        _validate_public_http_url(url)
    except ValueError as exc:
        return f"Error fetching {url}: {exc}"

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})  # noqa: S310 - URL is validated before request construction.
    try:
        opener = urllib.request.build_opener(_SafeRedirectHandler)
        with opener.open(req, timeout=10) as resp:
            content_type = (resp.headers.get("Content-Type") or "").split(";")[0].lower()
            if content_type and not _is_textual_content_type(content_type):
                return f"Error fetching {url}: unsupported content-type: {content_type}"
            data = resp.read(_MAX_RESPONSE_BYTES + 1)
            if len(data) > _MAX_RESPONSE_BYTES:
                return f"Error fetching {url}: response too large (>{_MAX_RESPONSE_BYTES} bytes)"
            charset = resp.headers.get_content_charset() or "utf-8"
            raw = data.decode(charset, errors="replace")
    except urllib.error.HTTPError as e:
        logger.warning(f"Web fetch failed: {url}: HTTP {e.code}")
        return f"Error fetching {url}: HTTP {e.code}"
    except Exception as e:
        logger.warning(f"Web fetch failed: {url}: {e}")
        return f"Error fetching {url}: {e}"

    if extract_mode == "text":
        parser = _TextExtractor()
        parser.feed(raw)
        text = parser.get_text()
    else:
        text = raw

    return text[:max_chars]


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        old_count = getattr(req, "redirect_dict", {}).get(newurl, 0)
        if old_count >= _MAX_REDIRECTS:
            raise ValueError("too many redirects")
        _validate_public_http_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _validate_public_http_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("only http/https URLs are allowed")
    if not parsed.hostname:
        raise ValueError("URL host is required")
    host = parsed.hostname.strip().lower().rstrip(".")
    if host in _BLOCKED_HOSTS:
        raise ValueError(f"blocked host: {host}")
    if "%" in host:
        raise ValueError("zone identifiers are not allowed in hosts")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ips = _resolve_host_ips(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    else:
        ips = [ip]
    for ip in ips:
        if _is_blocked_ip(ip):
            raise ValueError(f"blocked non-public address: {ip}")


def _resolve_host_ips(host: str, port: int) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"host resolution failed: {exc}") from exc
    ips = []
    for info in infos:
        address = info[4][0]
        try:
            ips.append(ipaddress.ip_address(address))
        except ValueError:
            continue
    if not ips:
        raise ValueError("host resolved to no addresses")
    return ips


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return any((
        ip.is_private,
        ip.is_loopback,
        ip.is_link_local,
        ip.is_multicast,
        ip.is_reserved,
        ip.is_unspecified,
    ))


def _is_textual_content_type(content_type: str) -> bool:
    return (
        content_type.startswith("text/")
        or content_type in {
            "application/json",
            "application/ld+json",
            "application/xml",
            "application/xhtml+xml",
            "application/rss+xml",
            "application/atom+xml",
        }
    )


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
        logger.info(f"[网页获取]: {url}")
        return _fetch(url, extract_mode, max_chars)
