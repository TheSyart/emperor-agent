from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .base import GenerationSettings, LLMProvider
from .registry import ProviderSpec, find_by_name


@dataclass
class ProviderSnapshot:
    provider: LLMProvider
    provider_name: str
    provider_label: str
    model: str
    api_base: str | None
    generation: GenerationSettings
    context_window_tokens: int
    config: dict[str, Any]
    supports_vision: bool = False
    entry_name: str = ""


def create_provider(
    *,
    spec: ProviderSpec,
    api_key: str | None,
    api_base: str | None,
    model: str,
    extra_headers: dict[str, str] | None = None,
    extra_body: dict[str, Any] | None = None,
) -> LLMProvider:
    base = api_base or spec.default_api_base
    common = {
        "spec": spec,
        "api_key": api_key,
        "api_base": base,
        "default_model": model,
        "extra_headers": extra_headers,
        "extra_body": extra_body,
    }

    if spec.backend == "anthropic":
        from .anthropic_provider import AnthropicProvider

        common.pop("spec", None)
        return AnthropicProvider(**common)
    if spec.backend == "azure_openai":
        from .openai_compat import AzureOpenAIProvider

        return AzureOpenAIProvider(**common)
    if spec.backend == "bedrock":
        from .bedrock_provider import BedrockProvider

        common.pop("spec", None)
        return BedrockProvider(**common)
    if spec.backend == "openai_codex":
        from .openai_compat import OpenAICodexProvider

        return OpenAICodexProvider(**common)
    if spec.backend == "github_copilot":
        from .openai_compat import GitHubCopilotProvider

        return GitHubCopilotProvider(**common)

    from .openai_compat import OpenAICompatProvider

    return OpenAICompatProvider(**common)


def require_provider_spec(name: str) -> ProviderSpec:
    spec = find_by_name(name)
    if spec is None:
        raise ValueError(f"Unknown provider: {name}")
    return spec
