from __future__ import annotations

import copy
import importlib.util
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .control.models import ControlMode, InteractionStatus, now_ts
from .control.store import ControlStore
from .local_config import LocalConfig, WebUIPreferences, load_local_config, save_local_config
from .model_config import (
    DEFAULT_MODEL_CONFIG,
    ModelConfig,
    load_model_config,
    save_model_config,
    validate_complete_model_entries,
)
from .providers.registry import PROVIDERS, find_by_name


@dataclass(frozen=True)
class WizardModelSettings:
    provider: str
    name: str
    label: str
    api_key: str
    api_base: str
    main_model_id: str
    secondary_model_id: str
    max_tokens: int
    temperature: float
    context_window_tokens: int
    reasoning_effort: str | None = None


@dataclass(frozen=True)
class WizardRuntimeSettings:
    host: str = "127.0.0.1"
    port: int = 8765
    open_browser: bool = False
    control_mode: str = ControlMode.ASK_BEFORE_EDIT.value


@dataclass(frozen=True)
class DoctorCheck:
    name: str
    ok: bool
    detail: str
    fix: str = ""


def run_onboarding(root: Path, *, console: Console | None = None) -> bool:
    console = console or Console()
    try:
        import questionary
        from questionary import Choice
    except ImportError:
        console.print("[red]缺少 questionary，请先安装依赖：pip install -r requirements.txt[/red]")
        return False

    root = Path(root).resolve()
    model_config = load_model_config(root)
    model_settings = _initial_model_settings(model_config)
    runtime_settings = _initial_runtime_settings(root)

    console.print(_banner_panel())
    while True:
        action = questionary.select(
            "What would you like to configure?",
            choices=[
                Choice("[P] LLM Provider / 模型", "model"),
                Choice("[W] WebUI / 运行参数", "webui"),
                Choice("[A] Agent Settings / 权限模式", "agent"),
                Choice("[V] View Configuration Summary", "summary"),
                Choice("[S] Save and Exit", "save"),
                Choice("[X] Exit Without Saving", "exit"),
            ],
        ).ask()
        if action is None or action == "exit":
            console.print("[yellow]未保存，已退出初始化向导。[/yellow]")
            return False
        if action == "model":
            model_settings = _ask_model_settings(questionary, Choice, model_settings)
        elif action == "webui":
            runtime_settings = _ask_runtime_settings(questionary, runtime_settings)
        elif action == "agent":
            runtime_settings = _ask_agent_settings(questionary, Choice, runtime_settings)
        elif action == "summary":
            console.print(configuration_summary(model_settings, runtime_settings))
        elif action == "save":
            raw = build_model_config(model_config.raw, model_settings)
            save_model_config(root, raw, validate_complete=True)
            save_local_config(root, LocalConfig(
                webui=WebUIPreferences(
                    host=runtime_settings.host,
                    port=runtime_settings.port,
                    open_browser=runtime_settings.open_browser,
                )
            ))
            mode_result = apply_control_mode(root, runtime_settings.control_mode)
            console.print(configuration_summary(model_settings, runtime_settings))
            console.print(f"[green]已保存配置到 {root}[/green]")
            if mode_result == "skipped_pending":
                console.print("[yellow]当前存在 Ask/Plan pending，权限模式未被强制修改。[/yellow]")
            return True


def build_model_config(existing_raw: dict[str, Any], settings: WizardModelSettings) -> dict[str, Any]:
    raw = copy.deepcopy(existing_raw or DEFAULT_MODEL_CONFIG)
    raw.setdefault("agents", {}).setdefault("defaults", {})
    raw.setdefault("providers", {})
    models = raw.setdefault("models", [])
    if not isinstance(models, list):
        models = []
        raw["models"] = models

    current_name = str(raw["agents"]["defaults"].get("model") or "")
    existing_entry = _find_entry(models, current_name) or (models[0] if models else {})
    previous_key = str(existing_entry.get("apiKey") or "") if isinstance(existing_entry, dict) else ""
    provider = find_by_name(settings.provider)
    api_base = settings.api_base or (provider.default_api_base if provider else "")

    entry = {
        "name": settings.name.strip(),
        "label": settings.label.strip(),
        "provider": settings.provider,
        "apiKey": settings.api_key.strip() or previous_key,
        "apiBase": api_base,
        "mainModelId": settings.main_model_id.strip(),
        "secondaryModelId": settings.secondary_model_id.strip(),
        "maxTokens": int(settings.max_tokens),
        "temperature": float(settings.temperature),
        "contextWindowTokens": int(settings.context_window_tokens),
        "reasoningEffort": settings.reasoning_effort or None,
    }
    entry["id"] = entry["mainModelId"]

    replaced = False
    old_name = str(existing_entry.get("name") or "") if isinstance(existing_entry, dict) else ""
    for index, item in enumerate(models):
        if isinstance(item, dict) and str(item.get("name") or "") in {old_name, entry["name"]}:
            models[index] = entry
            replaced = True
            break
    if not replaced:
        models.append(entry)

    raw["agents"]["defaults"]["model"] = entry["name"]
    raw["agents"]["defaults"]["provider"] = settings.provider
    raw["agents"]["defaults"]["maxTokens"] = int(settings.max_tokens)
    raw["agents"]["defaults"]["temperature"] = float(settings.temperature)
    raw["agents"]["defaults"]["reasoningEffort"] = settings.reasoning_effort or None
    raw["agents"]["defaults"]["contextWindowTokens"] = int(settings.context_window_tokens)

    provider_block = raw["providers"].setdefault(settings.provider, {})
    if isinstance(provider_block, dict):
        provider_block.setdefault("apiKey", "")
        provider_block["apiBase"] = api_base
        provider_block.setdefault("extraHeaders", None)
        provider_block.setdefault("extraBody", None)

    return raw


def apply_control_mode(root: Path, mode: str) -> str:
    normalized = _normalize_control_mode(mode)
    store = ControlStore(root)
    state = store.load()
    if state.pending and state.pending.status == InteractionStatus.WAITING.value:
        return "skipped_pending"
    state.mode = normalized
    state.previous_mode = None
    state.updated_at = now_ts()
    store.save(state)
    return "saved"


def configuration_summary(
    model: WizardModelSettings,
    runtime: WizardRuntimeSettings,
) -> Panel:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold cyan")
    table.add_column()
    table.add_row("Provider", model.provider)
    table.add_row("Entry", model.name)
    table.add_row("Main model", model.main_model_id)
    table.add_row("Secondary", model.secondary_model_id)
    table.add_row("API key", mask_secret(model.api_key) or "(保留现有或未设置)")
    table.add_row("API base", model.api_base or "(provider default)")
    table.add_row("WebUI", f"http://{runtime.host}:{runtime.port}")
    table.add_row("Open browser", "yes" if runtime.open_browser else "no")
    table.add_row("Control mode", runtime.control_mode)
    return Panel(table, title="Emperor Configuration", border_style="cyan")


def mask_secret(value: str | None) -> str:
    text = str(value or "")
    if not text:
        return ""
    if len(text) <= 4:
        return "***"
    return f"***{text[-4:]}"


def collect_doctor_report(root: Path) -> list[DoctorCheck]:
    root = Path(root).resolve()
    checks: list[DoctorCheck] = []
    model_path = root / "model_config.json"
    if not model_path.exists():
        checks.append(DoctorCheck(
            "model_config.json",
            False,
            "缺少本地模型配置",
            "运行 emperor-agent init",
        ))
    else:
        try:
            config = load_model_config(root, create=False)
            validate_complete_model_entries(config.raw)
        except Exception as exc:
            checks.append(DoctorCheck(
                "model entries",
                False,
                str(exc),
                "运行 emperor-agent init 后保存完整模型条目",
            ))
        else:
            checks.append(DoctorCheck(
                "model entries",
                True,
                f"{len(config.models)} configured",
            ))

    dist = root / "webui" / "dist" / "index.html"
    checks.append(DoctorCheck(
        "webui/dist",
        dist.exists(),
        "静态前端已构建" if dist.exists() else "缺少 webui/dist/index.html",
        "" if dist.exists() else "cd webui && npm install && npm run build",
    ))

    local_path = root / "emperor.local.json"
    if local_path.exists():
        try:
            json.loads(local_path.read_text(encoding="utf-8") or "{}")
        except (json.JSONDecodeError, OSError) as exc:
            checks.append(DoctorCheck("emperor.local.json", False, str(exc), "删除后重新运行 init"))
        else:
            checks.append(DoctorCheck("emperor.local.json", True, "本地偏好配置可读取"))
    else:
        checks.append(DoctorCheck(
            "emperor.local.json",
            True,
            "未创建，将使用默认 WebUI 参数",
            "运行 emperor-agent init 可创建",
        ))

    for package in ("rich", "questionary"):
        checks.append(DoctorCheck(
            f"dependency:{package}",
            importlib.util.find_spec(package) is not None,
            "installed" if importlib.util.find_spec(package) is not None else "missing",
            "" if importlib.util.find_spec(package) is not None else "pip install -r requirements.txt",
        ))
    return checks


def doctor_table(checks: list[DoctorCheck]) -> Table:
    table = Table(title="Emperor Doctor")
    table.add_column("Check", style="bold")
    table.add_column("Status")
    table.add_column("Detail")
    table.add_column("Fix")
    for check in checks:
        table.add_row(
            check.name,
            "[green]OK[/green]" if check.ok else "[red]FAIL[/red]",
            check.detail,
            check.fix or "-",
        )
    return table


def _initial_model_settings(config: ModelConfig) -> WizardModelSettings:
    entry = config.active_entry()
    provider_name = entry.provider if entry else "deepseek"
    spec = find_by_name(provider_name) or find_by_name("deepseek") or PROVIDERS[0]
    main_model = entry.main_model_id if entry else "deepseek-chat"
    return WizardModelSettings(
        provider=spec.name,
        name=(entry.name if entry else "deepseek-work") or "default",
        label=(entry.label if entry else "") or "",
        api_key=(entry.api_key if entry else "") or "",
        api_base=(entry.api_base if entry else spec.default_api_base) or "",
        main_model_id=main_model or "deepseek-chat",
        secondary_model_id=(entry.secondary_model_id if entry else "") or main_model or "deepseek-chat",
        max_tokens=entry.max_tokens or config.defaults.max_tokens,
        temperature=entry.temperature if entry and entry.temperature is not None else config.defaults.temperature,
        context_window_tokens=entry.context_window_tokens or config.defaults.context_window_tokens,
        reasoning_effort=entry.reasoning_effort or config.defaults.reasoning_effort,
    )


def _initial_runtime_settings(root: Path) -> WizardRuntimeSettings:
    local = load_local_config(root)
    store = ControlStore(root)
    mode = store.load().mode
    if mode not in {ControlMode.ASK_BEFORE_EDIT.value, ControlMode.AUTO.value}:
        mode = ControlMode.ASK_BEFORE_EDIT.value
    return WizardRuntimeSettings(
        host=local.webui.host,
        port=local.webui.port,
        open_browser=local.webui.open_browser,
        control_mode=mode,
    )


def _ask_model_settings(questionary, Choice, current: WizardModelSettings) -> WizardModelSettings:
    provider_choices = [
        Choice(f"{spec.display_name} ({spec.name})", spec.name)
        for spec in PROVIDERS
    ]
    provider = questionary.select(
        "Provider",
        choices=provider_choices,
        default=current.provider,
    ).ask() or current.provider
    spec = find_by_name(provider)
    api_base_default = current.api_base or (spec.default_api_base if spec else "")
    api_key = questionary.password(
        f"API key（留空则保留已有：{mask_secret(current.api_key) or '未设置'}）",
    ).ask()
    reasoning = questionary.select(
        "Reasoning effort",
        choices=[
            Choice("None / provider default", ""),
            Choice("minimal", "minimal"),
            Choice("low", "low"),
            Choice("medium", "medium"),
            Choice("high", "high"),
            Choice("xhigh", "xhigh"),
        ],
        default=current.reasoning_effort or "",
    ).ask()
    return WizardModelSettings(
        provider=provider,
        name=_text(questionary, "Entry name", current.name),
        label=_text(questionary, "Display label", current.label),
        api_key=str(api_key or ""),
        api_base=_text(questionary, "API base", api_base_default),
        main_model_id=_text(questionary, "Main model id", current.main_model_id),
        secondary_model_id=_text(questionary, "Secondary model id", current.secondary_model_id),
        max_tokens=_int_prompt(questionary, "Max tokens", current.max_tokens),
        temperature=_float_prompt(questionary, "Temperature", current.temperature),
        context_window_tokens=_int_prompt(questionary, "Context window tokens", current.context_window_tokens),
        reasoning_effort=reasoning or None,
    )


def _ask_runtime_settings(questionary, current: WizardRuntimeSettings) -> WizardRuntimeSettings:
    return WizardRuntimeSettings(
        host=_text(questionary, "WebUI host", current.host),
        port=_int_prompt(questionary, "WebUI port", current.port, minimum=1, maximum=65535),
        open_browser=bool(questionary.confirm(
            "启动 WebUI 后自动打开浏览器？",
            default=current.open_browser,
        ).ask()),
        control_mode=current.control_mode,
    )


def _ask_agent_settings(questionary, Choice, current: WizardRuntimeSettings) -> WizardRuntimeSettings:
    mode = questionary.select(
        "Default permission mode",
        choices=[
            Choice("Ask before edit（推荐）", ControlMode.ASK_BEFORE_EDIT.value),
            Choice("Auto", ControlMode.AUTO.value),
        ],
        default=current.control_mode,
    ).ask() or current.control_mode
    return WizardRuntimeSettings(
        host=current.host,
        port=current.port,
        open_browser=current.open_browser,
        control_mode=_normalize_control_mode(mode),
    )


def _banner_panel() -> Panel:
    return Panel(
        "[bold]Emperor Agent[/bold]\n本地智能体工作台初始化向导",
        title="奉天承运",
        border_style="red",
    )


def _find_entry(models: list[Any], name: str) -> dict[str, Any] | None:
    if not name:
        return None
    for item in models:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def _normalize_control_mode(mode: str) -> str:
    value = str(mode or "").strip().lower()
    if value in {"auto", "automatic"}:
        return ControlMode.AUTO.value
    return ControlMode.ASK_BEFORE_EDIT.value


def _text(questionary, message: str, default: str) -> str:
    value = questionary.text(message, default=str(default or "")).ask()
    return str(value if value is not None else default).strip()


def _int_prompt(
    questionary,
    message: str,
    default: int,
    *,
    minimum: int = 1,
    maximum: int = 1_000_000_000,
) -> int:
    def validate(value: str) -> bool | str:
        try:
            parsed = int(value)
        except ValueError:
            return "请输入整数"
        if not minimum <= parsed <= maximum:
            return f"请输入 {minimum} 到 {maximum} 之间的整数"
        return True

    value = questionary.text(message, default=str(default), validate=validate).ask()
    return int(value if value not in {None, ""} else default)


def _float_prompt(questionary, message: str, default: float) -> float:
    def validate(value: str) -> bool | str:
        try:
            float(value)
        except ValueError:
            return "请输入数字"
        return True

    value = questionary.text(message, default=str(default), validate=validate).ask()
    return float(value if value not in {None, ""} else default)
