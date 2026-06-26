# Plan 批准后仍被 PLAN_GUARD_REQUIRED 拦截的问题诊断

日期：2026-06-25

范围：`AgentRunner`、`ControlManager`、`PlanDecisionPolicy`、工具权限/只读判定

状态：已定位根因，尚未修改运行时代码

## 问题摘要

用户批准 Plan 后，运行态显示计划已进入 `executing`，但 Agent 执行第一步时，`run_command`、`write_file` 等工具仍持续返回：

```text
Error: PLAN_GUARD_REQUIRED
reason: High-impact implementation should be planned before writing.
```

这导致已经批准的复杂任务无法真正落地。实际案例中，Agent 尝试创建 `mario/` 项目目录、写入 `constants.js`、`main.js`、`index.html`，以及运行 `pwd`，全部被 Plan Guard 拦截。

## 结论

这是后端 Plan Guard 状态机误判，不是前端展示问题，也不是 Plan 未批准成功。

Plan 批准后，`ControlManager` 确实把计划推进到了 `executing`。但 `AgentRunner` 在每个工具批次执行前，会再次基于“最新用户文本”调用 `assess_plan_decision()`。批准后的控制消息包含完整计划正文，正文中有“架构设计”“执行步骤”“实现”“多步骤”等高影响关键词，于是 `PlanDecisionPolicy` 再次返回 `required`。随后 `_plan_guard_blocks_tool()` 在普通权限判断之前拦截所有非只读工具。

因此，系统进入了一个矛盾状态：

- durable plan state：`executing`
- tool gate decision：`required plan before writing`

这两个状态没有被正确协调。

## 证据

只读复现脚本未修改任何文件，模拟 Plan 创建、批准，再把 approval resume message 交给 `assess_plan_decision()`。结果如下：

```text
mode= ask_before_edit
plan_status= executing
draft_phase= executing
decision= required
signals= ['architecture', 'feature', 'multi_step']
reason= High-impact implementation should be planned before writing.
```

这个结果说明：

- `approve()` 和 `_activate_approved_plan()` 路径正常。
- Plan 已经持久化为执行态。
- 误拦截发生在执行前的二次 plan decision 判断。

## 根因链路

### 1. Plan 批准路径正常

相关文件：`agent/control/manager.py`

关键位置：

- `approve()` 调用 `_activate_approved_plan()`。
- 之后恢复进入 Plan 前的权限模式，通常是 `ask_before_edit`。
- pending 被清空。

这一步不是问题源头。实测可见 plan 已进入：

```text
plan_status=executing
draft_phase=executing
```

### 2. Runner 在工具批次前重新评估 Plan Guard

相关文件：`agent/runner.py`

在模型返回工具调用后，Runner 会再次执行：

```python
plan_decision = self._assess_plan_decision(history)
tool_messages = await self._execute_tool_calls(..., plan_decision=plan_decision)
```

这个 `plan_decision` 随后进入 `_plan_guard_blocks_tool()`。

### 3. PlanDecisionPolicy 不知道已有 executing plan

相关文件：`agent/control/plan_drafting.py`、`agent/control/plan_policy.py`

`assess_plan_decision()` 目前只传入：

- `user_message`
- `mode`
- `has_pending`

它没有传入或查询：

- 当前是否存在 `APPROVED` / `EXECUTING` plan。
- 最新用户消息是否是 `[CONTROL:PLAN_APPROVED]`。
- 当前 turn 是否属于批准后的计划执行续跑。

`PlanDecisionPolicy` 的跳过条件只有：

- 当前仍在 `plan` mode。
- 有 pending ask/plan。
- 用户文本明显包含“PLEASE IMPLEMENT THIS PLAN”等计划标记。
- 小型直接修改。

批准后 `mode` 已经恢复为 `ask_before_edit`，pending 也已清空，所以这些跳过条件都不成立。

### 4. 批准消息本身触发高影响信号

批准后的 resume message 会带上完整计划正文和执行契约。计划正文中常见这些词：

- 架构设计
- 实现
- 执行步骤
- 多模块
- 测试
- 安全/权限

这些词会被 `_collect_signals()` 识别为：

- `architecture`
- `feature`
- `multi_step`
- `security`

其中 `architecture`、`security` 等属于 hard signals，会让 `_requires_plan()` 返回 `True`，最终得到：

```text
behavior=required
reason=High-impact implementation should be planned before writing.
```

### 5. Plan Guard 在权限层之前拦截工具

相关文件：`agent/runner.py`

`_plan_guard_blocks_tool()` 的逻辑是：

```python
if decision.behavior != "required":
    return False
if call.name in {"ask_user", "propose_plan", "update_todos"}:
    return False
return not tool.is_read_only(call.arguments)
```

所以只要二次 plan decision 是 `required`，所有非只读工具都会被挡住。

### 6. `pwd` 被拦截的附加原因

相关文件：`agent/tools/base.py`、`agent/tools/shell.py`

`run_command` 没有覆写 `is_read_only(arguments)`，基类默认只看：

```python
return bool(self.read_only)
```

而 `RunCommand` 本身未设置 `read_only=True`。因此即使是 `pwd` 这种低风险命令，在 Plan Guard 眼里也属于非只读工具。

注意：普通权限层可能有低风险命令 allowlist，但 Plan Guard 执行在普通权限判断之前，所以 `pwd` 还没机会进入 allowlist 就已被拒绝。

## 为什么切换 auto 不一定能解决

`auto` 是普通权限模式，影响的是后续 `PermissionPolicy` / `PermissionPipeline`。

但本问题发生在普通权限层之前：

```text
_plan_guard_blocks_tool()
  -> 拦截
  -> 不进入 assess_permission()
```

所以只要 `PlanDecisionPolicy` 继续返回 `required`，切到 `auto` 也可能继续被挡。

## 影响范围

高影响复杂任务被批准后可能无法执行，包括：

- 多文件项目生成。
- 架构改造。
- 前端 UI 改造。
- release / deployment 类任务。
- 权限、安全、调度器、MCP 等模块改造。

尤其容易出现在下面两种消息之后：

- `[CONTROL:PLAN_APPROVED]` resume message 包含完整计划正文。
- Agent 后续通过 `ask_user` 询问“权限模式/系统层面确认”后，用户答案又包含“权限”“安全”等关键词。

## 现有测试缺口

当前测试覆盖了：

- 高影响请求未计划时应触发 `PLAN_GUARD_REQUIRED`。
- Plan 批准后会创建 active step / todo。
- Plan step 需要验证证据后才能完成。
- Approved plan verification command token。

但缺少一个关键回归测试：

```text
已经存在 executing plan 时，Runner 不应再次用 approval resume message 触发 PLAN_GUARD_REQUIRED。
```

也缺少一个辅助测试：

```text
Plan Guard 与 run_command 低风险/只读命令的判定边界应明确，pwd/git status 等是否允许要由同一套规则决定。
```

## 建议修复方向

### 方向 A：PlanDecisionPolicy 增加 executing plan 豁免

在 `assess_plan_decision()` 层加入 durable plan state 判断：

- 如果存在最新 `APPROVED` / `EXECUTING` plan，且没有 pending plan/ask 阻塞，则返回 `proceed`。
- reason 可为 `Approved plan is already executing.`
- signal 可为 `executing_plan`。

优点：

- 修复点接近根因。
- 语义清晰：已经批准并执行的计划不应再次要求计划。

风险：

- 需要避免过宽豁免。用户在执行期间提出一个全新的高影响需求时，仍应能够触发新的 plan guard。

建议配套条件：

- 仅对 `[CONTROL:PLAN_APPROVED]`、`execute approved plan`、`continue approved plan`、Plan follow-up 类 resume message 豁免。
- 或在 `AgentRunner` 中传入当前 turn source / control resume marker，而不是仅靠文本关键词。

### 方向 B：Runner 在工具批次前跳过已批准计划续跑的二次评估

在 `AgentRunner._assess_plan_decision()` 或调用点增加判断：

- 若 `control_manager._latest_executable_plan()` 存在，并且 history 最新用户消息来自 Plan approval / plan continuation，则不执行 entry plan guard。

优点：

- 避免影响独立的 PlanDecisionPolicy。
- 直指 Runner 工具执行前误拦截。

风险：

- 需要注意封装边界，不应让 Runner 过多访问 ControlManager 私有状态。

### 方向 C：统一 `run_command` 的只读判定

如果希望 Plan Guard 允许 `pwd`、`git status`、测试命令等低风险命令，需要让 `RunCommand.is_read_only(arguments)` 和权限 allowlist 使用同一套 resolver。

建议：

- `run_command` 覆写 `is_read_only(arguments)`。
- 内部复用 `is_low_risk_command()` 或未来的 `is_readonly_safe_command()`。
- 仍然保持写命令、网络命令、重定向、链式命令、敏感命令不可只读。

这不是主根因，但能修复“连 pwd 都被挡”的体验问题。

## 建议回归测试

### 1. executing plan 不再触发 PLAN_GUARD_REQUIRED

建议测试位置：

- `tests/unit/test_control.py`
- 或新增 `tests/unit/test_plan_guard_execution.py`

测试结构：

1. 创建 `ControlManager`。
2. 进入 Plan mode。
3. 用 `ProposePlanTool` 创建带 steps 的计划。
4. 调用 `approve()`。
5. 构造 provider 返回 `write_file` 或 `run_command`。
6. 用 approval resume message 作为用户 history。
7. 断言工具不返回 `PLAN_GUARD_REQUIRED`。

### 2. 新高影响需求仍触发 Plan Guard

在已有 executing plan 存在时，如果用户明确提出一个新的、与当前计划无关的高影响需求，应仍然能够触发 Plan Guard。

这个测试可以防止豁免条件过宽。

### 3. run_command 只读判定一致性

如果实施方向 C，建议覆盖：

- `pwd` 只读。
- `git status` 只读。
- `pytest tests/unit -q` 是否允许按产品策略决定。
- `mkdir -p x` 非只读。
- `curl`、`python -c`、重定向、链式命令非只读。

## 临时规避方式

在修复前，用户侧手动切换权限模式不稳定，因为 Plan Guard 早于普通权限判断。

比较可靠的规避方式是：

- 不通过 Plan approval resume message 继续执行，而是发送一个小型直接指令，并避免包含“架构/权限/安全/部署/迁移/多步骤”等关键词。
- 但这只是绕过触发词，不是工程修复。

实际修复仍应在后端状态机完成。

## 建议优先级

优先级：高

原因：

- 该问题直接阻断“批准计划后长期编码大型项目”的核心路径。
- 它破坏了 Plan 模式最关键的闭环：探索、计划、批准、执行。
- 错误信息会误导用户，以为还没有批准计划，实际是执行态没有被 Plan Guard 识别。

建议先落地方向 A 或方向 B，并补齐回归测试；方向 C 作为同轮体验修复或下一轮权限一致性修复。
