# Emperor Agent 系统风险审计报告（结构债专项，2026-07-04）

> 本报告取代 2026-06-25 的 Python 时代审计（旧报告针对 aiohttp/webui 架构，其 9 项 ISSUE 均已随 TS 迁移落地或失效）。
> 审计性质：只读、基于仓库证据；未实际执行的命令/测试不写成「已通过」。

- 仓库：`/Users/anhuike/Documents/workspace/emperor-agent`，分支 `codex/redundant-file-cleanup`，基线 commit `303c5f6`
- 定调：本地个人 Electron 桌面 AI Agent（core 在主进程经 IPC，Vue 3 renderer）；无对外端口、无多租户
- 审计目的：继续开发前清理结构性技术债（屎山 / 补丁式修改），按要求忽略风格级小问题
- 证据方式：recon 硬数据（LoC/churn/grep 计数）+ 两路全仓扫读 + 主对话逐条 file:line 抽查复核
- 已执行：`wc -l`、`git log --name-only` churn、多组 `grep -rn` 交叉验证、`git ls-files`；未执行：本轮未跑测试/构建（审计只读，前一轮基线为 core 430 + desktop 233 全绿）
- 范围排除：docs/、skills/、templates/、desktop-pet/（非关键链路）

## 0. 结论速览

**无新增功能性 P0/P1。** 前两轮修复后，取消链路、session 归属、溢出恢复等运行时风险已收敛；本轮发现的全部是**结构债**：P2 × 6、P3 簇 × 3。核心病灶一句话：**渲染层同一套聊天投影逻辑存在两份平行实现，后端到前端的事件契约靠手抄维持，且多处"改行为时留旧机器"的补丁式修改从未回收。**

| 级别 | 数量 | 编号 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 6 | A1 A2 A3 A4 A5 A6 |
| P3 | 3 簇 | A7 A8 A9 |

## 1. 系统模型（简）

**模块图**：`desktop/main`（Electron 主进程，`ipc.ts` 注册 → `CoreApi` 20 命名空间门面）→ `packages/core`（`AgentLoop` 装配根 → `AgentRunner` 回合状态机 → providers / tools / control / plans / sessions / runtime / scheduler / team）；`desktop/renderer`（`App.vue` → `useRuntime`（事件消费+投影）/`useSession`（会话索引）→ chat 组件树）。

**关键路径**：
- **CP-001 chat turn 写路径**（C0）：Composer → `useRuntime.sendMessageViaCore` → IPC `chat.submit` → `MainlineTurnService.submit`（draft 晋升/激活 session）→ `AgentLoop.runUserTurn`（ActiveTaskRegistry + AbortController）→ `AgentRunner.stepAsync`（模型→工具→控制暂停→compaction）→ 事件经 `RuntimeEventStore.append` 落盘 + eventSink 广播 → renderer `handleSocketEvent` 投影。
- **CP-002 replay 读路径**（C1）：bootstrap / `runtime.replay` → `RuntimeEventStore.replayAfter({compact})` → renderer `projectChatEvents`（纯 reducer）。
- **CP-003 control 交互路径**（C0）：ask/plan 工具 → `TurnPaused` → 交互事件 → 用户应答 → `ControlManager.answer/approve` → 隐藏 control user_message 新 turn 续跑 → 投影 resume（`pendingControlResumeAssistantId`，live 与 replay 各一份）。

**关键不变量**：
- INV-001 tool_use↔tool_result 严格配对（core 注释明示，pairing 兜底）。
- INV-002 高影响命令须经审批/安全策略。
- INV-003 任何 runtime 事件可归属到 session（前两轮已加固）。
- INV-004 **live 投影终态 ≡ replay 投影终态**——当前仅靠"两边同步打补丁 + 双份测试"维持，无结构保证。**A1 直接威胁此不变量。**
- INV-005 desktop 事件类型 ⊆ core 事件 schema——当前靠手抄维持，已漂移（A4）。

## 2. 正式问题（P2）

### ISSUE-A1 · 双生投影：live 与 replay 两套平行实现 —— P2 · Confirmed · High · Critical Path: Yes
- **FACT**：以下 12 个函数在 `desktop/src/renderer/src/composables/useRuntime.ts`（live，1758 行）与 `desktop/src/renderer/src/runtime/chatProjection.ts`（replay）各有一份实现：`assistantForEvent`、`ensureToolSegment`、`updateControlSegment`、`findControlSegment`、`mergeControlInteraction`、`finishActiveThought`、`syncAssistantDoneContent`、`controlInteractionStreamId`、`eventTimeMs`、`finishTimedState`、`bindControlResumeTurn`；另 `useRuntime.ts:1281` 重复 `toolDisplay.ts:10` 的 `toolDisplayName`。`handleSocketEvent`（`useRuntime.ts:659` 起）~40 个事件分支重写 reducer 已有语义。
- **实证成本**：最近三轮修复中 queued 状态、tool settle、control resume、draft 过滤每项都在两个文件各改一次、各写一份测试（两个测试文件存在成对用例）。
- **传播链**：[新渲染需求] → [只改一侧] → [live 与 replay 终态分叉] → [刷新/重启后 UI 与刚才所见不一致]（破坏 INV-004）→ [时间线断裂类 bug 反复回归]。
- **最小修复**：`chatProjection.ts` 升级为唯一 reducer；`useRuntime` 持 reactive `ChatProjectionState`，live 事件走同一 `applyChatProjectionEvent`；副作用（pending/busy/toast/session 状态槽）留 switch。删 12 个重复函数。
- **验证**：useRuntime.test（30）+ chatProjection.test（7）原样通过；手工流式对话 + ask/plan 暂停恢复。

### ISSUE-A2 · 假 REST 路由表：半截子 HTTP→IPC 迁移 —— P2 · Confirmed · High · Critical Path: Yes
- **FACT**：产品已无 HTTP/WS 通道（`api/backend.ts:1-2` 注释明示），但 `api/http.ts:21-124` 维护 ~90 分支 `coreRoute`，把虚构 `METHOD + /api/...` 翻译回 `invokeCore` op 名；12 个文件 ~46 个调用点走 `api('/api/...')`，10+ 处直接 `invokeCore`；同一操作双通道可达（`skills.importArchive`、`control.get`、`control.cancelInteraction`），无规则约定走哪个门。
- **传播链**：[新增 core op] → [再发明假 HTTP 路径 + 路由分支] → [调用风格继续分叉] → [每个操作要查两条路径] → [维护成本与误改面放大]。
- **最小修复**：调用点逐命名空间改直接 `invokeCore`，删路由表，留薄错误封装。

### ISSUE-A3 · runner.ts 神类 + planFollowup 死代码簇 —— P2 · Confirmed · High · Critical Path: Yes
- **FACT**：`agent/runner.ts` 1145 行 ~13 项职责；5 个可空协作者 55 处 null-guard。死代码簇：`control/plan-verification.ts:79-81` `planCompletionFollowup(){ return null }` 是**唯一实现**，但 `runner.ts:503-529` 完整保留 followup 注入 + `seenPlanFollowups`(:276) + `planFollowupSignature`(:1135) + `plan_followup_loop` degraded 发射——生产不可达。`syncPlanFromTodos`：host 接口声明（runner.ts:115）+ manager 代理（manager.ts:505-506）+ plan-execution.ts:34 起 60+ 行实现 + 孤儿依赖 `latestExecutablePlan`，零非测试调用方（grep 已证）。
- **背景**：P0-1/P0-2 的补丁式收法——"源头改 return null，下游机器原样留着"。
- **传播链**：[修改回合逻辑] → [必须理解一台永不运转的机器] → [误判为活逻辑并围绕其设计] → [变更成本与错误理解累积]。
- **最小修复**：整簇删除；host 接口删两个死成员。

### ISSUE-A4 · 事件契约手抄平行维护，漂移无告警 —— P2 · Confirmed · Medium · Critical Path: Yes
- **FACT**：`desktop/types.ts:919` `WsEvent = CoreRuntimeEvent & (手抄 70-variant union)`；core `runtime/types.ts` 同为 70 variant。每个新事件两处同改，且漂移完全静默（交叉类型使不匹配字段静默 never/宽化，typecheck 不报）。另 ~8 个镜像枚举 union 带 `| string` 逃生门。
- **勘误（整改期核实）**：初扫报告的"76 vs 70 已漂移 6 个变体"不成立——76 是全文件 grep 含 6 个重复名的误计，唯一名集合两侧完全一致。真实缺陷是"漂移无告警"而非"已漂移"。
- **传播链**：[core 改事件名/字段] → [desktop 手抄未同步] → [交叉类型静默吞掉差异] → [运行时 UI 缺字段无人知晓]（威胁 INV-005）。
- **修复（已落地 W5）**：编译期奇偶校验绊线——`WsEventVariants['event']` 与 `CoreRuntimeEvent['event']` 双向子集断言，任一侧漂移即 typecheck 报错并点名事件；控制枚举改从 core 派生。payload 级全量类型上移评估为高churn低边际收益，记为接受的债（绊线已消除静默性）。

### ISSUE-A5 · 三层恢复机制叠放 + rehydrating 补丁旗 —— P2 · Confirmed · Medium · Critical Path: Yes
- **FACT**：`useRuntime.ts:583-627` 早退优先级：runtime replay → localStorage snapshot（`persistence.ts` 含 `LEGACY_IN_FLIGHT_STORAGE_KEY`，双 timer 400ms/5000ms 持续全量写入）→ plain history。snapshot 层已被 replay 降级但写路径全在。`rehydrating` flag(:54) 穿透 live handler 抑制 :862/:1528 两处副作用——replay 复用 live 通道的补丁。
- **传播链**：[恢复行为改动] → [三层各有语义、两层过时] → [改一层漏两层] → [刷新/重启恢复行为不可预测]。
- **最小修复**：replay 恒可得（core 本地进程），删 snapshot 子系统；投影统一后 replay 不再走 live handler，`rehydrating` 一并删。删的是用户可见兜底，需手工验证流式中刷新、强杀重启。

### ISSUE-A6 · loop.ts 神编排 + Host 接口迁就最弱实现者 —— P2/P3 · Confirmed · Medium
- **FACT**：`agent/loop.ts` 796 行、34 个 deep import 装配 ~20 子系统（装配根深引用可接受，但 per-session 状态、workspace 解析、两个 `ControlManagerRunnerHost` 内联工厂（:644,:659）混在其中）；`ControlManagerRunnerHost`（runner.ts:100-121）8 必选 + 10 可选成员，可选性为迁就只实现 8 个的 `permissionOnlyControlHost`；`maybeCompactStartup()`（loop.ts:692-696）被 :219 活调用的空 hook。
- **最小修复**：抽 session-context 与 control-hosts 模块；接口删死成员；空 hook 删除。

## 3. P3 簇

- **A7 重复规则**：`cleanString` 3 处 2 种语义（`runtime/store.ts:333` 丢非字符串 vs `scheduler/service.ts:262`/`external/service.ts:283` 字符串化）；`'draft:'` core 3 处硬编码（chat-service.ts:74,164、core-api.ts:560），常量只在 renderer；截断 marker 双份（tools/registry.ts:127 vs context/tool-results.ts:57）；8000 预算 4 处独立声明；`durationLabel` 逐字 4 份；枚举存在但热点裸字面量（runner.ts:828）。
- **A8 组件揣业务逻辑**：App.vue 609 行 script 装 slash-command REPL（executeSlashCommand:197 + ~10 个 render*，与 commands.ts 割裂）；SessionSidebar.vue 手工排序算法（:231-263，sidebarModel.ts 在旁边闲着）；Composer.vue 791 行含完整附件管道。
- **A9 死代码**：`ToolEvent.vue` 零引用（复核），携第 4 份 durationLabel + 过期 displayName/toolPurpose 副本；TodoStore W04 compat shims（builtin.ts:247-252）。

## 4. 反证与未覆盖

- **主动找过的反证**：`core-api.ts` 20 命名空间门面判定为 IPC 路由注册表本职形态，**不算屎山**，记为"接受的债"；loop.ts 装配根 deep import 属合理模式仅降级处理；单消费者组件（ActiveAskPanel/ActivePlanDecisionPanel/AskHistoryCard/reducer.ts/selectors.ts）确认在用非死码；`.emperor`/`memory`/`.team` 状态目录未入 git；Python `agent/`、旧 `webui/` 已从工作树移除（churn 是历史记录）。
- **未覆盖（不下结论）**：Electron main 安全配置（contextIsolation 等）；providers 上游错误分类完备性（仅抽查）；docs/ 43 篇内容时效性。

## 5. 工程化评分（诚实版）

| 维度 | 分 | 依据 |
|---|---|---|
| 测试 | 7/10 | 663 个测试（core 430 + desktop 233）且为真实行为契约；扣：Vue 组件层零覆盖、无 E2E |
| 结构 | 4/10 | 双生投影、假路由表、手抄契约、三个 1000+ 行热点、死代码簇——本报告主体 |
| 一致性 | 5/10 | 枚举/常量/工具函数重复且语义分叉；调用风格双轨 |
| 可观测 | 7/10 | runtime 事件流完备、degraded 事件、prompt snapshot；扣：日志分级使用无规范 |
| 文档 | 6/10 | 迁移契约/审计记录齐全；扣：docs 未标时效，多篇过时无弃用标记 |

## 6. 整改结果（2026-07-04 当日完成，commits 7366bfb..191f20e）

| Wave | 对应 ISSUE | 结果 |
|---|---|---|
| W1 | A3死簇/A7/A9 | planFollowup 死簇、syncPlanFromTodos 链、ToolEvent.vue、TodoStore shims、空 hook 全删；cleanString/draft:/截断标记/8000 预算/durationLabel 单一来源化（thoughtDisplay 的 '0ms' 变体经核实为有意差异，保留并注释） |
| W2 | A1 | chatProjection 成为唯一 reducer，live 经响应式 adapter 驱动同一 `applyChatProjectionEvent`；12 个重复函数删除；reducer 吸收 live 语义（收养无 turn 助手、schedulerMeta、逐事件 thought、plan delta meta 归一） |
| W3 | A5 | localStorage snapshot 子系统（persistence/snapshot + LEGACY_ key + 双 timer）整体删除；恢复收敛为 replay → plain history 两层；rehydrating 仅余非 chat 事件回放一个用途 |
| W4 | A2 | coreRoute 假 REST 路由表删除；46 个调用点直呼 op 名；`core<T>(op,...)` 薄封装 |
| W5 | A4 | **勘误后**改为编译期奇偶校验绊线（双向子集断言，漂移即报错点名事件）+ 控制枚举从 core 派生；payload 全量上移记为接受的债 |
| W6 | A8 | App.vue 638→261 行（slash REPL → useSlashCommands + statusRender 纯函数）；SessionSidebar 排序算法下沉 sidebarModel；Composer 附件管道 → useAttachments |
| W7 | A3/A6 残余 | runner 1145→953（plan-recording 六函数 + pause 家族 + nudge 下沉）；loop 796→761（两个 control host 工厂下沉）；emit 家族与 loop session-context 按裁剪条款放弃（纯搬家无内聚收益） |

**收尾侦察对比**：重复投影函数 12→0；假路由分支 ~90→0；useRuntime 1758→1309（预估 <900 未达成——剩余为 team/scheduler/subagent 事件处理等真实职责，非重复代码）；App.vue 638→261。全程 core 428 + desktop 225 测试与双侧 typecheck、生产构建全绿（测试数变化均来自删除死 API 用例与新增模块测试）。

**遗留（接受的债）**：core-api.ts 20 命名空间门面（IPC 注册表本职）；事件 payload 级类型仍双份（绊线已消除静默漂移）；runner/loop 进一步拆分；Vue 组件层零测试覆盖。

## 6.1 原整改路线

W1 死代码与重复规则清除 → W2 双生投影统一 → W3 恢复机制收敛 → W4 假路由表清除 → W5 事件契约单一来源 → W6 组件逻辑下沉 → W7 runner/loop 安全拆分。详细步骤见 `.claude/plans/bug-md-merry-valiant.md`。

## TOP 5 风险排序（按传播能力）

1. ISSUE-A1 | 双生投影 live/replay 平行实现 | PR-2 | P2
2. ISSUE-A4 | 事件契约手抄漂移 | PR-2 | P2
3. ISSUE-A3 | runner 神类 + planFollowup 死簇 | PR-3 | P2
4. ISSUE-A2 | 假 REST 路由表半截迁移 | PR-3 | P2
5. ISSUE-A5 | 三层恢复机制叠放 | PR-3 | P2
