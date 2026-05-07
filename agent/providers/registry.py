"""
Provider Registry — single source of truth for LLM provider metadata.

设计原则（参考 nanobot）：
  - ProviderSpec 只描述 *访问方式*，不内嵌 model 列表。
  - Model id 由用户在配置 / WebUI 自由填写。
  - 添加新 provider：在 PROVIDERS 元组里加一条，并在 webui ProviderOption 自动暴露。

字段使用：
  - keywords: 用于 `provider="auto"` 时按 model 名匹配。
  - default_api_base: 当用户未填 apiBase 时的兜底；OAuth/local/direct provider 也用。
  - is_gateway / is_local / is_oauth / is_direct: 决定是否要求 apiKey、UI 是否折叠 API Base 字段等。
  - thinking_style: 把"启用思考"开关注入 extra_body 的方式（不同厂家不同协议）。
  - model_overrides: 强制为某些 model 注入的固定参数（例如 Kimi K2 要求 temperature ≥ 1）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ProviderSpec:
    """一种 provider 的访问元数据。Model id 由用户填，spec 不存。"""

    # 身份
    name: str                                          # registry id, 与 config providers.{name} 对齐
    display_name: str                                  # UI 展示
    backend: str                                       # openai_compat | anthropic | azure_openai | bedrock | openai_codex | github_copilot
    keywords: tuple[str, ...] = ()                     # provider="auto" 时用 model 名匹配

    # 网络
    default_api_base: str | None = None
    env_key: str = ""                                  # 可选，从环境变量取 key
    env_extras: tuple[tuple[str, str], ...] = ()       # 额外注入的 env，e.g. (("ZHIPUAI_API_KEY", "{api_key}"),)

    # 分类（仅 UI 分组与门禁逻辑用）
    region: str = "other"                              # foreign | aggregator | cloud | cn | local | other
    is_gateway: bool = False                           # OpenRouter / AiHubMix 等可路由任意模型
    is_local: bool = False                             # 本地部署（vLLM / Ollama / LM Studio）
    is_oauth: bool = False                             # OAuth-based，用户不填 apiKey
    is_direct: bool = False                            # 用户必须自己填完整 endpoint（custom / azure / bedrock / ovms）
    detect_by_key_prefix: str = ""                     # auto 路由：按 apiKey 前缀认人
    detect_by_base_keyword: str = ""                   # auto 路由：按 apiBase 关键字认人

    # OpenAI-compat 行为差异
    strip_model_prefix: bool = False                   # 发请求前去掉 "vendor/" 前缀（aihubmix 等）
    supports_max_completion_tokens: bool = False       # OpenAI 系：用 max_completion_tokens 而非 max_tokens
    supports_prompt_caching: bool = False              # Anthropic / OpenRouter 等

    # 思考开关 / 推理
    thinking_style: str = ""                           # thinking_type | enable_thinking | reasoning_split
    reasoning_as_content: bool = False                 # StepFun：把 reasoning 字段当正文

    # 强制覆写（按 model id 注入 extra_body / sampling）
    model_overrides: tuple[tuple[str, dict[str, Any]], ...] = field(default_factory=tuple)


PROVIDERS: tuple[ProviderSpec, ...] = (
    # ─── 海外大厂 ─────────────────────────────────────────────
    ProviderSpec(
        name="openai",
        display_name="OpenAI",
        backend="openai_compat",
        keywords=("openai", "gpt", "o1", "o3", "o4"),
        default_api_base="https://api.openai.com/v1",
        env_key="OPENAI_API_KEY",
        region="foreign",
        supports_max_completion_tokens=True,
    ),
    ProviderSpec(
        name="anthropic",
        display_name="Anthropic",
        backend="anthropic",
        keywords=("anthropic", "claude"),
        env_key="ANTHROPIC_API_KEY",
        region="foreign",
        supports_prompt_caching=True,
    ),
    ProviderSpec(
        name="gemini",
        display_name="Google Gemini",
        backend="openai_compat",
        keywords=("gemini", "gemma", "google"),
        default_api_base="https://generativelanguage.googleapis.com/v1beta/openai/",
        env_key="GEMINI_API_KEY",
        region="foreign",
    ),
    ProviderSpec(
        name="xai",
        display_name="xAI Grok",
        backend="openai_compat",
        keywords=("xai", "grok"),
        default_api_base="https://api.x.ai/v1",
        env_key="XAI_API_KEY",
        region="foreign",
    ),
    ProviderSpec(
        name="mistral",
        display_name="Mistral AI",
        backend="openai_compat",
        keywords=("mistral", "codestral"),
        default_api_base="https://api.mistral.ai/v1",
        env_key="MISTRAL_API_KEY",
        region="foreign",
    ),
    ProviderSpec(
        name="groq",
        display_name="Groq",
        backend="openai_compat",
        keywords=("groq",),
        default_api_base="https://api.groq.com/openai/v1",
        env_key="GROQ_API_KEY",
        region="foreign",
    ),

    # ─── 聚合 / 网关 ───────────────────────────────────────────
    ProviderSpec(
        name="openrouter",
        display_name="OpenRouter",
        backend="openai_compat",
        keywords=("openrouter",),
        default_api_base="https://openrouter.ai/api/v1",
        env_key="OPENROUTER_API_KEY",
        region="aggregator",
        is_gateway=True,
        detect_by_key_prefix="sk-or-",
        detect_by_base_keyword="openrouter",
        supports_prompt_caching=True,
    ),
    ProviderSpec(
        name="huggingface",
        display_name="Hugging Face",
        backend="openai_compat",
        keywords=("huggingface", "hugging-face"),
        default_api_base="https://router.huggingface.co/v1",
        env_key="HF_TOKEN",
        region="aggregator",
        is_gateway=True,
        detect_by_key_prefix="hf_",
        detect_by_base_keyword="huggingface",
    ),
    ProviderSpec(
        name="aihubmix",
        display_name="AiHubMix",
        backend="openai_compat",
        keywords=("aihubmix",),
        default_api_base="https://aihubmix.com/v1",
        env_key="AIHUBMIX_API_KEY",
        region="aggregator",
        is_gateway=True,
        detect_by_base_keyword="aihubmix",
        strip_model_prefix=True,
    ),
    ProviderSpec(
        name="siliconflow",
        display_name="SiliconFlow (硅基流动)",
        backend="openai_compat",
        keywords=("siliconflow",),
        default_api_base="https://api.siliconflow.cn/v1",
        env_key="SILICONFLOW_API_KEY",
        region="aggregator",
        is_gateway=True,
        detect_by_base_keyword="siliconflow",
    ),

    # ─── 云厂 ─────────────────────────────────────────────────
    ProviderSpec(
        name="azure_openai",
        display_name="Azure OpenAI",
        backend="azure_openai",
        keywords=("azure", "azure-openai"),
        region="cloud",
        is_direct=True,
    ),
    ProviderSpec(
        name="bedrock",
        display_name="AWS Bedrock",
        backend="bedrock",
        keywords=(
            "bedrock", "anthropic.claude", "amazon.nova", "meta.",
            "mistral.", "cohere.", "deepseek.", "moonshot.",
        ),
        env_key="AWS_BEARER_TOKEN_BEDROCK",
        region="cloud",
        is_direct=True,
    ),

    # ─── 国内 ─────────────────────────────────────────────────
    ProviderSpec(
        name="deepseek",
        display_name="DeepSeek",
        backend="openai_compat",
        keywords=("deepseek",),
        default_api_base="https://api.deepseek.com",
        env_key="DEEPSEEK_API_KEY",
        region="cn",
        thinking_style="thinking_type",
    ),
    ProviderSpec(
        name="dashscope",
        display_name="Alibaba DashScope (Qwen)",
        backend="openai_compat",
        keywords=("dashscope", "qwen"),
        default_api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        env_key="DASHSCOPE_API_KEY",
        region="cn",
        thinking_style="enable_thinking",
    ),
    ProviderSpec(
        name="moonshot",
        display_name="Moonshot Kimi",
        backend="openai_compat",
        keywords=("moonshot", "kimi"),
        default_api_base="https://api.moonshot.cn/v1",
        env_key="MOONSHOT_API_KEY",
        region="cn",
        model_overrides=(
            ("kimi-k2", {"temperature": 1.0}),
            ("kimi-k2.5", {"temperature": 1.0}),
            ("kimi-k2.6", {"temperature": 1.0}),
        ),
    ),
    ProviderSpec(
        name="zhipu",
        display_name="Zhipu GLM (智谱)",
        backend="openai_compat",
        keywords=("zhipu", "glm", "zai"),
        default_api_base="https://open.bigmodel.cn/api/paas/v4/",
        env_key="ZAI_API_KEY",
        env_extras=(("ZHIPUAI_API_KEY", "{api_key}"),),
        region="cn",
    ),
    ProviderSpec(
        name="volcengine",
        display_name="VolcEngine 火山方舟 (含豆包)",
        backend="openai_compat",
        keywords=("volcengine", "volces", "ark", "doubao"),
        default_api_base="https://ark.cn-beijing.volces.com/api/v3",
        env_key="ARK_API_KEY",
        region="cn",
        is_gateway=True,
        detect_by_base_keyword="volces",
        thinking_style="thinking_type",
    ),
    ProviderSpec(
        name="volcengine_coding_plan",
        display_name="VolcEngine Coding Plan",
        backend="openai_compat",
        keywords=("volcengine-plan",),
        default_api_base="https://ark.cn-beijing.volces.com/api/coding/v3",
        env_key="ARK_API_KEY",
        region="cn",
        is_gateway=True,
        strip_model_prefix=True,
        thinking_style="thinking_type",
    ),
    ProviderSpec(
        name="byteplus",
        display_name="BytePlus (海外火山)",
        backend="openai_compat",
        keywords=("byteplus",),
        default_api_base="https://ark.ap-southeast.bytepluses.com/api/v3",
        env_key="BYTEPLUS_API_KEY",
        region="cn",
        is_gateway=True,
        detect_by_base_keyword="bytepluses",
        strip_model_prefix=True,
        thinking_style="thinking_type",
    ),
    ProviderSpec(
        name="minimax",
        display_name="MiniMax",
        backend="openai_compat",
        keywords=("minimax",),
        default_api_base="https://api.minimax.io/v1",
        env_key="MINIMAX_API_KEY",
        region="cn",
        thinking_style="reasoning_split",
    ),
    ProviderSpec(
        name="stepfun",
        display_name="Step Fun (阶跃星辰)",
        backend="openai_compat",
        keywords=("stepfun", "step"),
        default_api_base="https://api.stepfun.com/v1",
        env_key="STEPFUN_API_KEY",
        region="cn",
        reasoning_as_content=True,
    ),
    ProviderSpec(
        name="xiaomi_mimo",
        display_name="Xiaomi MIMO (小米)",
        backend="openai_compat",
        keywords=("xiaomi", "mimo"),
        default_api_base="https://api.xiaomimimo.com/v1",
        env_key="XIAOMIMIMO_API_KEY",
        region="cn",
    ),
    ProviderSpec(
        name="longcat",
        display_name="LongCat (美团)",
        backend="openai_compat",
        keywords=("longcat",),
        default_api_base="https://api.longcat.chat/openai/v1",
        env_key="LONGCAT_API_KEY",
        region="cn",
    ),
    ProviderSpec(
        name="qianfan",
        display_name="Qianfan 千帆 (文心 ERNIE)",
        backend="openai_compat",
        keywords=("qianfan", "ernie", "wenxin"),
        default_api_base="https://qianfan.baidubce.com/v2",
        env_key="QIANFAN_API_KEY",
        region="cn",
    ),

    # ─── 本地部署 ──────────────────────────────────────────────
    ProviderSpec(
        name="ollama",
        display_name="Ollama",
        backend="openai_compat",
        keywords=("ollama", "llama", "nemotron"),
        default_api_base="http://localhost:11434/v1",
        env_key="OLLAMA_API_KEY",
        region="local",
        is_local=True,
        detect_by_base_keyword="11434",
    ),
    ProviderSpec(
        name="lm_studio",
        display_name="LM Studio",
        backend="openai_compat",
        keywords=("lm-studio", "lmstudio", "lm_studio"),
        default_api_base="http://localhost:1234/v1",
        env_key="LM_STUDIO_API_KEY",
        region="local",
        is_local=True,
        detect_by_base_keyword="1234",
    ),
    ProviderSpec(
        name="vllm",
        display_name="vLLM",
        backend="openai_compat",
        keywords=("vllm",),
        env_key="HOSTED_VLLM_API_KEY",
        region="local",
        is_local=True,
    ),
    ProviderSpec(
        name="ovms",
        display_name="OpenVINO Model Server",
        backend="openai_compat",
        keywords=("openvino", "ovms"),
        default_api_base="http://localhost:8000/v3",
        region="local",
        is_local=True,
        is_direct=True,
    ),

    # ─── OAuth-based ───────────────────────────────────────────
    ProviderSpec(
        name="openai_codex",
        display_name="OpenAI Codex",
        backend="openai_codex",
        keywords=("openai-codex", "codex"),
        default_api_base="https://chatgpt.com/backend-api",
        region="other",
        is_oauth=True,
        detect_by_base_keyword="codex",
        strip_model_prefix=True,
    ),
    ProviderSpec(
        name="github_copilot",
        display_name="GitHub Copilot",
        backend="github_copilot",
        keywords=("github_copilot", "copilot"),
        default_api_base="https://api.githubcopilot.com",
        region="other",
        is_oauth=True,
        strip_model_prefix=True,
        supports_max_completion_tokens=True,
    ),

    # ─── 兜底 ─────────────────────────────────────────────────
    ProviderSpec(
        name="custom",
        display_name="Custom",
        backend="openai_compat",
        keywords=(),
        region="other",
        is_direct=True,
    ),
)


def find_by_name(name: str | None) -> ProviderSpec | None:
    """按 registry name 精确查找。容忍 - / _ 互换。"""
    if not name:
        return None
    normalized = name.replace("-", "_").lower()
    for spec in PROVIDERS:
        if spec.name == normalized:
            return spec
    return None


def provider_options() -> list[dict[str, Any]]:
    """供 WebUI ProviderOption 下拉用的元数据列表。"""
    return [
        {
            "name": spec.name,
            "displayName": spec.display_name,
            "backend": spec.backend,
            "defaultApiBase": spec.default_api_base or "",
            "region": spec.region,
            "isGateway": spec.is_gateway,
            "isLocal": spec.is_local,
            "isOauth": spec.is_oauth,
            "isDirect": spec.is_direct,
            "thinkingStyle": spec.thinking_style or None,
        }
        for spec in PROVIDERS
    ]
