# 诊断与排障

> 文档状态：Active<br>
> 面向读者：遇到启动、模型、会话、工具或打包问题的用户和开发者<br>
> 最后核验：2026-09-24<br>
> 事实源：`packages/core/src/api/services/diagnostics-service.ts`、`packages/core/src/session-log/`、`packages/core/src/environment/tool-catalog.json`、`packages/core/src/workspace/pull-request-browser.ts`、`desktop/src/main/browser-view-policy.ts`、`desktop/src/renderer/src/components/settings/DiagnosticsSection.vue` 与 `diagnostics/`、`desktop/src/renderer/src/components/pages/pulls/`、当前构建与运行脚本

先进入“设置 → 诊断”。页面顶部是概览：一句总体状态（「运行正常」或「有 n 项需要关注」）、运行时 / 环境工具 / 存储路径 / 配置四个小块的正常项计数，以及所有需要关注的项目（异常在前），点击某一项会展开它所在的分组。右上角「复制报告」把整页复制成纯文本，便于反馈问题；刷新会重新读取诊断并重新探测环境。

概览下方是默认折叠的分组，标题显示项数和状态：

- **运行时**：定时任务存储、运行事件、工作区范围、命令沙箱、进程托管、子代理、提示词缓存和运行中任务；Core 没有返回数据的项不显示，标题会注明“另有 n 项未返回数据”；
- **环境工具**：基础工具、当前项目（包括可选的 GitHub CLI `gh`）、Skill 依赖和大型依赖的探测结果，只读显示状态和版本，不在应用内安装；
- **桌面**：桌宠与 Node.js 运行时、桌面渲染层、桌宠模块等依赖；
- **存储路径**：内置资源目录、Emperor Home、当前项目、会话、附件、模型配置和 MCP 配置的位置（Emperor Home 与当前项目可以直接在文件管理器中打开），以及旧数据提示；用户主目录显示为 `~`；
- **配置**：模型配置与本地配置的状态、有效配置摘要和斜杠命令目录。

当前会话的上下文解释在“设置 → 记忆”顶部的“上下文概览”中查看。

不要先手工删除 `stateRoot`。

## 快速判断

| 现象                                              | 首先检查                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面白屏或窗口打开后无内容                        | `npm --prefix desktop run build`，再检查 `desktop/out/renderer/index.html`                                                                                                                                                                                                                                                                                |
| 显示“必须在 Electron 中使用”                      | 当前页面没有 preload Core bridge；完整产品不能在普通浏览器运行                                                                                                                                                                                                                                                                                            |
| 模型未配置或认证失败                              | 设置 → 模型中的协议、API Base、模型 ID 和 API Key；输入框中的当前模型                                                                                                                                                                                                                                                                                     |
| 模型偶发重试或长时间无响应                        | 时间线中的重试提示；可重试错误最多重试 5 次，不会切换到其他模型                                                                                                                                                                                                                                                                                           |
| 升级后看不到以前的会话                            | Diagnostics 的 `kernel.archivedLegacySessions`；旧会话被移到 `sessions.legacy-<时间戳>/`                                                                                                                                                                                                                                                                  |
| 启动报 `installation_lock_busy`                   | 另一个 Emperor 实例正在初始化；残留的锁会在持有进程退出或心跳过期后自动接管，稍后重开即可                                                                                                                                                                                                                                                                 |
| 模型能回复但文件写入或命令被拒绝                  | 当前权限预设、是否拒绝了提权请求、写入路径是否在 workspace 内                                                                                                                                                                                                                                                                                             |
| Windows 等平台上 `bash` 全部失败                  | 该平台没有沙箱后端，需要切换到 `danger-full-access`                                                                                                                                                                                                                                                                                                       |
| 子代理请求提权总被拒绝                            | 预期行为：子代理的审批策略固定为 `never`                                                                                                                                                                                                                                                                                                                  |
| Build 读到错误项目                                | 当前 session 的项目路径、是否切错会话                                                                                                                                                                                                                                                                                                                     |
| 工具结果被截断                                    | 完整文本在 `stateRoot/spill/` 下，工具结果里给出了路径                                                                                                                                                                                                                                                                                                    |
| `desktop_observe` 返回 `truncated`                | 桌面辅助功能树可能超过默认深度 8；对同一目标用 `maxDepth: 16` 再观察，或按控件角色、名称缩小范围。这与工具文本溢出到 `spill/` 不同；达到深度上限后，不应把未显示的控件当作不存在。                                                                                                                                                                        |
| Goal 不再自动续跑                                 | 应用重启后 Goal 处于 disarmed，使用 `/goal resume`；或 Goal 已 `blocked` / `complete`                                                                                                                                                                                                                                                                     |
| MCP 没有工具                                      | 能力页“MCP”标签中该 server 卡片的状态和最近错误（含错误码），再查 `mcp_config.json`、命令/URL 和环境变量                                                                                                                                                                                                                                                  |
| 定时任务没执行                                    | 定时任务页中任务是否已开启、下次运行时间，任务对话框中的运行历史和最近错误，目标会话是否有待回答的交互                                                                                                                                                                                                                                                    |
| Pull Request 页或「审查」的 PR 操作不可用         | 诊断 → 环境工具中 `gh` 的状态与版本，以及是否已 `gh auth login`，见下文 [GitHub CLI（gh）](#github-cligh)                                                                                                                                                                                                                                                 |
| 工作台的浏览器打不开网址                          | 只支持用户在地址栏输入的 `http(s)` 网址；带用户名密码或其他协议的地址会被拒绝，见 [浏览器的限制](chat-build.md#浏览器的限制)                                                                                                                                                                                                                              |
| Emperor Computer Helper 不在权限列表              | 设置 → 电脑操作中确认 Helper 已连接，点击对应“请求权限”；录屏列表仍没有时，用“＋ 添加”选择 `~/.emperor/native-helpers/` 中当前版本的 Helper，见[电脑操作](computer-use.md)                                                                                                                                                                                |
| Helper 开关已打开，但状态仍为拒绝或失效           | 确认授权的是当前安装版本；必要时在“设置 → 电脑操作”按对应“重置授权”，重新登记并开启。重置会撤销现有系统授权                                                                                                                                                                                                                                               |
| Chrome 扩展显示未连接                             | 确认 Emperor 正在运行，并在安装版“设置 → 电脑操作”点过“连接 Chrome/Edge”，然后在扩展中重新连接；配对码须由你对照两端确认，见[电脑操作](computer-use.md)                                                                                                                                                                                                   |
| Chrome/Edge 连接显示“另一个 Emperor 正在使用”     | 同一用户同时只能有一个 Emperor 占用浏览器连接；退出另一个 Emperor（包括残留的测试包）后，当前应用会每约 5 秒自动重试。设置页刷新后如显示待配对，请在扩展中重新连接                                                                                                                                                                                        |
| 电脑操作状态为“已暂停”（授权记录文件损坏）        | 授权文件读不出，Emperor 已隔离备份并挂起全部授权；在设置页点“恢复”后需重新授权网站与应用                                                                                                                                                                                                                                                                  |
| 应用窗口重载后 Agent 停住                         | 界面断开期间 Agent 的目标会自动暂停，避免在你看不到时操作；在浏览器或电脑面板中逐个恢复或结束                                                                                                                                                                                                                                                             |
| 截图或观察提示 `sensitive-app`                    | 该应用在“应用名单 → 敏感应用”中：只读界面结构，不读输入框内容，也不截图                                                                                                                                                                                                                                                                                   |
| 凭据代填提示 `credential-field-type`              | 目标输入框的类型与要填的字段不符（例如把密码填进普通文本框）；先观察，选对字段后再试                                                                                                                                                                                                                                                                      |
| 电脑操作提示 `STALE_TARGET` 或 `STALE_ELEMENT`    | 页面导航、窗口变化或扩展重载会使旧目标与元素引用失效；重新列出目标、观察后再操作                                                                                                                                                                                                                                                                          |
| Finder 完整观察反复提示 `STALE_TARGET`            | 当前版本已处理 Finder 图像加载引起的重复变更通知。若某个窗口仍持续报错，请重新列窗、绑定一次；仍报同一错误时停止该目标的自动操作，先手动完成并保留会话诊断，不要循环重试或改用坐标点击。                                                                                                                                                                  |
| 桌面 App 仍运行，但 `desktop_list_windows` 返回 0 | macOS 可能没有把其他桌面空间或已最小化的窗口列入当前可访问窗口；这不能证明 App 已退出。把目标窗口恢复到当前桌面后重新列窗；已绑定目标在其他空间截图可能返回 `TARGET_NOT_VISIBLE`                                                                                                                                                                          |
| 桌面输入提示 `TARGET_NOT_VISIBLE`                 | Helper 已尝试将目标窗口置前，但目标 App、焦点窗口或模态窗口仍不符合绑定目标。`reason=target-app-not-frontmost` 表示目标 App 未在最前；`target-window-not-focused` 表示绑定窗口没有焦点；`frontmost-app-unverified` 表示无法确认当前最前的 App（例如刚启动的应用），为安全起见未派发。检查当前桌面和模态窗口，恢复后重新观察；输入尚未派发，不应盲目重试。 |
| 桌面按键或鼠标动作返回 `observed`，但画面未达预期 | `observed` 只表示派发后检测到目标版本变化；其他界面变化也可能触发。重新观察并核对具体控件或文件结果；若预期效果未出现，停止该动作流程并报告，不能仅凭 `observed` 宣称成功。                                                                                                                                                                               |
| 动作提示 `OUTCOME_UNKNOWN`                        | 操作可能已经发生；先直接检查目标页面或窗口，不要重放发送、删除、付款或凭据填写                                                                                                                                                                                                                                                                            |
| Hooks 不生效                                      | 设置 → Hooks 的“配置”校验结果、“测试”标签的 matcher 匹配与运行结果、handler 是否为 `command` 类型                                                                                                                                                                                                                                                         |

Finder 的内联重命名框有时不提供所属窗口。Helper 只有在辅助功能命中、前台焦点及当前可见的物理窗口都指向已绑定 Finder 窗口时才允许输入；任一条件不能确认，就会在派发前返回 `TARGET_NOT_VISIBLE`。本机曾出现 Finder 编辑框可见、但系统命中测试落在通知层的情况；把测试窗口移到无遮挡的桌面空间后，同一签名 Helper 完成了新建和命名。此时 `reason=target-input-point-unverified` 表示 Finder 编辑框虽已获焦点，但系统无法确认输入点仍属于该窗口。遇到这种拒绝时，先移开目标窗口或等待遮挡消失，再重新观察，不要放宽身份检查或反复点同一位置。每步动作后仍须重新观察：按下新建快捷键或输入名称的 `observed` 不等于文件名已经提交。若提交键收到 `STALE_TARGET`，先确认没有派发，再重新观察并核对当前编辑状态；无法确认时停止，不要盲目重复按键或改用坐标点击。

`desktop_type` 现在只向焦点明确落在可编辑文本控件的窗口派发文字。`reason=focused-text-editor-unavailable` 表示焦点仍在图标视图、只读字段或其他非编辑控件；先让目标文本框取得焦点，再重新观察。Finder 图标视图可能把误投的字符用于按名称选中，因此不能把选中项变化当作名称输入成功。

## 常用状态入口

Composer 中与当前任务相关的命令：

```text
/model
/reasoning
/permissions status
/goal
```

Token 用量、记忆和 Hooks 在设置的对应分区中查看；插件、Skills、MCP 和工具在侧栏「能力」页查看。“设置 → 用量”按全部、30 天或 7 天统计总 Token、输入、输出和缓存命中率，并提供“活跃度”（近一年热力图）、“趋势”（按模型或按类型）、“模型”（可排序的排名）和“缓存”四个视图。

Diagnostics payload 中与内核相关的字段：

- `kernel`：活动会话、正在运行的会话、当前模型 route、已注册工具名单，以及 `archivedLegacySessions`。
- `workspacePolicy`：当前 workspace 根和沙箱模式。
- `subagents`：子代理记录。
- `mcp`：每个 server 的连接状态、generation 与工具数。
- `optionalCapabilities`：可选能力登记（当前包括 `watchlist` 和 `computer_use`）。

## 有效配置与来源

“设置 → 诊断”的“配置”分组列出从现有事实源即时计算的配置项：模型执行策略、沙箱策略和 MCP 配置各一行，显示是否生效、最终来源和覆盖层数；当前可见的 `skills.<name>` 合并为一行「Skills 配置」，有来源不受信任或被拒绝的 Skill 时列出名称。Build 会话的项目 Skill 来源为 project；切回 Chat 后回到 user 或 builtin。「复制报告」中包含这些行。

MCP 的 args、env、headers 和 URL 在有效配置里统一显示为 `[REDACTED]`。有效配置是只读解释面，不是新配置文件；修改仍回到原入口（`settings.json`、能力页的 MCP 标签、Skill 目录）。

## 会话与恢复

会话的全部事实在 `stateRoot/sessions/<id>/log.jsonl`，这份 log 是 append-only 的：

- 应用在 turn 进行中退出或崩溃后，下次打开会话时会自动修复：未完成的工具调用被标记为未开始或结果未知，turn 以中断结束，待回答的审批与问题关闭为不可用。修复不会重新执行任何工具。
- 如果 log 末尾有一行被截断，加载时会容忍并忽略它。
- 刷新或重启后，界面时间线从 log 重新投影，与实时显示一致。

出现恢复问题时，先完整备份该 session 目录，再提交问题；不要手工编辑 `log.jsonl`。

`/new` 会创建一个新会话并切换过去，旧会话保留；若只想减少上下文占用，使用 `/compact`。转换中断时检查 `stateRoot/control/session-transitions.json`，不要手工伪造 `applied` 状态。

## 后台任务与子代理

CoreApi 的 `tasks.*` 把后台 job（`bash` 的后台命令）、子代理会话和工作流运行（`workflow` / `ralph`）汇总在一起。界面中：

- 环境信息卡的「子智能体」列出本会话委派的子代理，点击打开子会话；子代理仍在运行时，可以在子会话里点「停止」。
- 「后台任务」行显示后台命令和工作流运行的数量；点击展开后，每个任务有「输出」（只读查看命令输出或工作流记录）和运行中才有的「停止」。停止工作流前会先确认，它正在运行的子代理会一起停止。
- 工作流在前台运行，停止当前 turn 会同时取消它；应用在运行中退出后，该运行记为已中断。
- 后台命令由 Agent 通过 `job_output`、`job_list`、`job_kill` 读取和停止，你也可以在「后台任务」中查看输出或停止它；后台命令只存在于当前进程，应用退出时会被终止。
- 子代理结束后不能从界面恢复，需要在对话中让主 Agent 用 `send_message` 继续。

## GitHub CLI（gh）

「Pull Request」页和「审查」中的 PR 操作都依赖本机的 GitHub CLI。`gh` 是签名工具目录中的可选工具，要求 2.40.0 或更高版本；Emperor 只探测它，不会替你安装或登录。

1. 在“设置 → 诊断 → 环境工具”的“当前项目”分组中查看 `gh` 的状态和版本。
2. 未安装时按平台安装：macOS 用 Homebrew（`brew install gh`），Windows 用 winget（`winget install GitHub.cli`），Linux 按 [GitHub CLI 官方安装说明](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) 安装。
3. 在终端运行 `gh auth login` 完成登录。Build 会话可以直接使用右侧工作台的「终端」。
4. 回到 Pull Request 页点「重新检测」，或刷新诊断页。

Pull Request 页的三种不可用状态：

| 页面标题              | 含义                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| 需要 GitHub CLI（gh） | 没有探测到可用的 `gh`，或版本低于要求；页面给出安装命令和「前往诊断」 |
| GitHub CLI 尚未登录   | `gh` 可用但没有登录，运行 `gh auth login` 后重新检测                  |
| 无法连接 GitHub CLI   | `gh` 调用失败，页面显示脱敏后的错误信息，可以「重试」                 |

Emperor 运行 `gh` 时不传递 `GH_TOKEN`、`GITHUB_TOKEN` 等 token 类环境变量，只使用 `gh` 自己保存的登录状态（会保留 `GH_CONFIG_DIR`、`XDG_CONFIG_HOME` 等定位 `gh` 配置目录的变量）。只在 shell 里设置了 token 环境变量、没有执行 `gh auth login` 时，页面会显示未登录。

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
