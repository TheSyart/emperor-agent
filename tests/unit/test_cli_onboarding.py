from __future__ import annotations

import copy

from agent.control.manager import ControlManager
from agent.control.models import ControlMode
from agent.local_config import (
    LocalConfig,
    WebUIPreferences,
    load_local_config,
    merge_webui_overrides,
    save_local_config,
)
from agent.model_config import DEFAULT_MODEL_CONFIG, save_model_config
from agent.onboarding import (
    WizardModelSettings,
    apply_control_mode,
    build_model_config,
    collect_doctor_report,
    mask_secret,
)


def _settings(api_key: str = "") -> WizardModelSettings:
    return WizardModelSettings(
        provider="deepseek",
        name="deepseek-work",
        label="DeepSeek Work",
        api_key=api_key,
        api_base="https://api.deepseek.com",
        main_model_id="deepseek-chat",
        secondary_model_id="deepseek-chat",
        max_tokens=4096,
        temperature=0.2,
        context_window_tokens=64000,
        reasoning_effort=None,
    )


def test_wizard_model_config_preserves_existing_key_when_blank(tmp_path) -> None:
    raw = copy.deepcopy(DEFAULT_MODEL_CONFIG)
    raw["agents"]["defaults"]["model"] = "old"
    raw["models"] = [{
        "name": "old",
        "provider": "deepseek",
        "apiKey": "sk-old-secret",
        "apiBase": "https://api.deepseek.com",
        "mainModelId": "deepseek-chat",
        "secondaryModelId": "deepseek-chat",
    }]

    out = build_model_config(raw, _settings(api_key=""))
    config = save_model_config(tmp_path, out, validate_complete=True)

    entry = config.active_entry()
    assert entry is not None
    assert entry.name == "deepseek-work"
    assert entry.api_key == "sk-old-secret"
    assert entry.main_model_id == "deepseek-chat"
    assert entry.secondary_model_id == "deepseek-chat"


def test_wizard_model_config_overwrites_key_and_masks_secret(tmp_path) -> None:
    raw = copy.deepcopy(DEFAULT_MODEL_CONFIG)

    out = build_model_config(raw, _settings(api_key="sk-new-secret"))
    config = save_model_config(tmp_path, out, validate_complete=True)

    assert config.active_entry() is not None
    assert config.active_entry().api_key == "sk-new-secret"
    assert mask_secret("sk-new-secret") == "***cret"
    assert mask_secret("abc") == "***"
    assert mask_secret("") == ""


def test_local_config_roundtrip_and_overrides(tmp_path) -> None:
    save_local_config(
        tmp_path,
        LocalConfig(webui=WebUIPreferences(host="127.0.0.2", port=9999, open_browser=True)),
    )

    loaded = load_local_config(tmp_path)
    prefs = merge_webui_overrides(loaded, host="127.0.0.1", port=8765, open_browser=False)

    assert loaded.webui.host == "127.0.0.2"
    assert loaded.webui.port == 9999
    assert loaded.webui.open_browser is True
    assert prefs.host == "127.0.0.1"
    assert prefs.port == 8765
    assert prefs.open_browser is False


def test_apply_control_mode_skips_pending_interaction(tmp_path) -> None:
    manager = ControlManager(tmp_path)
    manager.create_ask(
        questions=[{
            "id": "q1",
            "header": "Mode",
            "question": "Continue?",
            "options": [{"label": "Yes"}, {"label": "No"}],
        }]
    )

    result = apply_control_mode(tmp_path, ControlMode.AUTO.value)

    assert result == "skipped_pending"
    assert ControlManager(tmp_path).mode == ControlMode.ASK_BEFORE_EDIT.value


def test_collect_doctor_report_detects_missing_model_config(tmp_path) -> None:
    checks = collect_doctor_report(tmp_path)
    by_name = {check.name: check for check in checks}

    assert by_name["model_config.json"].ok is False
    assert by_name["webui/dist"].ok is False
    assert "emperor-agent init" in by_name["model_config.json"].fix
