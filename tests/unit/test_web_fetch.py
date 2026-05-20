from __future__ import annotations

import ipaddress

import pytest

from agent.tools import web
from agent.tools.web import WebFetch


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/file",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://10.0.0.1",
        "http://172.16.0.1",
        "http://192.168.1.1",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/",
    ],
)
def test_web_fetch_rejects_non_public_or_non_http_urls(url: str) -> None:
    result = WebFetch().execute(url=url)
    assert result.startswith("Error fetching")


def test_validate_public_http_url_allows_public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        web,
        "_resolve_host_ips",
        lambda host, port: [ipaddress.ip_address("93.184.216.34")],
    )

    web._validate_public_http_url("https://example.com/path")


def test_validate_public_http_url_rejects_dns_to_private_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        web,
        "_resolve_host_ips",
        lambda host, port: [ipaddress.ip_address("127.0.0.1")],
    )

    with pytest.raises(ValueError, match="blocked non-public address"):
        web._validate_public_http_url("https://example.com/path")
