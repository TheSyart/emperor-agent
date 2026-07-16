# 诊断与排障

> 文档状态：Active<br>
> 面向读者：遇到启动、模型、会话、工具或打包问题的用户和开发者<br>
> 最后核验：2026-07-16<br>
> 事实源：DiagnosticsService、桌面诊断面板、当前构建与运行脚本

先进入“设置 → 诊断”。诊断页会集中显示生效路径、配置文件状态、workspace fence、迁移结果、环境能力、Scheduler、External 和桌宠信息。不要先手工删除 `stateRoot`。

## 快速判断

| 现象                         | 首先检查                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| 页面白屏或窗口打开后无内容   | `npm --prefix desktop run build`，再检查 `desktop/out/renderer/index.html`    |
| 显示“必须在 Electron 中使用” | 当前页面没有 preload Core bridge；完整产品不能在普通浏览器独立运行            |
| 模型未配置或认证失败         | 设置 → 模型中的激活项、协议、API Base、模型 ID 和 API Key                     |
| 模型能回复但工具失败         | 当前权限模式、Ask/Plan 卡片、workspace 和工具输入                             |
| Build 读到错误项目           | 当前 session 的 project path、诊断页 workspace fence、是否切错会话            |
| 会话刷新后卡片缺失           | session runtime event 日志、bootstrap replay 和 reducer 投影                  |
| Goal 无法 Resume             | owner session、workspace fingerprint、Goal diagnostics 和 pending interaction |
| MCP 没有工具                 | `mcp_config.json`、server enabled、命令/URL、环境变量和连接错误               |
| Scheduler 没执行             | job 是否启用、next run、run history、pending Ask/Plan 和全局运行锁            |
| Hooks 不生效                 | hooks enabled、matcher、项目 trust/digest、测试结果和 audit                   |

## 本地命令

查看基础状态：

```text
/status
/model
/tokens
/tools
/skills
/memory
/mode status
/plan status
/goal status
```

刷新 bootstrap、模型、Skills、Tools 和记忆：

```text
/reload
```

`/clear` 只清空当前屏幕，不删除会话、记忆或 runtime 文件。

## 配置损坏

Model、MCP、local config 和 Hooks 使用原子写或损坏保留策略。无法解析时，Core 会尽量保留带时间或随机后缀的 corrupt backup，并使用安全默认值启动。

处理顺序：

1. 在诊断页确认文件路径和状态；
2. 退出应用；
3. 备份整个 `stateRoot`；
4. 对照 example/schema 修复配置，或通过设置页重新保存；
5. 重启并确认 diagnostics 不再报告 corrupt。

不要把包含 API Key 的原文件贴到公开 issue。

## 会话、记忆和 Goal

会话事实位于 `stateRoot/sessions/<id>/`。Goal 的 `events.jsonl` 是权威账本，snapshot 和 index 可以重建。

出现恢复问题时：

- 先保留相关 session 和 Goal 整个目录；
- 查看 `goals/diagnostics.json`、post-commit diagnostics 和 session runtime events；
- 修复 workspace/session 绑定后显式 Resume；
- 不要手工编辑 Goal JSONL、hash、Gate fact 或删除 diagnostics 强制继续。

任何无法证明安全的状态都会 fail closed，这不是普通 Chat fallback。

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
