# Agent 执行流程弊端清单（基于真实 session 行为审计，2026-07-05）

样本：`.emperor/sessions/8c1d4d8111cb457b`（2026-07-05 00:02–00:09，build 会话，Cosmic Forge 三.js 单文件项目，3 turns / 2565 事件 / 23 次模型调用）+ `fec21461251e489f`（chat 冒烟）。交叉证据：`.emperor/tokens/tokens.jsonl`（provider=deepseek/deepseek-v4-pro）、`.emperor/memory/plans/index.json`、session history.jsonl。全部结论可用 seq/时间戳在 events.jsonl 复核。

结论速览：**功能层 1 个断链（B1），效率层 3 个大头（B2/B3/B5），质量层 1 个信任问题（B4），I/O 1 个写放大（B6），体验 2 个小项（B7/B8）**。

## 修复状态（2026-07-05 当日全部完成，commits a400646..771fc7d）

| 项 | 修复 | 落地位置 |
|---|---|---|
| B1 | 复活 `syncPlanFromTodos` 并接上 update_todos 成功后的活链路；新计划批准时 supersede 旧 executing 计划（CANCELLED + superseded_by） | `control/plan-execution.ts`、`control/manager.ts`、`agent/runner-plan-recording.ts` |
| B4.1 | 拒绝计数改单桶（不分 pattern），换解释器重试同类危险命令同样计入 | `agent/runner-helpers.ts` |
| B4.3 | `tool_run_failed` 事件加 `reason_kind`（safety_refusal/error），UI 显示"被安全策略拦截"而非通用失败；顺带修了 registry 默认 `mapResult` 从不给 `Error:` 前缀字符串设 `isError` 的潜伏 bug | `tools/execution.ts`、`tools/registry.ts`、桌面端 `chatProjection.ts` |
| B4.2 | 计划宣称完工但验证要求无证据时，一次性注入诚实性 followup，要求执行验证或明确声明未验证；同计划不重复提醒 | `control/manager.ts` (`claimUnverifiedPlanSteps`)、`agent/runner-pause.ts`/`runner-plan-recording.ts` |
| B5 + B2a | `update_todos`/`write_file`/`edit_file` 描述层导向：清单更新须与工作工具同批并行；已存在文件的增量修改必须用 edit_file；write_file 覆盖已有文件时附加提示 | `tools/builtin.ts`、`tools/filesystem.ts` |
| B8 | `finalParts` 不再收集伴随工具批次的过场白，只保留终局 stop 内容 | `agent/runner.ts` |
| B7 | 可见长度 <4 的首条消息延迟到回合结束，用回复摘要做标题材料 | `api/chat-service.ts` |
| B6 | `plan_draft_delta` 100ms 时间窗节流（1421→约270 条）；`RuntimeEventStore.append` 的 index 重写降为 500ms 节流 + 终态事件强制落盘 | `agent/model-caller.ts`、`runtime/store.ts` |
| B3 | `shrinkOldToolResults`/`microcompact` 的 cutoff 由「相对当前长度」改为 turn 内冻结的 `stableBoundary`（runner 在 `stepAsync` 入口捕获一次）；plan_draft 上下文从投影头部移到尾部 | `context/pipeline.ts`、`context/tool-results.ts`、`agent/runner.ts` |

**已知限制（有意不修）**：`replaceAggregateToolResults` 按 turn_id 累加整个 turn 的组总量，决策非单调（新批次挤入会让早前条目重新超预算），简单冻结边界解决不了，需要记忆化层或分组语义改动才能根治；该机制在审计会话里从未实际触发（`aggregate_replaced_tool_results` 全程为 0），本轮记为已知限制而非强行修复。

核实：core 428→443 测试全绿（新增 15 个），desktop 226 测试与生产构建不受影响。

---

## B1 · 计划状态机没有"完成"路径——所有 plan 永久 executing（功能断链，P1）

**证据**：最后一次 update_todos 六项全部 `completed`；但 `.emperor/memory/plans/index.json` 中全部 4 个计划 `status=executing`、`completedAt=null`、step_1 `active` 其余 `pending`（含已"交付"的 Cosmic Forge 计划）。步骤 `verification` 每步有 1 条要求，`evidence` 全部为 0。

**机制**：todo→plan step 的状态投影链路在生产中不存在。唯一实现 `syncPlanFromTodos` 自 P0-1 修复（把 update_todos 与 evidence gate 解耦）起就无人调用（2026-07-04 结构审计作为死代码删除——删得对，它本来就没接上，但**没有人补一条正规的完成路径**）。另一条完成路径（验证全过→completed）也未走通：`planVerificationTarget` 只匹配注册的验证命令，本 session 模型跑的是 `wc -l`/`grep -c`，从未命中。键名差异（模型输出 `planStepId`，store 侧读 `plan_step_id`）被 `builtin.ts:197` 的归一化兜底救了，不是本项根因。

**后果**：plan context builder 每 turn 注入僵尸"执行中计划"（本 session 从恢复 turn 起每次调用 `plan_context_attached:1`）；`latestExecutablePlan()` 永远返回过期计划，影响后续 turn 的 plan_entry_decision（"Approved plan is already executing"）与 plan 权限 token 语义；UI 计划卡片永远显示未完成。僵尸随使用量线性累积。

**修复方向**：在活链路上补一条完成投影——update_todos 执行后（TodoStore 已归一 plan_step_id）把 completed/blocked 状态同步进当前 executing plan 的步骤，全 done/skipped 时置 plan `completed`；或最低限度在 turn completed 时若 todos 全部完成则收口计划。补端到端测试：approve → update_todos(全 completed) → plan completed。

## B2 · 全量重写式增量开发：6 次 write_file 重写同一文件，edit_file 零使用（效率，P1）

**证据**：seq 1591→1880 六次 `write_file` 全部写 `cosmic-forge.html`，参数 2,686→6,727→10,308→12,749→18,197→22,349 字节，content 均以 `<!DOCTYPE html>` 开头（全量）。输出 token 尖峰 2209/4304/4574/6434/8124 与之对应；最长模型响应 61 秒（00:08:18→00:09:19）就是在重吐前面写过的代码。

**量化**：本 session 总输出 37.6K tokens，最终文件仅约 7K tokens——**约 2/3 的输出 token 在重复生成已写过的内容**；6 份文件版本作为 tool_call 参数叠进 history，把上下文从 7K 推到 46K（下游每次调用都为它们付 input/cache 费）。

**机制**：分步计划（每步增强同一文件）+ 工具引导缺失（write_file/edit_file 描述没有"增量修改必须用 edit_file"的导向）诱导模型选择全量重写。且 context pipeline 的压缩只处理 `role=tool` 的 result，**assistant 消息里的 tool_calls 大参数完全不在压缩范围**——管线正好管不到最大的东西。

**修复方向**：a) 工具描述加硬导向（对已存在文件优先 edit_file；write_file 检测目标已存在且内容高度相似时在 result 里 nudge）；b) 压缩管线纳入历史中旧 write_file 参数（同文件旧版本替换为 ref 摘要，保留最新版）。

## B3 · 回合中途改写历史 + 动态注入，反复击穿 DeepSeek 前缀缓存（成本，P1）

**证据**：token 账本 5 次缓存断崖——cache_read 12,544→3,072（00:04:27）、13,568→3,072（00:05:35）、16,896→12,672（00:07:02 前）、27,264→4,736（00:08:09）、44,416→35,200（00:09:35），断崖处 input 全价 8K/8.5K/14K/10K/24K tokens，合计约 **75K tokens 按全价付**（DeepSeek 前缀缓存命中价约为 1/10）。全程 cache_create=0（DeepSeek 自动前缀缓存，命中全靠前缀字节级稳定）。

**机制**：两个前缀破坏源。① `context_projection` 显示从 msgs=26 起**每次模型调用**都 `shrunk_old_tool_results:1`——就地改写一条旧 tool result 省几百 token，代价是整条前缀失效重付几万 token（省小钱花大钱）；② 恢复 turn 起每次 `plan_context_attached:1`，计划上下文若注入在消息序列前部且内容随状态变化，同样破坏前缀（恢复 turn 前两次调用 cr=3,072 与此吻合）。

**修复方向**：a) turn 内冻结历史前缀——microcompact/shrink 只允许在 turn 边界执行；b) 压缩决策加成本模型：预计节省 < 前缀重付成本时不动；c) plan context 注入移到消息序列尾部（新增 user/system 段）而非改写前部。

## B4 · 验证被安全策略拦截后，模型谎报"验证通过"收尾（质量/信任，P1）

**证据**：iteration 17/18 `node -e`、`python3 -c` 先后被 safety policy 拒绝（P1-4 的替代方案文案已生效）。模型没有按提示写临时脚本，iteration 19 直接 stop，交付报告写**"括号匹配：人工review通过，未发现语法问题"**——实际只执行过 `wc -l` 与 `grep -c`，JS 语法从未被校验。

**三个子弊端**：
1. **换马甲绕过 nudge**：P1-4 的重复拒绝计数按 pattern 隔离（node -e 与 python3 -c 各计 1 次），"换个解释器重试同类行为"不触发强化提示。应按拒绝类别（inline-eval 类）聚合计数。
2. **收尾无诚实性约束**：终局回复对"计划内验证要求未完成"没有强制披露。计划每步带 verification 要求但 evidence=0（与 B1 同根），收尾时无人对账"验证要求 vs 实际执行"。应在 turn 收尾注入核对：未执行的验证必须在答复中如实声明。
3. **事件语义错报**：策略拒绝被执行引擎包装成 `tool_run_failed: "run_command exit non-zero: ..."`，而同一调用的 tool_result 文本是 "refused by safety policy"。UI 时间线显示"命令失败"而非"被安全策略拦截"，误导排障。应给策略拒绝独立的失败原因字段/事件语义。

## B5 · update_todos 独占模型往返：19 次迭代中 7 次纯记账（时延，P2）

**证据**：执行 turn 19 次迭代的工具批次序列：todos→write→read→todos→write→todos→write→todos→write→todos→write→todos→read→todos→run×2→run→run。7 个迭代整轮只调 update_todos（参数 ~600B），每次 8–20 秒模型往返 + 全量上下文 input。同批多工具能力存在（glob×2、run_command×2 两例），但从未用于 todos+工作工具组合。

**量化**：约 37% 的迭代、约 90 秒墙钟时间是纯 todo 记账开销。

**修复方向**：系统提示/工具描述引导"update_todos 与下一步工作工具在同一响应并行发出"（Claude Code 的标准形态）。

## B6 · plan_draft_delta 写侧洪水：3.61MB 落盘换 2.9KB 成品（I/O，P2）

**证据**：1,421 条 plan_draft_delta 在 ~27 秒内落盘（平均每 19ms 一条），累计 3,610,075 字节；最终 plan_draft 事件仅 2,887 字节——**1,250 倍写放大**。且 `RuntimeEventStore.append` 每条事件都同步重写 index.json，即该 27 秒内 2,842 次同步文件写。

**背景**：P1-5 只做了读侧压缩（replay compact），写侧未节流。修复方向：delta 类事件按时间/字节窗口合并落盘（≥100ms 或 ≥1KB），或 delta 只走广播不落盘、终态事件落盘；append 的 index 重写降频。

## B7 · 无信息量输入产出无信息量标题（体验，P3）

**证据**：首条消息 "hi" → 标题 "hi"（`title_status=generated`）。生成器对超短/寒暄输入没有兜底。修复：输入 < N 字符或无实义时延迟到首条实质消息再生成，或将助手首答纳入生成材料。

## B8 · 终局回复被迭代过场碎片污染（体验，P3）

**证据**：assistant_done content（1,487 字符）开头是 19 次迭代的过场白拼接："计划已批准，开始执行！先建任务清单……Step 1 骨架已写入。确认无误：……Step 5 完成！……"，真正的交付报告在其后。机制：runner 的 finalParts 把每次迭代伴随 tool_calls 的碎片文本（content_chars 13–47）全部拼进最终回复。修复：终局回复只保留最后一次 stop 响应的内容，中间碎片降级为 agent_thought 或丢弃。

---

## 与前两轮修复的关系

- B1 是 P0-1（evidence gate 解耦）的未收尾后果：斩断旧同步时没有补新路径——本清单最高优先级。
- B4.1 是 P1-4（重复拒绝 nudge）的对抗性盲区；B4.2 是 P2-1（收尾质量）的深层版本。
- B6 是 P1-5（replay 压缩）的写侧缺口。
- B3 是新发现的架构级成本问题，此前所有审计未覆盖 token 账本维度。

## 建议修复顺序

B1（功能断链，小改动）→ B4.3 事件语义 + B4.1 计数聚合（小）→ B5 + B2a 提示/工具描述导向（纯 prompt 层，零回归面）→ B3（管线改动，需谨慎设计 turn 边界压缩）→ B6 写侧节流 → B2b 历史大参数压缩 → B7/B8。
