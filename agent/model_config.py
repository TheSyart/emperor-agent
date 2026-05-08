"""模型配置加载、解析、保存。

新版 schema：
  - `models[]`：多条目，每条带 `name / id / provider / apiKey / apiBase / 各种覆写`。
  - `agents.defaults.model` 引用某个 entry 的 `name`。
  - `providers.{name}.apiKey/apiBase`：兜底层（条目未填 key 时使用）。
  - `agents.defaults.provider="auto"`：仅在 `models[]` 为空、且想按 model 名匹配时启用。

旧 schema 兼容：
  当 `models` 字段缺失或为空时，运行时合成一个临时 entry。文件不主动改写。
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from .providers import GenerationSettings, ProviderSnapshot, create_provider
from .providers.registry import PROVIDERS, ProviderSpec, find_by_name, provider_options


MODEL_CONFIG_FILE = "model_config.json"
MODEL_CONFIG_EXAMPLE_FILE = "model_config.example.json"


def _build_default_providers() -> dict[str, Any]:
    """按 PROVIDERS registry 自动生成 providers 兜底层占位。"""
    return {
        spec.name: {
            "apiKey": "",
            "apiBase": spec.default_api_base or "",
            "extraHeaders": None,
            "extraBody": None,
        }
        for spec in PROVIDERS
    }


# 全新 schema：默认空 models[]，留 providers 兜底块
DEFAULT_MODEL_CONFIG: dict[str, Any] = {
    "agents": {
        "defaults": {
            "model": "",                        # 引用某条 model entry 的 name
            "provider": "auto",                 # 仅在 model 字段空时按 keyword 匹配
            "maxTokens": 8192,
            "temperature": 0.1,
            "reasoningEffort": None,
            "contextWindowTokens": 128000,
        }
    },
    "models": [],
    "providers": _build_default_providers(),
}


@dataclass(frozen=True)
class AgentDefaults:
    model: str
    provider: str
    max_tokens: int
    temperature: float
    reasoning_effort: str | None
    context_window_tokens: int


@dataclass(frozen=True)
class ProviderConfig:
    """providers.{name} 块：作为兜底（entry 未填 key 时用这里）。"""

    api_key: str | None
    api_base: str | None
    extra_headers: dict[str, str] | None
    extra_body: dict[str, Any] | None


@dataclass(frozen=True)
class ModelEntry:
    """一条模型条目：自带凭证与覆写。"""

    name: str                                    # 唯一 key（agents.defaults.model 引用）
    id: str                                      # 真实发给 API 的 model id
    provider: str                                # registry name
    api_key: str | None = None                   # entry 级；空 → 用 providers 兜底
    api_base: str | None = None                  # entry 级；空 → 用 spec 默认
    extra_headers: dict[str, str] | None = None
    extra_body: dict[str, Any] | None = None
    max_tokens: int | None = None                # 覆写 defaults.maxTokens
    temperature: float | None = None
    context_window_tokens: int | None = None
    reasoning_effort: str | None = None
    label: str = ""                              # UI 展示名；空则用 name
    supports_vision: bool = False                 # 仅由"测试视觉"成功时自动写入 true


@dataclass(frozen=True)
class ModelConfig:
    defaults: AgentDefaults
    models: tuple[ModelEntry, ...]
    providers: dict[str, ProviderConfig]
    raw: dict[str, Any]

    def find_entry(self, name: str | None) -> ModelEntry | None:
        if not name:
            return None
        for entry in self.models:
            if entry.name == name:
                return entry
        return None

    def active_entry(self) -> ModelEntry | None:
        """优先按 defaults.model 找；找不到时返回 models[0]；都没有返回 None。"""
        match = self.find_entry(self.defaults.model)
        if match:
            return match
        return self.models[0] if self.models else None


# ─────────────────── 文件 IO ────────────────────


def ensure_model_config(root: Path) -> Path:
    path = root / MODEL_CONFIG_FILE
    if not path.exists():
        path.write_text(
            json.dumps(DEFAULT_MODEL_CONFIG, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return path


def ensure_example_config(root: Path) -> Path:
    """example 文件总是与最新 DEFAULT 同步——不含敏感数据，覆盖安全。"""
    path = root / MODEL_CONFIG_EXAMPLE_FILE
    desired = json.dumps(DEFAULT_MODEL_CONFIG, ensure_ascii=False, indent=2) + "\n"
    if not path.exists() or path.read_text(encoding="utf-8") != desired:
        path.write_text(desired, encoding="utf-8")
    return path


def load_model_config(root: Path, *, create: bool = True) -> ModelConfig:
    root = root.resolve()
    if create:
        ensure_model_config(root)
        ensure_example_config(root)
    path = root / MODEL_CONFIG_FILE
    raw = copy.deepcopy(DEFAULT_MODEL_CONFIG)
    if path.exists():
        loaded = json.loads(path.read_text(encoding="utf-8") or "{}")
        _deep_merge(raw, loaded)
    return parse_model_config(raw)


def save_model_config(root: Path, data: dict[str, Any]) -> ModelConfig:
    config = parse_model_config(_normalized_raw(data))
    path = root.resolve() / MODEL_CONFIG_FILE
    path.write_text(json.dumps(config.raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ensure_example_config(root.resolve())
    return config


def mark_entry_vision(root: Path, entry_name: str, value: bool = True) -> ModelConfig:
    """把指定 entry 的 supportsVision 字段写入 model_config.json，原子保存。

    供 `/api/model-test` 视觉测试成功后调用，让 entry 在前端列表 👁 立即点亮。
    """
    config = load_model_config(root)
    raw = copy.deepcopy(config.raw)
    found = False
    for m in raw.get("models", []) or []:
        if isinstance(m, dict) and m.get("name") == entry_name:
            m["supportsVision"] = bool(value)
            found = True
            break
    if not found:
        raise ValueError(f"entry {entry_name!r} not found in model_config.json")
    return save_model_config(root, raw)


# ─────────────────── snapshot 装配 ────────────────────


def build_provider_snapshot(root: Path, *, model_override: str | None = None) -> ProviderSnapshot:
    """从配置文件装配出一个完整 ProviderSnapshot。

    解析顺序：
      1. 找 entry：按 `model_override`（CLI/env 强制）→ `defaults.model` → `models[0]` → 旧 schema 合成。
      2. 找 spec：按 `entry.provider` 查 registry；找不到时降级 custom。
      3. 拼凭证：`entry.api_key` → `providers[entry.provider].api_key` → spec 默认（无）。
      4. 拼 base：`entry.api_base` → `providers[entry.provider].api_base` → `spec.default_api_base`。
    """
    config = load_model_config(root)
    entry = _resolve_active_entry(config, model_override)
    spec = find_by_name(entry.provider) or _fallback_spec(entry.provider)

    api_key, api_base, extra_headers, extra_body = _resolve_credentials(entry, config.providers, spec)

    generation = GenerationSettings(
        max_tokens=entry.max_tokens if entry.max_tokens is not None else config.defaults.max_tokens,
        temperature=entry.temperature if entry.temperature is not None else config.defaults.temperature,
        reasoning_effort=entry.reasoning_effort if entry.reasoning_effort is not None else config.defaults.reasoning_effort,
    )

    provider = create_provider(
        spec=spec,
        api_key=api_key,
        api_base=api_base or spec.default_api_base,
        model=entry.id,
        extra_headers=extra_headers,
        extra_body=extra_body,
    )
    provider.generation = generation

    return ProviderSnapshot(
        provider=provider,
        provider_name=spec.name,
        provider_label=spec.display_name,
        model=entry.id,
        api_base=api_base or spec.default_api_base,
        generation=generation,
        context_window_tokens=entry.context_window_tokens or config.defaults.context_window_tokens,
        config=config.raw,
        supports_vision=entry.supports_vision,
        entry_name=entry.name,
    )


def _resolve_active_entry(config: ModelConfig, model_override: str | None) -> ModelEntry:
    """逐级 fallback 找出当前要用的 entry；旧 schema 自动合成。"""
    if model_override:
        # CLI / env 强制：优先按 entry name 找；找不到则当 raw model id，按 auto 合成
        match = config.find_entry(model_override)
        if match:
            return match
        return _synth_entry_from_legacy(config, model_id=model_override)

    if config.models:
        active = config.active_entry()
        if active:
            return active

    # 旧 schema：models[] 为空，按 defaults.{provider, model} 合成
    return _synth_entry_from_legacy(config, model_id=config.defaults.model)


def _synth_entry_from_legacy(config: ModelConfig, *, model_id: str) -> ModelEntry:
    """没有 entry 时，从 defaults.provider + providers.{name} 合成一个临时 entry。"""
    if not model_id:
        # 真没辙了：给个最小占位，让用户尽快去 /model 配置
        logger.warning(
            "No model entry configured and defaults.model is empty. "
            "Creating placeholder; please configure via /model page."
        )
        return ModelEntry(name="default", id="deepseek-chat", provider="deepseek")

    provider_name = _resolve_provider_name(config.defaults.provider, model_id, config.providers)
    p = config.providers.get(provider_name)
    return ModelEntry(
        name=model_id,
        id=model_id,
        provider=provider_name,
        api_key=p.api_key if p else None,
        api_base=p.api_base if p else None,
        extra_headers=p.extra_headers if p else None,
        extra_body=p.extra_body if p else None,
    )


def _fallback_spec(provider_name: str) -> ProviderSpec:
    """provider 找不到时的兜底：返回 custom spec 并 logger.warning。"""
    custom = find_by_name("custom")
    if custom is None:
        # 永远不会到这里，但 mypy 满足
        raise RuntimeError("custom provider missing from registry")
    logger.warning(
        "Unknown provider {!r} in model entry. Falling back to 'custom' — please update entry.",
        provider_name,
    )
    return custom


def _resolve_credentials(
    entry: ModelEntry,
    providers: dict[str, ProviderConfig],
    spec: ProviderSpec,
) -> tuple[str | None, str | None, dict | None, dict | None]:
    """entry-level → providers-level → spec defaults。"""
    p = providers.get(spec.name)
    api_key = entry.api_key or (p.api_key if p else None)
    api_base = entry.api_base or (p.api_base if p else None)
    extra_headers = entry.extra_headers or (p.extra_headers if p else None)
    extra_body = entry.extra_body or (p.extra_body if p else None)
    return api_key, api_base, extra_headers, extra_body


# ─────────────────── 解析 / 归一化 ────────────────────


def model_config_payload(root: Path) -> dict[str, Any]:
    snapshot = build_provider_snapshot(root)
    config = load_model_config(root)
    entry = _resolve_active_entry(config, None)
    return {
        "current": {
            "provider": snapshot.provider_name,
            "providerLabel": snapshot.provider_label,
            "model": snapshot.model,
            "apiBase": snapshot.api_base,
            "maxTokens": snapshot.generation.max_tokens,
            "temperature": snapshot.generation.temperature,
            "reasoningEffort": snapshot.generation.reasoning_effort,
            "contextWindowTokens": snapshot.context_window_tokens,
            "entryName": entry.name,
            "entryLabel": entry.label or entry.name,
            "supportsVision": snapshot.supports_vision,
        },
        "config": snapshot.config,
        "providerOptions": provider_options(),
    }


def parse_model_config(raw: dict[str, Any]) -> ModelConfig:
    normalized = _normalized_raw(raw)
    defaults_raw = normalized["agents"]["defaults"]
    defaults = AgentDefaults(
        model=str(defaults_raw.get("model") or ""),
        provider=str(defaults_raw.get("provider") or "auto"),
        max_tokens=_int(defaults_raw.get("maxTokens"), 8192),
        temperature=_float(defaults_raw.get("temperature"), 0.1),
        reasoning_effort=_nullable_str(defaults_raw.get("reasoningEffort")),
        context_window_tokens=_int(defaults_raw.get("contextWindowTokens"), 128000),
    )

    providers_raw = normalized.get("providers") or {}
    providers: dict[str, ProviderConfig] = {}
    for spec in PROVIDERS:
        item = providers_raw.get(spec.name) or {}
        providers[spec.name] = ProviderConfig(
            api_key=_nullable_str(item.get("apiKey")),
            api_base=_nullable_str(item.get("apiBase")),
            extra_headers=_dict_or_none(item.get("extraHeaders")),
            extra_body=_dict_or_none(item.get("extraBody")),
        )

    models_raw = normalized.get("models") or []
    models = tuple(_parse_entry(item) for item in models_raw if isinstance(item, dict))
    models = _dedupe_entry_names(models)

    return ModelConfig(defaults=defaults, models=models, providers=providers, raw=normalized)


def _parse_entry(item: dict[str, Any]) -> ModelEntry:
    """把一条 dict 解析成 ModelEntry，缺字段给安全默认。"""
    name = str(item.get("name") or item.get("id") or "").strip()
    if not name:
        # 最差兜底：不 crash，但 entry 不可用
        name = "(unnamed)"
    return ModelEntry(
        name=name,
        id=str(item.get("id") or name),
        provider=str(item.get("provider") or "custom"),
        api_key=_nullable_str(item.get("apiKey")),
        api_base=_nullable_str(item.get("apiBase")),
        extra_headers=_dict_or_none(item.get("extraHeaders")),
        extra_body=_dict_or_none(item.get("extraBody")),
        max_tokens=_optional_int(item.get("maxTokens")),
        temperature=_optional_float(item.get("temperature")),
        context_window_tokens=_optional_int(item.get("contextWindowTokens")),
        reasoning_effort=_nullable_str(item.get("reasoningEffort")),
        label=str(item.get("label") or ""),
        supports_vision=bool(item.get("supportsVision", False)),
    )


def _dedupe_entry_names(entries: tuple[ModelEntry, ...]) -> tuple[ModelEntry, ...]:
    """name 重复时给后续的加 `-2 / -3` 后缀，并 logger.warning。"""
    seen: dict[str, int] = {}
    out: list[ModelEntry] = []
    for entry in entries:
        if entry.name not in seen:
            seen[entry.name] = 1
            out.append(entry)
            continue
        seen[entry.name] += 1
        new_name = f"{entry.name}-{seen[entry.name]}"
        logger.warning("Duplicate model entry name {!r}; renamed to {!r}", entry.name, new_name)
        out.append(ModelEntry(**{**entry.__dict__, "name": new_name}))
    return tuple(out)


def _resolve_provider_name(provider: str, model: str, providers: dict[str, ProviderConfig]) -> str:
    """旧 schema 合成时用：按 defaults.provider 找；'auto' 时按 model 名 keyword 匹配。"""
    if provider and provider.lower() not in {"auto", "default"}:
        spec = find_by_name(provider)
        if spec is None:
            logger.warning(
                "Unknown provider {!r} in defaults; falling back to 'custom'.", provider
            )
            return "custom"
        return spec.name

    # auto: keyword 匹配
    normalized_model = (model or "").lower().replace("_", "-")
    for spec in PROVIDERS:
        if any(kw and kw in normalized_model for kw in spec.keywords):
            return spec.name
    # 退而求其次：第一个有 apiKey 的 provider
    for name, p in providers.items():
        if p.api_key:
            return name
    return "deepseek"


def _normalized_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """把用户输入 deep-merge 到 DEFAULT，确保所有 key 存在。"""
    normalized = copy.deepcopy(DEFAULT_MODEL_CONFIG)
    _deep_merge(normalized, raw or {})
    # 给所有 spec 在 providers 下补占位
    providers = normalized.setdefault("providers", {})
    for spec in PROVIDERS:
        providers.setdefault(spec.name, {
            "apiKey": "",
            "apiBase": spec.default_api_base or "",
            "extraHeaders": None,
            "extraBody": None,
        })
    normalized.setdefault("agents", {}).setdefault(
        "defaults", copy.deepcopy(DEFAULT_MODEL_CONFIG["agents"]["defaults"])
    )
    normalized.setdefault("models", [])
    return normalized


def _deep_merge(target: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_merge(target[key], value)
        else:
            target[key] = value
    return target


def _nullable_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text != "" else None


def _dict_or_none(value: Any) -> dict | None:
    return value if isinstance(value, dict) else None


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
