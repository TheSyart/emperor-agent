# Emperor Agent · 系统风险审计报告

> 审计性质：只读、基于仓库证据。未实际执行的命令/测试不写成「已通过」。
> 严重级别 = 缺陷 × 部署上下文。本次部署上下文已与负责人确认：**本地单用户桌面应用（aiohttp 绑定 127.0.0.1）**，因此凡涉及 Web/命令执行的风险，其严重级别已按「本地、用户自驱」语境下调；同时按 **商业化 / 交接** 目的，标注「哪些本地假设是承重的、若对外暴露会塌成什么」。

---

## 修复状态（审计后更新）

> 本节记录审计结论落地情况。全部修复均由后端 448 测试 + 前端 95 测试 + `ruff` 守护，逐项实跑通过。

| ISSUE | 状态 | 落地位置 |
|---|---|---|
| ISSUE-001 命令默认放行 | **已修复** | `permissions/pipeline.py` run_command 默认审批 + `resolvers.is_low_risk_command` 低风险只读白名单（shlex 解析、挡链式绕过）；高风险即便在已批准计划中仍需审批 |
| ISSUE-002 无 Origin/认证 | **已修复** | `web/origin_guard.py`（Host+Origin 校验，挡 DNS-rebinding/CSRF）+ `web/auth_guard.py`（仅打包态启用的本地 token，Electron 主进程经 env/arg 注入） |
| ISSUE-003 任务索引无界 | **已修复** | `tasks/store.py` 终态任务按月归档 + 读改并去重，活跃任务不归档，`list()`/API 默认只列热索引 |
| ISSUE-004 核心 God-object | **已修复** | `control/manager.py` 1616→557、`runner.py` 1222→984；抽出 `plan_helpers`/`plan_permissions`/`plan_verification`/`plan_drafting`/`plan_execution` 子管理器 + `runner_helpers`，并删除 runner 内已死的重复上下文治理静态方法 |
| ISSUE-005 工程成熟度 | **已修复** | `.github/workflows/ci.yml`（pytest+vitest+ruff+`git diff --check`）、`LICENSE`(MIT)、`.pre-commit-config.yaml` |
| ISSUE-006 吞异常静默丢状态 | **已修复** | `runtime/events.record_degraded` + `dispatch.py` 记录失败显式发事件，前端 `types.ts`/`useRuntime.ts` 可见提示 |

### 残余与已知未审计（接受）
- **token 的边界**：本地 token 防的是浏览器侧（DNS-rebinding/CSRF）与「打包态被误配 `host=0.0.0.0`」；在单用户桌面上，**同一用户身份的本地进程**理论上仍可读后端进程环境变量拿到 token。此为 origin_guard 之外的纵深防御边界，单用户语境下**接受为残余风险**，非缺陷。
- **未审计区域（接受，本轮不扩范围）**：`desktop-pet/` 子项目、`agent/loop.py` 全量装配链、MCP 外部 server 行为、providers 重试/退避细节 —— 标记为**已知未审计**，未来如需可单独排期。

---

## 复审（2026-06-25）

> 本节为一次全量复审：用三路只读探查**交叉验证当前代码**（非仅信任上版报告），覆盖 ① 既有 6 项修复是否仍成立、② 上版报告后新落地且此前未审计的代码（最近 3 个提示词/工具/缓存提交，以及 providers 重试/退避、Bedrock、`loop.py` 装配、desktop capabilities）、③ 既有「已接受残余」是否仍只是残余。
> 基线复跑：本会话 `python -m pytest tests/ -q` = **458 passed**（含新缓存测试）。

### 再验证（既有修复 + 最近提交）

| 项 | 复审结论 | 当前证据 |
|---|---|---|
| ISSUE-001 命令默认审批 | **HOLD** | `permissions/pipeline.py:116-128` run_command 默认 `_approval`，仅 `is_low_risk_command` 白名单免批；`resolvers.py:105-124` 用 `shlex.split` + 元字符门挡链式绕过；高风险即便已批准计划仍需审批 |
| ISSUE-002 Origin/Auth | **HOLD** | `web/app.py:67` 中间件顺序 `[error, origin_guard, auth_guard]`；origin_guard 校验 Host+Origin（挡 DNS-rebinding/CSRF），auth_guard 仅打包态启用 token 且豁免 `/api/bootstrap`；13 个 guard 测试通过 |
| ISSUE-003 任务索引归档 | **HOLD** | `tasks/store.py` 终态任务月度归档、活跃不归档、`list()` 默认只列热索引 |
| ISSUE-004 God-object | **HOLD** | `control/manager.py` 557、`runner.py` 984，未反弹；上轮删除的死重复静态方法未重现；子管理器经 `plan_helpers` 共享逻辑、无重复 |
| ISSUE-005 CI/LICENSE/pre-commit | **HOLD** | `.github/workflows/ci.yml`（ruff + pytest + `git diff --check` + 前端 vitest/build）、`LICENSE`(MIT)、`.pre-commit-config.yaml` 均在位 |
| ISSUE-006 显式降级事件 | **HOLD** | `agent/**` 内 `except BaseException` 共 8 处，**全部 cleanup 后 re-raise**，无静默丢状态；`record_degraded` 在位 |
| web_fetch SSRF | **HOLD** | `tools/web.py` 校验 scheme/host、阻塞私网/环回/保留 IP，重定向逐跳再校验 |
| filesystem 工作区禁闭 | **HOLD** | `tools/filesystem.py` `_resolve()` 先 `expanduser`+`resolve` 规范化再 `relative_to(workspace)`，挡 `../`/符号链接逃逸 |
| 最近 3 提交（提示词/工具/缓存） | **CLEAN** | 四条新行为契约命中（`test_agent_prompt_contracts`）；工具描述与真实行为一致（120s 超时、`行号\|内容` 格式、最小 env，`test_tool_descriptions`）；Anthropic 缓存按端点门控正确、下游无 `system` 必为 str 假设（`test_anthropic_prompt_caching`） |

**结论**：审计时点名的全部修复经**当前代码实证仍成立**；最近提交未引入回归。

### ISSUE-007 · Bedrock provider 丢弃 system 提示且拒绝任何工具调用
- **Severity: P3 Low** · **Confidence: High** · **Critical Path: No** · **状态: 新发现（此前未审计区）**
- **FACT**
  - `[E1] agent/providers/bedrock_provider.py:55-61` | `_messages` 对 `role == "system"` 直接 `continue`，且 `converse(...)` 调用无 `system=` 入参 → **系统提示词整段丢弃**。
  - `[E1] agent/providers/bedrock_provider.py:35-36` | `chat` 一旦收到任意 `tools` 即 `raise RuntimeError("Bedrock tool calling is not implemented...")`。
- **REASONING**：主 agent 回合**必带工具表**，因此 Bedrock 在触及 system 丢弃问题之前就先 `raise` → **无法承载主回合**。仅当被选作纯文本路径时，身份/工具契约会无声缺失。该 provider 自述为 "minimal port / lightweight"，属潜在 footgun 而非在用路径缺陷，故定 Low。
- **最小修复**：选用 Bedrock 跑主回合时 fail-fast 抛清晰「主回合暂不支持 Bedrock」错误（避免无声降级）；或补 `system=[{"text": system}]` 入参 + 实现工具转换后再开放。
- **验证**：单测断言「带 tools 调 Bedrock」抛清晰错误；若启用纯文本路径，则 system 文本进入 `converse` 请求。

### ISSUE-008 · providers 无重试/退避，瞬时故障直接硬失败回合
- **Severity: P3 Low** · **Confidence: High** · **Critical Path: No** · **状态: 新发现（此前未审计区）**
- **FACT**
  - `[E1] agent/providers/anthropic_provider.py:21` | `AsyncAnthropic(max_retries=0)` —— 显式关闭 SDK 自带重试。
  - `[E1] agent/providers/openai_compat.py` | 未见 backoff/retry；`[E1] bedrock_provider.py:37-42` | `asyncio.to_thread(client.converse, ...)` 无显式超时，依赖 boto3 默认 socket 超时。
  - 上版报告 §1.3 已记多模型路由 fallback 存在，但**单 provider 内**无退避/熔断。
- **REASONING**：429/5xx/瞬时网络抖动会直接终止当前回合，无优雅降级或有界重试。当前为有意选择（避免重复副作用），但**未文档化**，长期个人使用下偶发中断体验差。
- **最小修复**：文档化「不在 provider 内重试」的决定；或在 provider/runner 边界对**幂等失败**（连接错误、429）加有界指数退避重试，并对最终失败发显式降级事件。
- **验证**：注入一次 429/连接错误，断言触发有界重试或产生显式降级事件（而非静默终止）。

### ISSUE-009 · provider `system` 形状不对称，且无跨 provider 一致性测试
- **Severity: P3 Low** · **Confidence: High** · **Critical Path: No** · **状态: 新发现**
- **FACT**
  - `[E1] agent/providers/anthropic_provider.py:82-86` | 原生端点下 `system` 现为 `list[dict]`（带 `cache_control`）；`[E1] bedrock_provider.py` / `openai_compat.py` | 仍为 `str`。
  - `[E1] tests/unit/test_anthropic_prompt_caching.py` | 仅覆盖 Anthropic；无断言三 provider 接受同一 system+messages 契约的测试。
- **REASONING**：各 provider 各自把 system 交给对应 SDK 消费，当前**无下游代码假设 `system` 必为 str**（复审已核 `_kwargs` 出口直达 SDK），故风险低；缺口在于**没有一道测试把「跨 provider 接受同一上层契约」钉死**，未来改动易悄然破坏某一支。
- **最小修复**：补一个参数化测试，对 Anthropic/OpenAI-compat/Bedrock 传入同一 system + messages（+ Bedrock 的无工具约束），断言各自构造请求不抛、system 内容均被携带或按既定方式处理。
- **验证**：新参数化测试绿。

### 维护性重申（已知增量项，非本轮新缺陷，不在范围）
- shell `_DENY_PATTERNS` 仍不全（`rm -rf ~`、`; bash x.sh`、`node -e`、`osascript -e` 等未拦）—— 但**审批门为主防线**，deny-list 仅纵深防御，非新缺陷。
- `desktop/.../composables/useRuntime.ts` 1226 LoC —— 体量大但**内聚**（运行时状态/WS/重放单一职责），非 God-object，留观。
- CI 缺**覆盖率门禁**与 **`tsc --noEmit` 类型检查**；仓库缺 `CHANGELOG`/`Dockerfile`。均为面向完整商业化的增量项。

### 评分更新（诚实，不抬分）
- 本轮**未发现 P0/P1**；新增 ISSUE-007/008/009 均为 provider 健壮性低风险债，**不改综合总评 ≈6.5/10**（本地单用户语境）。
- 维度备注：「错误处理/可观测」与「依赖与配置卫生」追记「providers 单支无重试/退避、Bedrock 主回合路径残缺」作为已知短板；其余维度同「修复后」列。

### 本轮未覆盖（诚实声明）
- 仍未做动态渗透（DNS-rebinding/CSRF 仅静态推断）。
- MCP 外部 server 行为、desktop e2e 仅静态/单测层面覆盖；`desktop-pet/` 未深入 —— 续记为已知未审计。
- 「未发现」仅代表已覆盖范围内证据不足，不等于不存在。

---

## 0. 基线（Baseline）

| 项 | 值 |
|---|---|
| 仓库根 | `/Users/anhuike/Documents/workspace/emperor-agent` |
| 分支 / commit | detached `HEAD` @ `5327ee9`（工作树脏：desktop 多个 panel/router/css 文件 M） |
| 项目类型 | Agent 工作台（Python 后端 + Vue3/Electron 桌面端） |
| 部署上下文 | 本地单用户桌面，WebUI 默认 `host=127.0.0.1`（`agent/local_config.py:16`、`agent/onboarding.py:49`） |
| 审计目的 | 商业化/交接决策 + 整体健康巡检 |
| 代码体量 | 总 ~50.2k LoC（Python 35k / Vue 7.4k / TS 7k / JS 0.8k） |
| 测试 | 100 个测试文件（pytest 后端 + vitest 前端）；后端全量 419 passed（本次审计中实跑一次，见 §6 验证） |
| 证据类型 | E1=直接代码引用为主，少量 E2（跨文件机制推断） |
| 实跑命令 | `recon.sh`、`python -m pytest tests/ -q`（419 passed）、`cd desktop && npx vitest run`（70 passed，前序会话） |
| 未执行/未覆盖 | 未做动态渗透（DNS-rebinding 实证）、未对 MCP 外部 server 联调、未审 desktop-pet 子项目、未审 `agent/loop.py` 全量装配链 |
| 报告时间 | 2026-06-24 17:51 |

默认降权：`.venv/`、`logs/`、`memory/`（运行期私人数据）、`assets/generated/`、`desktop-pet/`（与主链路无关的玩具子项目）。

---

## 1. 系统模型

### 1.1 模块图

```mermaid
flowchart TD
  subgraph Desktop[Electron 桌面端 (Vue3)]
    UI[Views/Panels] --> RT[useRuntime.ts<br/>WS 客户端 + reducer]
    RT -->|WS / REST| WEB
  end
  subgraph Backend[aiohttp 后端 127.0.0.1]
    WEB[web/routes/* + app.py<br/>error_middleware 唯一中间件] --> LOOP[loop.py AgentLoop<br/>装配根]
    LOOP --> RUNNER[runner.py AgentRunner<br/>回合状态机]
    RUNNER --> CTRL[control/manager.py<br/>模式/计划/权限编排 1616 LoC]
    RUNNER --> REG[tools/registry + execution]
    REG --> TOOLS[shell / filesystem / web / search / dispatch / scheduler / team]
    CTRL --> PERM[permissions/pipeline]
    LOOP --> TASKS[tasks/manager + store]
    LOOP --> SCHED[scheduler/service]
    LOOP --> TEAM[team/manager]
    RUNNER --> PROV[providers/* LLM 路由]
  end
  TOOLS -. 不可信输入 .-> PROV
  PROV -->|HTTP| EXT[(Anthropic/OpenAI/兼容端点)]
  TOOLS -->|stdio/http| MCP[(MCP servers)]
  SCHED & TEAM & TASKS --> FS[(memory/*.json 文件存储)]
```

证据索引：`agent/web/app.py:31-63`（中间件仅 error）、`agent/loop.py:98`（TaskManager 装配）、`agent/runner.py:51`、`agent/control/manager.py:61`、`agent/permissions/pipeline.py:15`。

### 1.2 数据流图（写路径 + 信任边界）

```text
用户消息 / 远程页面(?) → WS(/api ws, 无 Origin 校验) → MainlineTurnService
  → AgentRunner.step_async（回合状态机）
    → 投影上下文（含 web_fetch/read_file/MCP 的【不可信输出】）→ Provider.chat → 模型
    → 模型产出 tool_use → permissions/pipeline.assess(mode) ── [信任边界①: 命令放行]
       ├─ run_command(shell=True) ──→ 本机进程副作用
       ├─ write_file/edit_file ──→ 本地文件
       └─ scheduler/team/dispatch ──→ 后台持久任务
    → control_manager 回写 PlanRecord/TaskRecord/Todo → memory/*.json（多文件、非事务）
    → runtime events → WS 广播 → 前端 reducer 重放
```

信任边界①（命令放行）是全系统安全的承重点；不可信输入（web/repo/MCP 输出）→ 模型 → 命令放行 的链路贯穿信任边界，是本报告的核心关注。

### 1.3 外部依赖图

| 依赖 | 协议 | 方向 | 认证 | 超时 | 重试/熔断/降级 |
|---|---|---|---|---|---|
| LLM 提供方（Anthropic/OpenAI/兼容） | HTTPS | 出站 | API key（env/`model_config.json`，已 gitignore） | `httpx.Timeout(600, connect=30)`（`providers/openai_compat.py:21`） | 多模型路由 fallback（`model_route_fallback` 事件存在）；未观察到退避/熔断 → unknown |
| MCP servers | stdio/http | 双向 | 取决于 server | unknown | unknown |
| 本机 shell | subprocess | 出站副作用 | 无（靠权限门） | 120s（`tools/shell.py:91`） | 无 |

### 1.4 核心调用链（C0 写路径）

`WS → MainlineTurnService.submit → AgentRunner.step_async → _execute_tool_calls → control_manager.assess_permission → registry.execute_result → Tool.execute → control_manager 回写 plan/task/todo → runtime event 广播`。证据：`agent/runner.py:140,612,671`、`agent/control/manager.py:463`。

### 1.5 系统不变量清单

| ID | 不变量 | 证据 | 状态 |
|---|---|---|---|
| INV-001 | 每个 `tool_use` 必有配对 `tool_result`（含 abort/pause 的 synthetic 回填） | `runner._pair_tool_calls`（`runner.py:517`）、checkpoint 机制 | Holds（有测试） |
| INV-002 | 危险/高影响命令在非 auto 模式下必须经用户批准后才执行 | `permissions/pipeline._assess_ask_before_edit:111` | **部分破坏**（仅 deny-list 内命令拦截，见 ISSUE-001） |
| INV-003 | WebUI 状态可由后端 runtime event 重放恢复（后端为事实来源） | `runtime/store.py` 含 replay/compact | Holds（运行期条件，未动态验证） |
| INV-004 | 持久 JSON 存储写入原子（不留半写） | `tasks/store.py:51`、`plans/store.py`、`scheduler/store.py:243` 均 `tmp.replace` | Holds（单实例内） |
| INV-005 | 跨多个存储（plan + task + todo + event）的单回合写入要么全可见要么可恢复 | 四处独立 `save`，无统一事务 | **unknown / 弱**（见 ISSUE-006 关联） |
| INV-006 | 长期任务索引规模有界 | 未发现裁剪/归档 | **破坏**（见 ISSUE-003） |
| INV-007 | 后端入口只接受本机可信调用方 | `host=127.0.0.1` 默认 + 无 Origin 校验 | Conditional（依赖绑定地址，见 ISSUE-002） |

---

## 2. 关键路径（Critical Paths）

| ID | 入口 | 链路 | 关键不变量 | 副作用 | 信任边界 | 覆盖 | 优先级 |
|---|---|---|---|---|---|---|---|
| CP-001 | WS `/api` 聊天回合 | runner → 权限门 → run_command/write_file | INV-002 | 本机进程/文件 | ①命令放行 | Partial | **C0** |
| CP-002 | WS/REST（无鉴权） | 任意客户端 → 驱动回合 | INV-007 | 同 CP-001 | 网络入站 | Partial | **C0** |
| CP-003 | Scheduler tick（后台） | service → payload(agent_turn/team_wake) → runner | INV-002/005 | 后台命令/文件，脱离用户在场 | ①命令放行 | Partial | **C1** |
| CP-004 | dispatch_subagent / team wake（并发） | run_sync(worker thread) → 子 runner → TaskStore.upsert | INV-004/006 | 并发文件写 + 索引增长 | 进程内并发 | Partial | C1 |
| CP-005 | 计划执行回写 | update_todos → sync_plan_from_todos → plan/task/event | INV-005 | 多文件状态 | — | Complete（有单测） | C1 |

---

## 3 / 4. 风险问题（含传播链）

### ISSUE-001 · 默认模式下命令执行「默认放行 + 可绕过 deny-list」，构成提示注入→本机命令/秘密外泄链
- **Severity: P2** · **Confidence: High（机制）/ Conditional（触发）** · **Propagation Rank: PR-3** · **Critical Path: Yes**
- **关联不变量**: INV-002
- **FACT**
  - `[E1] agent/permissions/pipeline.py:111,160` | `_assess_ask_before_edit` | `run_command` 仅当 `is_high_risk_command()` 命中才要求批准，否则落到 `ask.default_allow` → **直接放行**。
    ```python
    if profile.name == "run_command" and is_high_risk_command(profile.command):
        return _approval(...)            # 仅 deny-list 命中才弹审批
    ...
    return _allow(profile, "ask.default_allow", trace)   # 其余一律放行
    ```
  - `[E1] agent/permissions/resolvers.py:10-26` | `HIGH_RISK_COMMAND` | 高风险判定是正则 deny-list（push/sudo/rm -r/-f/pip install…）。未覆盖：`cat ~/.ssh/id_rsa`、`echo evil >> ~/.zshrc`（持久化）、`mv x /dev/null`、`node -e`、`osascript -e`、`git reset --hard` 等 → 均判为非高风险 → 自动执行。
  - `[E1] agent/tools/shell.py:17-29,88` | `_DENY_PATTERNS` + `shell=True` | 第二道也是 deny-list：拦 `rm -rf /` 但不拦 `rm -rf ~` / `rm -rf .`；拦 `| sh` 但不拦 `; bash x.sh` / `| zsh`。
  - `[E1] agent/permissions/resolvers.py:106` | `is_sensitive_path` | 只对 `write_file/edit_file` 生效；`read_file('.env')` 为 read_only → 自动放行（秘密可读入模型上下文）。
  - `[E2] agent/tools/{web,search,dispatch}.py` | web_fetch/MCP/repo 文件输出进入模型上下文，构成不可信输入面。
- **REASONING**：两道防线都是「默认允许 + 黑名单拦截」。LLM 是命令的实际产出者；当其上下文混入不可信内容（抓取的网页、被注入的仓库文件、MCP 返回），提示注入可诱导模型产出一条**不在黑名单内**的破坏/外泄命令，绕过两道 deny-list 直接执行。
- **传播链**
  `[Trigger] 用户让 agent 阅读/抓取含注入指令的网页或仓库文件` → `[Source Defect] run_command 默认放行 + 高风险判定为可绕过 deny-list` → `[Intermediate] 模型产出非黑名单破坏/外泄命令` → `[Boundary] 信任边界①放行，无人工确认` → `[Persistent/External Effect] 本机文件删改 / ~/.ssh 等秘密被读出并可经出网工具外泄 / shell rc 持久化` → `[Downstream] 用户主机被破坏或凭据泄露` → `[System Capability Impact] 在「本地单用户」语境下为中度（用户多在自有可信仓库内驱动），但安全模型整体为 allow-by-default，可信度不可承重`。
- **部署语境校准**：本地单用户 + 用户在场审视，多数日常使用风险有限 → 不升 P1/P0；但「读不可信内容」是 coding agent 的常规动作，链路真实存在，故定 **P2 Conditional**。商业化/多用户场景将直接升至 P0。
- **最小修复 sketch**：把模型执行类工具改为 **allow-list 优先 / 默认 ask**：默认模式下 `run_command` 一律需批准，仅显式 allow-list（如 `pytest`/`ls`/`git status` 等只读命令）免批准；或为「会话内已读取过外部/网络内容」的回合强制 run_command 审批。`is_high_risk_command` 黑名单仅作为「即使 auto 也拒」的硬门，不作为放行依据。
- **验证**：新增权限单测——对 `cat ~/.ssh/id_rsa`、`rm -rf ~`、`echo x >> ~/.zshrc` 断言 `behavior == "ask"`（非 allow）；对 allow-list 内只读命令断言 allow。

### ISSUE-002 · 本地 Web API/WS 无认证且无 Origin/Host 校验（承重的本地假设）
- **Severity: P2** · **Confidence: High（无校验）/ Conditional（远程触发）** · **Propagation Rank: PR-3** · **Critical Path: Yes**
- **关联不变量**: INV-007
- **FACT**
  - `[E1] agent/web/app.py:31-63` | `error_middleware` 是**唯一**中间件；`web.Application(middlewares=[error_middleware])` 无鉴权/CORS/Origin 校验。
  - `[E1] agent/web/routes/*` | 所有 `/api/*` 与 WS 路由无 token/session 校验（grep 未见 Authorization/Bearer/check_origin）。
  - `[E1] agent/local_config.py:16` | `host` 默认 `127.0.0.1`（仅绑定地址在保护）。
- **REASONING**：安全完全由「绑定 localhost」承重。aiohttp 默认不校验 WS Origin；浏览器中的恶意页面可通过 **DNS-rebinding** 把域名解析到 127.0.0.1，从而对本机端口发起 WS/HTTP 请求，驱动聊天回合，再叠加 ISSUE-001 的默认放行 → 本机命令执行。若用户或打包配置把 `host` 改为 `0.0.0.0`（局域网/隧道），则同一攻击面对网络直接暴露。
- **传播链**
  `[Trigger] 应用运行中用户浏览到恶意网页（或 host 被改为 0.0.0.0）` → `[Source Defect] 无 Origin/认证校验` → `[Boundary] 远程请求被当作本机可信调用方` → `[Intermediate] 远程驱动聊天/工具回合` → 叠加 ISSUE-001 → `[External Effect] 本机命令执行/数据外泄` → `[System Capability Impact] 本地默认绑定下为 Conditional 中度；暴露绑定下为 P0`。
- **最小修复 sketch**：WS 握手与 `/api/*` 增加 Origin/Host 白名单中间件（仅允许 `app://`、`http://127.0.0.1:<port>`、`localhost`）；可叠加启动时随机生成的本地 token，由 Electron 主进程注入渲染端。
- **验证**：中间件单测——伪造 `Origin: https://evil.example` 的 WS 升级/`/api` 请求应被拒（403）；本地 Origin 放行。

### ISSUE-003 · 任务索引 `memory/tasks/index.json` 无界增长 + 全量重写（长期个人 agent 的退化点）
- **Severity: P2** · **Confidence: High** · **Propagation Rank: PR-2** · **Critical Path: Partial（CP-004）**
- **关联不变量**: INV-006
- **FACT**
  - `[E1] agent/tasks/store.py:30-51` | `upsert` 为读改写整份索引：`data=self._read(); data[id]=...; self._write(data)`；`_write` 把**全量** dict 序列化后 `tmp.replace`。
  - `[E1] agent/tasks/*` | grep `prune|archive|cleanup|retention` **无命中** → 无裁剪/归档。
  - 对比：`agent/runtime/store.py` 有 hot/cold 归档与 `compact`；`tasks` 没有同等机制。
- **REASONING**：每次 subagent 派遣 / team wake / plan_step 绑定 / scheduler run 都 `start_task` 一条 `TaskRecord` 并永久驻留。面向「个人长期使用」的产品（README 自述），记录数随使用单调增长；`upsert`/`list` 均 O(n) 全量读写 → 单次写 O(n)、长期 O(n²) I/O，索引文件持续膨胀。
- **传播链**
  `[Trigger] 长期日常使用累计大量子任务` → `[Source Defect] 索引无界 + 全量重写` → `[Intermediate] index.json 膨胀、每回合多次全量序列化` → `[Downstream] 工具回合延迟上升、磁盘占用增长、`/api/tasks` 列表变慢` → `[System Capability Impact] 长期可用性退化（与产品「长期可用」目标直接冲突）`。
- **最小修复 sketch**：为 TaskStore 增加保留策略（按时间/数量归档已完成任务到 `memory/tasks/archive/`，活跃索引只留近 N 条），复用 `runtime/store.py` 的 compact 思路；或将索引改为按状态分片。
- **验证**：插入 5k 条已完成任务后，断言活跃索引体量/`list()` 延迟在阈值内，且归档可回读。

### ISSUE-004 · 核心 God-object 模块 + 高 churn，放大回归面
- **Severity: P3** · **Confidence: High** · **Propagation Rank: PR-2** · **Critical Path: No**
- **关联不变量**: INV-001/002/005（所有者过度集中）
- **FACT**
  - `[E1] recon §2` | `control/manager.py` 1616 LoC、`runner.py` 1222、`useRuntime.ts` 1221、`types.ts` 904、`Composer.vue` 904。
  - `[E1] recon §7` | 近 90 天 churn：`runner.py` 35、`loop.py` 27、`control/manager.py` 21 次提交 —— 核心文件高频变动。
- **REASONING**：权限、计划、验证、todo、token 等多个不变量的「唯一所有者」集中在 `control/manager.py` 单文件；`runner.py` 同时承载状态机、上下文治理、工具执行、计划验证。高 LoC × 高 churn = 单点回归面大、评审困难、AI/人改动易顾此失彼。
- **最小修复 sketch**：延续已存在的 `query_state/`、`context_pipeline/`、`permissions/pipeline` 抽取方向，把 `control/manager.py` 的 plan / permission / verification 子域拆为各自模块（接口已部分存在），逐步降单文件体量。
- **验证**：拆分后核心文件 < ~600 LoC，且现有 100 个测试全绿（回归不变）。

### ISSUE-005 · 工程交付成熟度缺口（商业化视角）：无 CI、无 LICENSE、无容器化、无 pre-commit
- **Severity: P3** · **Confidence: High** · **Propagation Rank: PR-1** · **Critical Path: No**
- **FACT**
  - `[E1] recon §1` | `.github/workflows ✗`、`Dockerfile ✗`、`LICENSE ✗`、`.pre-commit-config.yaml ✗`、`CHANGELOG/CONTRIBUTING/SECURITY ✗`。
  - `[E1]` | 100 个测试文件存在、`pyproject.toml` 含 ruff/pytest 配置（recon §1/grep），但**无自动化执行**（无 CI）。
- **REASONING**：测试资产充足却无门禁守护——回归只能靠手动；缺 LICENSE 阻碍开源/商用分发；缺容器化与发布流程提高交接成本。这些不影响本地运行，但直接影响「商业化/交接」判断。
- **最小修复 sketch**：加 GitHub Actions（`pytest` + `vitest` + `ruff`），补 `LICENSE`，把 ruff/格式化纳入 pre-commit；为桌面端补一条可复现实建命令链。
- **验证**：CI 在 PR 上自动跑后端 419 + 前端 70 测试并阻断红线。

### ISSUE-006 · 状态记录钩子吞异常（broad except）可静默丢失计划/验证状态
- **Severity: P3** · **Confidence: Medium** · **Propagation Rank: PR-2** · **Critical Path: No（关联 CP-005）**
- **关联不变量**: INV-005
- **FACT**
  - `[E1] recon §4.3` | Python `except Exception/BaseException` 共 87 处。
  - `[E1] agent/tools/dispatch.py:290-292`（discovery 记录）与 `:_record_independent_verification` 的 `except Exception as exc: logger.warning(...)` | 记录失败仅告警并 `return None`，上层不感知。
- **REASONING**：plan discovery / 独立验证结果的回写位于多文件非事务写路径（INV-005 弱）；当 `record_*` 抛错被吞，PlanRecord 与 TaskRecord/evidence 可悄然不一致，UI 重放看到的是「成功但缺证据」。对单用户可恢复，但属结构性可靠性风险。
- **最小修复 sketch**：对承载不变量的回写区分「可吞」与「必须上抛/标记降级」；失败时发一条 `*_record_failed` runtime 事件，使前端与日志可见，而非纯 warning。
- **验证**：注入 `record_*` 抛错，断言产生显式降级事件且回合不静默「成功」。

---

## 5. 复核与去重说明
- ISSUE-001 与 ISSUE-002 同属安全面但**不同源缺陷、不同修复边界**（命令放行策略 vs 网络入站校验），按规则不合并；二者叠加才形成远程 RCE，单独亦各自成立。
- 已主动找反证：secrets 已全部 gitignore 且未入库（`git ls-files` 验证）、写入有原子 rename + filelock(scheduler) + corrupt 恢复、runtime event 有 replay/compact、INV-001 有配对与 checkpoint 保护——这些是真实的工程亮点，已在评分中计入，避免只列风险。
- 候选分类：ISSUE-003/004/005 = Confirmed；ISSUE-001/002/006 = Conditional（依赖明写前置：不可信输入入模型 / 远程页面或改绑定 / 记录抛错）。
- 计数与正文一致：P0=0、P1=0、P2=3、P3=3。

---

## 6. 工程化评分（诚实、不调和）

> 语境：本地单用户桌面、个人长期使用、单贡献者、活跃迭代中。下列分数为该语境下评分；括号注明「若按对外 SaaS」会如何变化。

> 下表两列分数：「审计时」为初次审计快照；「修复后」为本轮全部 ISSUE 落地后的复评（仍按本地单用户语境、诚实不调和）。

| 维度 | 审计时 | 修复后 | 依据（修复后） |
|---|---|---|---|
| 测试充分性 | 6/10 | 7/10 | 后端 448 + 前端 95 实跑通过；已加 CI 守护（pytest+vitest+ruff）；仍未见覆盖率门禁 |
| 架构与模块化 | 5/10 | 7/10 | `control/manager.py` 1616→557、`runner.py` 1222→984，God-object 拆为多个聚焦子管理器；删除死重复代码 |
| 安全边界 | 5/10（SaaS: 2/10） | 7/10（SaaS: 4/10） | run_command 改默认审批 + 低风险白名单；Origin/Host 校验 + 打包态 token；高风险计划命令仍需审批 |
| 错误处理/可观测 | 5/10 | 6/10 | 状态记录失败改为显式 `record_degraded` 事件，前端可见；其余 broad except 仍在 |
| 一致性/持久化 | 6/10 | 7/10 | 原子写 + filelock + corrupt 恢复 + event replay；任务索引已加归档去重 |
| 依赖与配置卫生 | 7/10 | 7/10 | requirements 固定、密钥 env 外置且 gitignore |
| 交付/流程成熟度 | 3/10 | 6/10 | 已补 CI + MIT LICENSE + pre-commit；仍无 Dockerfile/CHANGELOG/发布流程 |
| **综合** | **≈5/10** | **≈6.5/10** | 安全模型、模块化、交付流程均显著硬化；距完整商业化仍差发布/容器化与更深可观测 |

**交接/商业化结论（更新）**：审计时点名的三个阻塞项已全部落地 ——(1) 安全模型从 allow-by-default 改为默认审批/白名单 + Origin/token（ISSUE-001/002）；(2) CI + LICENSE + pre-commit（ISSUE-005）；(3) 核心 God-object 拆解（ISSUE-004）。任务索引退化点（ISSUE-003）也已解决。剩余面向完整商业化的工作属增量：发布/容器化流程、更深的可观测（其余 broad except）、以及对未审计区域的按需排查。

---

## 7. 未覆盖范围（诚实声明）
- 未做动态验证：DNS-rebinding/CSRF 仅静态推断（修复后已加 Origin/Host 校验中间件 + 单测，实际渗透未动态实证）。
- 未审 `desktop-pet/` 子项目、`agent/loop.py` 全量装配链、MCP 外部 server 行为、providers 重试/退避细节 —— **已与负责人确认接受为「已知未审计」，本轮不扩范围**（见「修复状态 · 残余与已知未审计」）。
- 「在已审计的 permissions/control/tools/web/stores 范围内」得出上述结论；未覆盖路径仍可能存在其它风险。
- 「未发现」一律仅代表已覆盖范围内证据不足，不等于不存在。
