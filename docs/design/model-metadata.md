# 模型元数据规范

> 文档状态：Active<br>
> 面向读者：开发者、维护者<br>
> 最后核验：2026-10-19<br>
> 事实源：`packages/core/src/model/metadata/`（`lookup.ts`、`overrides.ts`、`family-rules.ts`、`providers.ts`、`sync.ts`、`manifest.json`）、`scripts/sync-model-metadata.ts`、`metadata/lookup.test.ts`、`metadata/sync.test.ts`

Emperor 随包带一份模型元数据目录：在不联网、不调用厂商接口的情况下，回答某个模型的上下文窗口、输出上限、能力（工具、识图、思考）、思考强度、是否接受温度、美元单价和生命周期。新增模型流程、手动输入、执行器模型选择器和成本计算共用这一份目录与同一套匹配规则。

**当前状态**：目录与 `lookupModelFacts()` 已在 core 中实现并有测试，`ModelFacts` 等类型从 `@emperor/core/api` 导出；设置页、新增模型流程和成本计算**尚未接入**，界面上的数值仍来自 `model_config.json` 与 `model/profile.ts`。

## 数据来源与许可

| 项目     | 内容                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游     | [models.dev](https://models.dev) 的 `https://models.dev/api.json`，公开，无需凭证                                                                                                                                                                       |
| 许可     | MIT，Copyright (c) 2025 models.dev（仓库 [anomalyco/models.dev](https://github.com/anomalyco/models.dev)）。全文随快照保存在 `metadata/models-dev.LICENSE.txt`                                                                                          |
| 随包副本 | `metadata/models-dev.snapshot.json`：投影后的子集，`license` 字段携带许可声明；`metadata/manifest.json` 记录抓取时间、sha256、字节数和各 provider 条目数                                                                                                |
| 保留范围 | 只保留 `llm/catalog.ts` 的 provider 及其按 API 主机细分出的区域或套餐（共 29 个 models.dev provider）                                                                                                                                                   |
| 保留字段 | 名称、家族、发布日期、状态、上下文/输入/输出上限、输入输出模态、工具调用、思考与思考选项、温度、单价（输入、输出、缓存读、缓存写）、canonical id；其余字段（描述等）丢弃                                                                                |
| 不带价格 | 人民币计价或按套餐计费的 provider（`alibaba-cn`、`moonshotai-cn`、`zhipuai`、`siliconflow-cn`、`minimax-cn`、`stepfun`、火山方舟两者、Kimi Coding 两者、小米、LongCat、LM Studio）在同步时去掉单价：models.dev 按某个汇率折成美元，错误的价格比没有更糟 |

快照按 provider、模型 id 排序，每行一个模型，便于审阅刷新差异；它由脚本逐字节生成，已列入 `.prettierignore`，不要手改（测试会比对序列化结果）。

## 匹配规则

`lookupModelFacts({ provider, apiBase?, modelId })` 按顺序尝试，命中即停：

1. **判类型**：厂商给出的输出模态不含文本时以它为准；否则按 id 关键词（`embed`、`bge`、`rerank`、`tts`、`whisper`、`realtime`、`gpt-image`、`veo`、`wan`、`moderation`、`ocr` 等，按词边界匹配）判为非对话模型，其余为 `chat`。
2. **provider 映射**：先认 API 主机（`dashscope-intl` → `alibaba`，`api.moonshot.ai` → `moonshotai`，`api.kimi.com/coding` → Kimi Coding，`api.z.ai` → `zai`，`siliconflow.com` → 国际站，`api.minimaxi.com` → `minimax-cn`，方舟 `/api/coding` → 方舟 Coding Plan 等），再认 `catalog.ts` 名称；`ollama`、`vllm`、`custom` 等没有对应目录，直接进入第 6 步。
3. **精确匹配**：同 provider 内不区分大小写。
4. **规范化后匹配**：去掉 `models/`、`org/` 路径，`:free`/`:thinking`/`:beta`/`:nitro`/`:exacto`，`-fp8`/`-int4`/`-awq` 等量化后缀，Bedrock 区域与厂商前缀和 `-v1:0`，Vertex `@YYYYMMDD`，以及结尾的 `-YYYYMMDD`、`-YYYY-MM-DD`、火山 `-YYMMDD`。参数量（`-72b`）和四位快照号（`-0905`）不去。只有规范化后真能命中才采用。
5. **最长前缀**：查询 id 以已知 id 开头且下一个字符是边界（`-` `.` `:` `@` `/` `_`），并且边界后是一个**不表示档位的词**（如 `-preview`、`-latest`）。边界后是数字（版本，`glm-5` ≠ `glm-5.9`）或档位词（`mini`、`pro`、`flash`、`turbo`、`thinking`、`highspeed` 等，`gpt-5.6-mini` ≠ `gpt-5.6`）时不算。`gpt-4` 不会命中 `gpt-4o`。
6. **跨 provider**：先找模型所属厂商的官方条目（厂商由 canonical id、`org/` 前缀或 id 家族名判定），再找 OpenRouter，最后找其余 provider；被截短的 id（如 `Qwen/Qwen3-Coder-480B`）只在恰好一个模型能补全时采用。跨 provider 命中时**不带单价和生命周期**：网关的价格与上下线是它自己的。
7. **家族规则**（只对 `chat`）：`family-rules.ts` 中按规范化 id 匹配的正则。
8. **兜底**：只给出类型，能力全部为未知。

`source` 如实标注来源：`catalog`（快照或覆盖层）、`family_rule`、`fallback`；`vendor_api` 是厂商列表接口读到的值，由[厂商模型列表](vendor-model-apis.md)在合并时标注。`key` 对应地为 `models.dev:<provider>/<id>`、`emperor:<provider>/<id>`（只由覆盖层定义的条目）、`family:<规则 id>` 或 `fallback`。

不变量：查询是纯函数，同一输入在同一快照下结果确定，每次返回新的对象；能力三态，`undefined` 表示未知，不按名称猜测为真。兜底结果不带任何数值，界面与默认值计算自行套用保守默认值。

思考控制 `reasoning.control` 的含义：`effort` 可选强度且可以关闭（快照里有开关或 `none` 档）；`always` 不能关闭，`efforts` 为可选强度；`toggle` 只有开关；`budget` 为思考预算。快照没有说明能否关闭时按 `always` 处理，宁可不提供「关闭」也不让请求被拒。

## 覆盖层规则

`overrides.ts` 修正快照中错误或缺失的数据，在匹配之后应用，因此总是优先于快照：

- 每条写明适用的 models.dev provider、模型 id、要替换的字段（`capabilities` 按键合并，其他字段整体替换）、原因、出处链接和核对日期（`YYYY-MM-DD`）。出处优先用厂商文档或厂商接口的实测记录。
- 快照里没有的模型（例如上游已删除的退役型号）由覆盖层新增条目，`key` 为 `emperor:…`；这类条目只回答本 provider 的查询，不参与跨 provider 匹配。
- 只在有出处时写生命周期的替代型号；厂商没有点名替代时不填 `replacement`。
- 价格修正取保守值：DeepSeek 用高峰价（低谷价为其一半），以免成本上限低估。
- models.dev 改正后删除对应覆盖：`lookup.test.ts` 会对不再改变任何字段的覆盖报错。

## 家族规则

`family-rules.ts` 给目录尚未收录的新版本或别名兜底：

- 正则作用于规范化后的 id，按顺序第一条命中生效，具体规则在前，通用规则在后。
- 每条带出处和核对日期；不写价格和生命周期；同一家族成员不一致的字段留空。
- 数值在来源不一致时取低值：上限偏小只会提前压缩，偏大会让请求失败。
- 文件末尾的通用规则（`glm`、`claude`、`gemini`、`kimi`）只声明整个家族都具备的能力，不给数值。

## 刷新流程

```sh
npm run models:check   # 联网比对；快照过期或被改动时退出码 1，并按 provider 列出新增、删除、变化的模型
npm run models:sync    # 数据有变化时重写快照与 manifest；没有变化时两个文件都不动
npm run models:sync -- --input api.json   # 用已下载的副本，不联网
```

脚本经 `vite-node` 运行（解析 core 的 TypeScript 引用），逻辑在 `metadata/sync.ts`，测试不联网。退出码：0 正常，1 `--check` 发现差异，2 参数、网络或数据校验错误；上游缺少任一映射的 provider 或字段形状不符时同步失败，不会写出半份快照。

刷新时：

1. 运行 `npm run models:sync`，审阅输出的差异与 `git diff`（每行一个模型）。
2. 对照差异检查覆盖层：上游已改正的覆盖删掉，新出现的错误补上覆盖并写明出处。
3. 运行 core 测试；测试中引用具体型号的断言若因上游改动失败，确认改动属实后再更新断言。
4. 发版前至少刷新一次。目前没有定时任务；定期检查由发布流程负责接入。

## 新增 provider

在 `llm/catalog.ts` 登记新 provider 时，同时在 `metadata/providers.ts` 把它映射到 models.dev provider（有区域或套餐之分时补主机规则），或列入 `UNMAPPED_CATALOG_PROVIDERS`；`lookup.test.ts` 会检查每个 catalog provider 都有归属。新映射的 provider 进入快照需要重新运行同步。

## 已知限制

- 只取基础档单价；按上下文长度分档（如超过 200K 加价）和分时段价格不建模。
- Ollama 的 `name:tag` 形式（`qwen3:32b`）不做转换，本地模型的上下文与能力应以服务端报告为准。
- models.dev 对部分模型的思考开关记录不全（如若干 Claude 型号），这些模型按 `always` 处理，不提供「关闭」。
