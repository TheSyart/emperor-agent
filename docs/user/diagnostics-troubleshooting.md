# 诊断与排障

> 文档状态：Active<br>
> 面向读者：遇到启动、模型、会话、工具或打包问题的用户和开发者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/api/services/diagnostics-service.ts`、`packages/core/src/session-log/`、`desktop/src/renderer/src/components/settings/DiagnosticsSection.vue` 与 `diagnostics/`、当前构建与运行脚本

先进入“设置 → 诊断”。诊断页按分组显示，每行右侧用状态标记表示是否正常，右上角的刷新会重新读取诊断并重新探测环境：

- **服务**：Scheduler、沙箱、受管进程、子代理、活动任务等运行状态，以及桌宠和依赖；
- **路径**：Runtime 资源根、Emperor Home、当前项目、会话、附件、模型配置和 MCP 配置的位置（Emperor Home 与当前项目可以直接在文件管理器中打开），以及旧数据提示；
- **环境工具**：基础工具、当前项目、Skill 依赖和大型依赖的探测结果；
- **配置**：模型配置与本地配置的状态、有效配置来源和 Slash command 目录；
- **上下文**：当前会话的上下文解释。

不要先手工删除 `stateRoot`。

## 快速判断

| 现象                             | 首先检查                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 页面白屏或窗口打开后无内容       | `npm --prefix desktop run build`，再检查 `desktop/out/renderer/index.html`                           |
| 显示“必须在 Electron 中使用”     | 当前页面没有 preload Core bridge；完整产品不能在普通浏览器运行                                       |
| 模型未配置或认证失败             | 设置 → 模型中的协议、API Base、模型 ID 和 API Key；输入框中的当前模型                                |
| 模型偶发重试或长时间无响应       | 时间线中的重试提示；可重试错误最多重试 5 次，不会切换到其他模型                                      |
| 升级后看不到以前的会话           | Diagnostics 的 `kernel.archivedLegacySessions`；旧会话被移到 `sessions.legacy-<时间戳>/`             |
| 模型能回复但文件写入或命令被拒绝 | 当前权限预设、是否拒绝了提权请求、写入路径是否在 workspace 内                                        |
| Windows 等平台上 `bash` 全部失败 | 该平台没有沙箱后端，需要切换到 `danger-full-access`                                                  |
| 子代理请求提权总被拒绝           | 预期行为：子代理的审批策略固定为 `never`                                                             |
| Build 读到错误项目               | 当前 session 的项目路径、是否切错会话                                                                |
| 工具结果被截断                   | 完整文本在 `stateRoot/spill/` 下，工具结果里给出了路径                                               |
| Goal 不再自动续跑                | 应用重启后 Goal 处于 disarmed，使用 `/goal resume`；或 Goal 已 `blocked` / `complete`                |
| MCP 没有工具                     | 设置 → MCP 中该 server 卡片的状态和最近错误（含错误码），再查 `mcp_config.json`、命令/URL 和环境变量 |
| Scheduler 没执行                 | 设置 → Scheduler 中任务是否启用、下次运行时间、运行历史，目标会话是否有待回答的交互                  |
| Hooks 不生效                     | 设置 → Hooks 的“配置”校验结果、“测试”标签的 matcher 匹配与运行结果、handler 是否为 `command` 类型    |

## 常用状态入口

Composer 中与当前任务相关的命令：

```text
/model
/reasoning
/permissions status
/goal
```

Token 用量、工具、Skills、记忆、MCP 和 Hooks 在设置的对应分区中查看。“设置 → 用量”按全部、30 天或 7 天统计总 Token、输入、输出和缓存命中率，并提供“活跃度”（近一年热力图）、“趋势”（按模型或按类型）、“模型”（可排序的排名）和“缓存”四个视图。

Diagnostics payload 中与内核相关的字段：

- `kernel`：活动会话、正在运行的会话、当前模型 route、已注册工具名单，以及 `archivedLegacySessions`。
- `workspacePolicy`：当前 workspace 根和沙箱模式。
- `subagents`：子代理记录。
- `mcp`：每个 server 的连接状态、generation 与工具数。
- `optionalCapabilities`：可选能力登记（当前为 `watchlist`）。

## 有效配置与来源

“设置 → 诊断”的“配置”分组列出从现有事实源即时计算的配置项，包括模型执行策略、MCP 配置和当前可见的 `skills.<name>`，每行显示最终来源、覆盖轨迹和生效值摘要。Build 会话的项目 Skill 应显示为 project 来源；切回 Chat 后回到 user 或 builtin。

MCP 的 args、env、headers 和 URL 在有效配置里统一显示为 `[REDACTED]`。有效配置是只读解释面，不是新配置文件；修改仍回到原入口（`settings.json`、设置里的 MCP 分区、Skill 目录）。

## 会话与恢复

会话的全部事实在 `stateRoot/sessions/<id>/log.jsonl`，这份 log 是 append-only 的：

- 应用在 turn 进行中退出或崩溃后，下次打开会话时会自动修复：未完成的工具调用被标记为未开始或结果未知，turn 以中断结束，待回答的审批与问题关闭为不可用。修复不会重新执行任何工具。
- 如果 log 末尾有一行被截断，加载时会容忍并忽略它。
- 刷新或重启后，界面时间线从 log 重新投影，与实时显示一致。

出现恢复问题时，先完整备份该 session 目录，再提交问题；不要手工编辑 `log.jsonl`。

`/new` 会创建一个新会话并切换过去，旧会话保留；若只想减少上下文占用，使用 `/compact`。转换中断时检查 `stateRoot/control/session-transitions.json`，不要手工伪造 `applied` 状态。

## Task 与子代理

Task 面板列出后台 job（`bash` 的后台命令）、子代理会话和工作流运行（`workflow` / `ralph`）。工作流运行可以查看记录和停止；应用在运行中退出后，该运行显示为已中断。可以查看输出、等待和取消；子代理不能从面板恢复，需要在对话中让主 Agent 用 `send_message` 继续。后台 job 只存在于当前进程，应用退出时会被终止。

## 受管进程

进程最小账本位于 `stateRoot/processes/receipts.v1.json`，只保存 owner、lease、脱敏摘要、PID 与启动身份和终态，不保存命令、环境变量或输出。应用重启后，Core 只在启动身份精确匹配时回收遗留进程，无法证明时标记为 `orphan_unverified` 且不盲杀。不要根据账本中的 PID 自行批量 kill。

## 配置损坏

Model、MCP、settings 和 Hooks 配置使用原子写或损坏保留策略。无法解析时，Core 会尽量保留带后缀的 corrupt backup，并使用安全默认值启动。

处理顺序：

1. 在诊断页确认文件路径和状态；
2. 退出应用；
3. 备份整个 `stateRoot`；
4. 对照 example 修复配置，或通过设置页重新保存；
5. 重启并确认 diagnostics 不再报告 corrupt。

不要把包含 API Key 的原文件贴到公开 issue。

## 开发模式检查

```bash
npm run format:check
git diff --check
make check
```

UI 改动额外运行：

```bash
npm --prefix desktop run screenshots
```

打包链路：

```bash
npm --prefix desktop run package:verify
```

`make check` 失败时从第一条失败开始处理，不要只重跑最后一步。

## 提交问题

普通问题应包含：应用来源、平台与架构、复现步骤、期望结果、实际结果和脱敏日志。不要上传 API Key、环境变量、用户文档或完整 `stateRoot`。

安全漏洞不要公开披露复现细节，按 [Security Policy](../../.github/SECURITY.md) 使用私密报告入口。
