# 安全政策 / Security Policy

> 文档状态：Active<br>
> 面向读者：安全研究者、用户、维护者<br>
> 最后核验：2026-07-16<br>
> 事实源：Electron IPC、Core 权限与 workspace policy、Release workflows、GitHub Private Vulnerability Reporting

## 支持范围

Emperor Agent 是本地单用户 Electron 应用。当前接受以下主线代码与公开 Preview 安装包的安全报告：

- Electron renderer、preload 与 main-process IPC 的信任边界；
- 模型或工具对本地文件、进程和 workspace 的越权访问；
- Ask / Plan、权限模式、Goal、Scheduler、Team 或 Hook 绕过 Core guard；
- `stateRoot` 私有数据、附件、凭证、日志或 runtime event 泄露；
- MCP、Web 与 External Bridge 输入导致的注入或不安全执行；
- 官方 GitHub Actions、安装包、checksum、SBOM、attestation 和更新说明的供应链问题。

退役的 Python runtime、Python CLI、HTTP / WebSocket backend，以及第三方修改版或用户自行改变安全策略后的环境，不属于当前支持产品线。仓库中的 Historical / Frozen 文档也不构成受支持行为。

## 私密报告

请使用 GitHub 仓库的 **Report a vulnerability** 私密入口提交，不要先创建公开 Issue，也不要在修复可用前公开利用细节：

[向 TheSyart/emperor-agent 私密报告漏洞](https://github.com/TheSyart/emperor-agent/security/advisories/new)

报告尽量包含：

- 影响与攻击前提的简要说明；
- 可重复的最小步骤或 proof of concept；
- 受影响的 commit、tag、平台和架构；
- 预期行为与实际行为；
- 已删除密钥、用户名和私人路径的日志或截图；
- 如已知，可能的缓解方式和公开时间约束。

如果 GitHub 私密入口暂时不可用，请只提交不含利用细节的公开 Issue，请求维护者提供私密沟通方式。

## 数据处理

报告中不要上传：

- API key、token、cookie、MCP 凭证或环境变量；
- 完整 `~/.emperor-agent`、`model_config.json`、`mcp_config.json` 或 `.env`；
- 私人对话、附件、项目源码或未经授权的第三方数据；
- 未脱敏的 HOME、用户名、绝对路径和组织内部地址。

提供复现数据时使用新建测试账号、临时 `stateRoot` 和最小示例 workspace。

## 维护者处理原则

- 先确认收件与复现状态，再评估影响、支持范围和修复渠道。
- 在修复前限制漏洞细节和受影响资产的访问。
- 修复必须保留 CoreApi validation、permission / mutation guard、workspace policy 和回归测试。
- 已公开错误二进制不原地替换；撤下后发布新的 tag 和 checksum。
- 安全修复进入 [`docs/release/CHANGELOG.md`](../docs/release/CHANGELOG.md) 的 `Security`，具体细节按风险在用户可更新后披露。

## 用户安全边界

- “本地运行”不等于完全离线；模型 Provider、MCP、Web 和外部工具可能收到任务内容。
- MCP、网页和 External Bridge 消息按不可信输入处理。
- `auto` 不关闭路径安全、schema、Core deny 或高风险命令确认。
- 未签名 Preview 的安装说明见 [`docs/release/unsigned-preview-notice.md`](../docs/release/unsigned-preview-notice.md)；不要关闭整机 Gatekeeper、Defender 或 SmartScreen。
