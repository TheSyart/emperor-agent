# Emperor Agent {{tag}} · UNSIGNED-PREVIEW / 未签名预览版

> 文档状态：Active<br>
> 面向读者：安装 Preview 的用户<br>
> 最后核验：2026-09-29<br>
> 事实源：`.github/workflows/release-preview.yml`、Preview electron-builder 配置与发布 contract

> **Unsigned Preview / 未签名预览版**  
> `channel: preview` · `signingStatus: unsigned`

这是面向测试用户的公开预览版，不是 Stable。macOS 文件没有 Developer ID 签名且未经 Apple 公证；Windows 安装程序会显示 `Unknown publisher`，并可能触发 Microsoft Defender SmartScreen。只有在你确认下载来源并核对 SHA-256 后才应继续。

This public preview is for testing and is not a Stable release. The macOS files have no Developer ID signature and are not notarized by Apple. The Windows installer has no trusted publisher signature and may trigger Microsoft Defender SmartScreen. Continue only after confirming the download source and verifying its SHA-256 digest.

## 下载前验证 / Verify before running

1. 只从本仓库对应的 GitHub Pre-release 下载。
2. 使用 `SHA256SUMS.txt` 核对每个文件。
3. 可使用 `gh attestation verify <file> --repo TheSyart/emperor-agent` 验证 GitHub 构建来源。
4. Attestation 只证明构建来源和完整性，不代表 Apple/Microsoft 发布者签名，也不会把本版本变成 Stable。

## macOS 单应用确认 / Per-app confirmation

先把 Emperor Agent 拖到「应用程序」文件夹再打开：直接在下载位置运行时，macOS 会把它放到随机路径运行，电脑操作的授权每次启动都要重来。首次打开并看到系统拦截后，确认 SHA-256 无误，再进入 **System Settings → Privacy & Security → Open Anyway**，仅为 Emperor Agent 创建例外。Apple 的风险说明与官方步骤见 [Safely open apps on your Mac](https://support.apple.com/en-us/102445)。不要更改整机 Gatekeeper 安全策略。

Move Emperor Agent to the Applications folder before opening it: launched from the download location, macOS runs it from a random path and computer use permissions have to be granted again at every launch. After the first blocked launch, verify the SHA-256 digest, then use **System Settings → Privacy & Security → Open Anyway** to create an exception only for Emperor Agent. Keep system-wide Gatekeeper protections enabled.

## macOS 电脑操作 / Computer use on macOS

电脑操作使用独立的 Emperor Computer Helper。未签名版本没有固定的签名身份，所以每次安装新版本后，macOS 都会把 Helper 当作新应用：请在 **设置 › 电脑操作** 按提示重新授予 **辅助功能** 与 **屏幕录制**（系统开关仍显示开启时，以设置页读到的状态为准）。使用凭据库时，钥匙串可能再请求一次确认。

Computer use runs in the separate Emperor Computer Helper. An unsigned build has no stable signing identity, so after each update macOS treats the Helper as a new app: re-grant **Accessibility** and **Screen Recording** from **Settings › Computer Use** (trust the state shown there even if the system switches still look on). The credential vault may ask for Keychain access once more.

## Windows 单应用确认 / Per-app confirmation

确认 SHA-256 无误后，如果 SmartScreen 对话框和设备策略允许，可选择 **More info → Run anyway**。界面没有该选项时，不要绕过组织策略；请停止安装或联系管理员。Microsoft 对 unsigned app 警告的说明见 [Publish your first Windows app](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app)。不要更改整机 Defender 或 SmartScreen 安全策略。

After verifying the SHA-256 digest, use **More info → Run anyway** only when the SmartScreen dialog and device policy provide that option. If it is unavailable, stop and contact the device administrator. Keep system-wide Defender and SmartScreen protections enabled.

## 反馈 / Feedback

提交问题时请附上版本、平台、架构、对应文件的 SHA-256，以及脱敏后的诊断日志；不要上传 API key、环境变量或私人项目内容。
