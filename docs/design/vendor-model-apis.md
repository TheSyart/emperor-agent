# 厂商模型列表接口规范

> 文档状态：Active<br>
> 面向读者：开发者、维护者<br>
> 最后核验：2026-10-19<br>
> 事实源：`packages/core/src/model/discovery/`（`registry.ts`、`service.ts`、`http.ts`、`merge.ts`、各厂商解析器、`fixtures/model-lists/`、`discovery.test.ts`）、`api/services/model-service.ts`（`discoverModels`、`probeConnection`）、`api/operations.ts`

新增模型时，Emperor 用用户填写的连接（供应商、协议、API 地址、Key）向厂商自己的接口取模型列表，读出厂商给出的上下文、输出上限、能力与思考选项，再与[随包模型目录](model-metadata.md)合并；保存前可以用同一份草稿测试连接，错误附带可一键采用的修正建议。本文记录每家厂商的接口、字段、分页和坑，以及 Emperor 统一遵守的规则。

**当前状态**：解析器、`model.discoverModels` 与 `model.probeConnection` 已在 core 中实现并有测试；「设置 › 模型」的三步添加模型对话框（MOD-04）用它们测试连接、读取列表（能力、上限、来源、生命周期都会显示），错误码对应到字段提示与一键修正。编辑已保存条目的旧编辑器仍只读取列表里的 `id`。

## 两个 operation

| operation               | 作用                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.discoverModels`  | 全量取回模型列表并与目录合并；厂商没有列表接口时返回目录推荐（`source: 'catalog'`）。可带 `refresh: true` 跳过缓存                                                                                                     |
| `model.probeConnection` | 发一次最便宜的请求检查 Key 与地址，返回 `{ ok: true, latencyMs, modelCount?, method }` 或 `{ ok: false, code, message, fix?, status? }`。`method` 为 `list`（读了模型列表）或 `auth_check`（发了一个不可能运行的请求） |

两者接受同一份草稿：`provider`、`protocol`、`apiBase`、`apiKey`、`extraHeaders`、百炼的 `workspaceId`，以及可选的 `entryId` / `connectionId`。都是只读操作，不写 `model_config.json`。

**草稿 Key 优先**：表单里填写的 Key 总是被使用；只有 Key 为空或是掩码（`***…`）、并且 `entryId`（或 `connectionId`）指向的已保存条目与草稿的供应商、协议、规范化后的 API 地址完全一致时，才借用已保存的 Key。地址改过就不借用，已保存的 Key 不会发往它没有保存过的地址。`apiKey: null` 表示不带 Key。`connectionId` 只匹配带有该字段的条目（条目由后续的配置扩展加入这个字段，在此之前它找不到任何条目）。

## 通用规则

| 规则     | 内容                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分页     | 最多 100 页；游标重复立即停止并报 `PAGING_FAILED`；**所有页都成功才返回**，任何一页失败整体失败，消息写明第几页                                                                                       |
| 超时     | 每个请求 30 秒，包括读取响应体                                                                                                                                                                        |
| 条数     | 最多保留 2000 个模型，超出截断并标 `truncated: true`，`totalCount` 为截断前的数量                                                                                                                     |
| 限流     | 429 时按 `Retry-After`（秒数或 HTTP 日期，缺省 1 秒）退避一次后重试；要等 10 秒以上时不等待，直接返回 `RATE_LIMITED`                                                                                  |
| 缓存     | 成功结果在内存中缓存 15 分钟，键为连接哈希：解析器、供应商、协议、API 地址、Workspace ID、Key 的 SHA-256、额外请求头的 SHA-256。换 Key 就是另一个连接。不写盘；失败不缓存；采用修正地址后直接命中缓存 |
| 疑似密钥 | 丢弃含本连接 Key 或额外请求头值、匹配常见令牌格式（`sk-…`、`AIza…`、`hf_…`、JWT 等）或含 32 位以上大小写字母数字混合随机段的模型 id，并返回丢弃个数，不返回内容                                       |
| 去重排序 | 按 id 去重、按 id 排序                                                                                                                                                                                |

### 传输与凭据

- 请求走与模型调用相同的传输（进程的 `fetch`），因此代理行为与对话请求一致，也能访问本机和内网的服务（Ollama、LM Studio、自建 vLLM 与网关）。网页抓取用的公共 HTTP 客户端拒绝本机与私网地址，不适用于这里。
- 重定向手动处理：只跟随同源（或同一主机从 http 升级到 https）的重定向，最多 3 次；指向其他主机时不跟随并报 `WRONG_BASE`，凭据请求头不会发往别的主机。
- 响应体上限 16 MiB，边读边计数。
- 厂商错误信息只取 `error.message` 等字段的前 300 个字符，并抹掉本连接的 Key 与令牌格式的字符串；返回结果和缓存都不含 Key。Gemini 的 Key 只放在 `x-goog-api-key` 请求头，从不放进 URL。

## 解析器的选择

`resolveParser({ provider, protocol, apiBase, workspaceId? })` 先看 API 主机（代理或改名的供应商仍按主机的方式应答），再看供应商名称，再看本机端口，其余都按通用 OpenAI 兼容处理：

1. 火山方舟、方舟 Coding Plan、BytePlus（名称或 `*.volces.com`、`*.bytepluses.com`）→ 只用目录；
2. `generativelanguage.googleapis.com` → Gemini 原生接口；
3. Anthropic 协议：`api.anthropic.com` → Anthropic；DeepSeek、Kimi、硅基流动、智谱、MiniMax、百炼的 Anthropic 兼容地址 → 同一主机的 OpenAI 风格列表（同一个 Key 通用，字段更全）；其他主机 → Anthropic 列表，没有就用目录；
4. 百炼且填写了 Workspace ID → 百炼官方模型目录；
5. 按主机或名称：DeepSeek、Kimi、xAI、Mistral、OpenRouter、Groq、Together、硅基流动；
6. Ollama（名称或本机 `11434` 端口）、LM Studio（名称或本机 `1234` 端口）、vLLM；
7. 其余 → 通用 OpenAI 兼容。

**列表缺失时**（404、405 或返回网页）：第三方 Anthropic 兼容地址和没有列表接口的厂商一律退到目录推荐；其他供应商只在 API 地址仍是预设地址时退到目录推荐。用户自己改过的地址更可能是填错了，此时报 `WRONG_BASE`。通用 OpenAI 兼容地址没有版本段时，404 后再试一次 `{base}/v1/models`，成功则返回列表并在 `fix.apiBase` 给出补上 `/v1` 的地址。

## 合并与来源

每个字段单独取值：厂商接口给出的值优先，没有时用随包目录（`lookupModelFacts`：快照、覆盖层、家族规则、兜底）。`fieldSources` 逐字段标注来源（`vendor_api`、`catalog`、`family_rule`、`fallback`）；`source` 在厂商给出任一上限、能力或思考选项时为 `vendor_api`，否则沿用目录的来源。

- 能力三态：厂商只给出明确的布尔值才算；没给的字段不推断为「不支持」（Ollama 例外：它列出全部能力，没列出的就是没有）。
- 思考：厂商的强度档位优先；能否关闭以厂商为准，其次是目录，两者都没有说明而又有强度档位时按「不能关闭」处理。
- 价格只接受美元：只有 OpenRouter 的厂商价格会被读取，其他厂商的价格（人民币、单位不明或单位容易换算错的）不读，由目录补上。
- 本机服务（Ollama、LM Studio）的上下文只用服务端实际加载的值，不用目录里的训练上限补：模型以较小的上下文运行时，按训练上限计算会让请求被截断或失败。
- vLLM 按 `root`（权重名）查目录，服务名常是别名。

## 连接测试与错误码

| code                  | 含义                                                                    | `fix`                                        |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `AUTH`                | 401/403，或 400 且厂商说 Key 无效（Gemini）；也用于云端供应商没有填 Key | Key 前缀属于其他供应商时给出 `provider`      |
| `REGION_KEY_MISMATCH` | 401/403 发生在分区厂商的一侧，而同一个 Key 在另一侧有效                 | `apiBase` 为另一侧的地址                     |
| `WRONG_BASE`          | 404/405/410、返回网页、重定向到其他主机、地址缺失或不是 http(s)         | 能确定时给出 `apiBase`（补 `/v1`、去 `/v1`） |
| `NETWORK`             | 连不上、DNS、TLS、超时，或 408/502/503/504                              | —                                            |
| `RATE_LIMITED`        | 429（已退避一次）                                                       | —                                            |
| `NOT_COMPATIBLE`      | 200 但不是 JSON、没有模型数组，或响应过大                               | —                                            |
| `UNKNOWN`             | 其他状态码；列表的分页错误（`PAGING_FAILED`）在连接测试里也归为此类     | —                                            |

列表接口另有 `PAGING_FAILED`、`CREDENTIAL_REQUIRED`、`MISSING_API_BASE` 三个码。

- **最小请求**：有列表接口的厂商读第一页（Ollama 只读 `/api/tags`，不逐个查询）；OpenRouter 的列表公开不验 Key，改用 `GET /key`；没有列表接口的厂商和第三方 Anthropic 兼容地址发一个「认证检查」：向对话接口发送 `model` 为空、`messages` 为空的请求（OpenAI 协议 `POST {base}/chat/completions`，Anthropic 协议 `POST {base}/v1/messages`）。没有模型能运行这个请求，不产生费用；401/403 表示 Key 无效，400/422（或方舟的「接入点或模型不存在」404）表示 Key 已被接受。先校验请求体再校验 Key 的网关会被误判为通过，这类结果的 `method` 为 `auth_check`。
- **分区 Key**：Kimi（`api.moonshot.cn` / `api.moonshot.ai`）、智谱（`open.bigmodel.cn` / `api.z.ai`）、MiniMax（`api.minimaxi.com`、`api.minimax.cn` / `api.minimax.io`）两侧的 Key 互不通用。一侧返回 401/403 时，用同一个 Key 对另一侧做一次连接测试（只在这几组厂商自己的主机之间），成功才报 `REGION_KEY_MISMATCH`，否则仍是 `AUTH`。
- **Anthropic 地址带 `/v1`**：请求会发往 `{base}/v1/messages`，地址以 `/v1` 结尾会变成 `/v1/v1/messages`；列表照常读取，同时给出去掉 `/v1` 的 `fix.apiBase`，连接测试报 `WRONG_BASE`。

## 各厂商接口

「核对」一列：**实测**为当天用真实请求核对（未带有效 Key 的只核对了错误响应），**文档**为对照官方文档或 SDK 类型，**录制**为 model-center 用真实 Key 录下的响应。夹具在 `fixtures/model-lists/<厂商>.json`，按文档与录制样例构造，不来自真实 Key。

### Anthropic

- `GET {base}/v1/models?limit=1000`，请求头 `x-api-key`、`anthropic-version: 2023-06-01`。
- 分页：`has_more` 为真时用 `last_id` 作为下一页的 `after_id`；`has_more` 为真却没有 `last_id` 报 `NOT_COMPATIBLE`。
- 字段：`display_name`、`created_at`、`max_input_tokens`（作为上下文与输入上限）、`max_tokens`（输出上限）、`capabilities.image_input/pdf_input/thinking/effort`（每个叶子是 `{ supported }`）。`effort` 的 `low`…`max` 给出强度；`thinking.types.disabled` 不支持时为「不能关闭」，只支持 `enabled` 时为 `budget`。2026 年起还返回 `lifecycle`、`deprecated_at`、`retires_at`。
- 坑：`capabilities` 可以为 `null`；没有工具调用字段（Claude 都支持，由目录补）。
- 核对：2026-10-19 文档（API 参考、`@anthropic-ai/sdk` 的 `ModelInfo`）；无效 Key 返回 401 `invalid x-api-key`，2026-10-19 实测。

### Google Gemini

- 原生 `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000`，请求头 `x-goog-api-key`。
- 分页：`nextPageToken` → `pageToken`。
- 字段：`name`（`models/<id>`，去掉前缀）、`displayName`、`inputTokenLimit`（作为上下文：Gemini 的输出计入同一窗口）、`outputTokenLimit`、`thinking`、`supportedGenerationMethods`（含 `generateContent` 为对话，`embedContent` 为嵌入，`predict` 为图像，只有 `bidiGenerateContent` 为实时音频）。
- 坑：兼容地址 `/v1beta/openai/models` 只有 id，所以 Google 主机上的连接一律用同一个 Key 读原生接口；对话请求仍走兼容地址，它接受不带 `models/` 的 id。无效 Key 返回 **400**（`API key not valid`），按 `AUTH` 处理。
- 核对：2026-10-18 文档；无效 Key 的 400 响应 2026-10-19 实测。

### DeepSeek

- `GET https://api.deepseek.com/models`（`/v1/models` 同样可用），Bearer。无分页。
- 字段：`context_window`（输入加输出）、`max_output_tokens`、`input_modalities`（含 `image` 为识图）、`output_modalities`、`effort.supported_levels` / `default_level`。
- Anthropic 兼容地址 `https://api.deepseek.com/anthropic` 用同一个 Key 在主机根路径取列表。
- 核对：2026-10-19 文档（list-models 示例：1,048,576 / 393,216）；无效 Key 的 401 2026-10-19 实测（错误信息会带 Key 的末四位）。

### Kimi（月之暗面）

- `GET {base}/models`：`https://api.moonshot.cn/v1`、`https://api.moonshot.ai/v1`、Coding 套餐 `https://api.kimi.com/coding/v1`，Bearer。无分页，没有输出上限和价格。
- 字段：文档列出 `context_length`、`supports_image_in`、`supports_video_in`、`supports_reasoning`；实际还返回 `display_name`、`supports_dynamic_tools`（工具调用）、`supports_thinking_type`（`only` 表示不能关闭思考）、`think_efforts { support, valid_efforts, default_effort }`。`support` 不为真或档位为空时整组不用。
- 坑：`.cn` 与 `.ai` 的 Key 不通用（见分区 Key）；`-highspeed` 变体是独立条目，工具调用为 `false`。Anthropic 兼容地址 `/anthropic` 在同一主机的 `/v1` 取列表。
- 核对：2026-09-19 录制；`.cn` 无效 Key 的 401 `Invalid Authentication` 2026-10-19 实测。

### xAI

- `GET https://api.x.ai/v1/models`，Bearer。
- 字段：`context_length`、`capabilities.reasoning_effort[]` / `default_reasoning_effort`、`aliases`。`prices` 以「美分 / 1 亿 token」计，不读取（目录有美元价格）。另有 `/v1/language-models` 返回模态，目前未调用。
- 核对：2026-10-18 文档。

### Mistral

- `GET https://api.mistral.ai/v1/models`，Bearer。
- 字段：`max_context_length`、`capabilities.{completion_chat, function_calling, vision, reasoning, ocr, classification, moderation, audio…}`、`deprecation`（日期）与 `deprecation_replacement_model`、`default_model_temperature`（有数值即接受温度）、`archived`。
- 坑：`archived` 的模型已不能调用，跳过；别名（`*-latest`）也是独立条目。
- 核对：2026-10-18 文档（OpenAPI `BaseModelCard`）。

### OpenRouter

- `GET https://openrouter.ai/api/v1/models`，公开，带 Key 也可。省略 `offset` 和 `limit` 时返回全部；分页时跟随 `links.next`（只跟随同源地址）。默认只列出文本输出的模型。
- 字段：`top_provider.context_length`（缺失时用 `context_length`）、`top_provider.max_completion_tokens`、`architecture.input_modalities/output_modalities`、`supported_parameters`（`tools`、`reasoning`、`temperature`；空数组不作判断）、`reasoning.{mandatory, supported_efforts, default_effort}`、`pricing`（美元 / token 的字符串，`-1` 表示浮动价，忽略）、`expiration_date`。
- 连接测试：`GET /api/v1/key`，无效 Key 返回 401。
- 核对：2026-10-19 文档（models 与 get-current-key）；不带 Key 的完整列表 2026-10-19 实测。

### Groq

- `GET https://api.groq.com/openai/v1/models`，Bearer。字段 `context_window`、`active`，部分模型有 `max_completion_tokens`。
- 坑：停用的模型（`active: false`）仍在列表中，跳过。
- 核对：2026-10-18 文档。

### Together

- `GET https://api.together.xyz/v1/models`，Bearer，响应是**裸数组**。
- 字段：`type`（chat、language、code 为对话，另有 image、embedding、rerank、moderation、audio、transcribe、video）、`display_name`、`organization`、`context_length`。`pricing` 没有说明单位与币种，不读。
- 核对：2026-10-18 文档。

### 硅基流动（SiliconFlow）

- `GET {origin}/v1/models?type=text&sub_type=chat`，Bearer。`type` / `sub_type` 是查询过滤参数，响应只有 `id`、`object`、`created`、`owned_by`；过滤结果按对话模型记录类型。
- Anthropic 兼容地址（`https://api.siliconflow.cn`，无路径）在同一主机的 `/v1` 取列表。
- 核对：2026-10-18 文档。

### 百炼（阿里云）

- 没有 Workspace ID 时走兼容接口 `GET https://dashscope.aliyuncs.com/compatible-mode/v1/models`（未见文档，但主流客户端在用）。
- 填写 Workspace ID 时读官方模型目录：`GET https://{workspace}.cn-beijing.maas.aliyuncs.com/api/v1/models?page_no=N&page_size=20`，Bearer；`success` 必须为真，按 `output.total` 翻页，总数中途变化或提前出现空页报 `PAGING_FAILED`。Workspace ID 必须是合法的 DNS 标签。
- 字段：`model_info.{context_window, max_input_tokens, max_output_tokens}`、`capabilities[]`（TG、Reasoning、VU 为对话；TR、ME 为嵌入；IG 图像；VG 视频；ASR、TTS 音频）、`features[]`（`function-calling`）、`inference_metadata.request_modality`。价格为人民币，不读。
- 核对：2026-09-19 录制。

### 智谱 GLM、MiniMax、阶跃、小米、LongCat、千帆等

- 通用 OpenAI 兼容 `GET {base}/models`，Bearer，只有 `id`、`object`、`created`、`owned_by`，能力与上限全部来自目录。
- 智谱 `/api/paas/v4/models` 文档未列出，可能不可用；预设地址下返回 404 时退到目录推荐。智谱与 MiniMax 的 Anthropic 兼容地址在同一主机的 OpenAI 路径（`/api/paas/v4`、`/v1`）取列表，连接测试走认证检查。
- 核对：2026-10-18 文档。

### 火山方舟、BytePlus

- 数据面没有公开的模型列表接口（控制面 `ListFoundationModels` 需要 AK/SK 签名，与推理 Key 是两套凭据）。列表直接返回目录推荐，不发请求；用户的接入点 ID（`ep-…`）需要手动输入。连接测试走认证检查。
- 核对：2026-10-18 文档。

### Ollama

- `GET {root}/api/tags`（`root` 为去掉 `/v1` 的地址），再对每个模型 `POST {root}/api/show {"model": "<name>"}`（并发 4）。
- 字段：`parameters` 文本里的 `num_ctx N` 作为上下文；`capabilities` 列出 `completion`、`tools`、`vision`、`thinking`、`embedding` 等，没有列出的就是不支持。
- 坑：Modelfile 没有设置 `num_ctx` 时，Ollama 按显存自选一个较小的上下文，`model_info` 里的 `<arch>.context_length` 是训练上限，二者都不能当作实际上下文，此时上下文留空。单个 `/api/show` 失败只让该模型的资料未知，不让整个列表失败。
- 核对：2026-10-19 文档；服务未运行时报 `NETWORK`（`ECONNREFUSED`），2026-10-19 实测。

### LM Studio

- `GET {root}/api/v1/models` → `models[]`：`key`（对话请求使用的 id）、`type`（llm、embedding、decision）、`display_name`、`loaded_instances[].config.context_length`、`max_context_length`、`capabilities.{vision, trained_for_tool_use, reasoning.allowed_options}`。
- 上下文取已加载实例的值；未加载的模型上下文留空（加载时的默认上下文小于 `max_context_length`）。`allowed_options` 不含 `off` 时思考不能关闭。
- 旧版本没有 `/api/v1` 时依次退到 `/api/v0/models` 与 `/v1/models`。
- 核对：2026-10-19 文档。

### vLLM

- `GET {base}/models`，`max_model_len` 为实际服务的上下文，`root` 为权重名（用于查目录）。
- 核对：2026-10-18 文档。

## 尚未用真实 Key 核对

- Gemini 兼容地址列表的 id 是否带 `models/` 前缀（原生接口已去掉，影响不大）；
- 百炼 `compatible-mode/v1/models` 是否返回全部模型；
- 智谱 `/api/paas/v4/models` 是否可用；
- DeepSeek、Kimi、智谱、MiniMax 的 Anthropic 兼容地址是否实现 `/v1/models`（目前改走各自的 OpenAI 风格列表）；
- 认证检查在方舟和第三方 Anthropic 兼容地址上的实际状态码；
- OpenRouter `GET /key` 对有效 Key 的响应。

## 新增厂商

1. 在 `discovery/` 新增解析器（OpenAI 风格的列表用 `openAiStyleParser` 并只写字段读取），把厂商给出的值放进 `VendorModel`，没给的字段留空。
2. 在 `registry.ts` 按主机和名称登记，判断列表缺失时是否退到目录。
3. 在 `fixtures/model-lists/` 加一份按文档构造的夹具（写明来源与核对日期），在 `discovery.test.ts` 加解析与选择用例。
4. 在本文补上该厂商的接口、字段、分页、坑和核对日期。
