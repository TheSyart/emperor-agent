<!--
Stable GitHub Release 正文模板（REL-05）。
scripts/assemble-release-bundle.mjs 在聚合时删掉这段注释、替换 {{tag}} 与 {{version}}，写成 RELEASE-NOTES.md；
scripts/publish-release.sh 用它作 Release 正文（gh release create --notes-file）。
第一段必须写明安装包未签名并给出首次打开的步骤：scripts/release-contract.mjs 检查，缺一项发布就失败。
最后核验：2026-10-21 · 事实源：.github/workflows/release.yml、desktop/electron-builder.release.cjs、scripts/release-contract.mjs
-->

**Emperor Agent {{version}} 的安装包是未签名的**：没有 Apple Developer ID 签名，也没有经过 Apple 公证，第一次打开时 macOS 会拦下它。首次打开这样做：先用本页的 `SHA256SUMS.txt` 核对下载的文件；把 Emperor Agent 拖进「应用程序」文件夹，双击打开，系统提示无法打开时点「完成」；再到「系统设置 › 隐私与安全性」，在安全性一栏找到 Emperor Agent，点「仍要打开」并输入登录密码。之后就能像其他应用一样直接打开。

The Emperor Agent {{version}} packages are unsigned: they have no Apple Developer ID signature and are not notarized, so macOS blocks the first launch. Verify the download against `SHA256SUMS.txt`, move Emperor Agent to the Applications folder and open it; when macOS refuses, choose **Done**, then open **System Settings › Privacy & Security** and click **Open Anyway** for Emperor Agent. Keep Gatekeeper on for everything else.

## 下载

| 文件                                                  | 适用于                     |
| ----------------------------------------------------- | -------------------------- |
| `Emperor-Agent-{{version}}-macos-arm64.dmg` 或 `.zip` | Apple 芯片（M 系列）的 Mac |
| `Emperor-Agent-{{version}}-macos-x64.dmg` 或 `.zip`   | Intel 芯片的 Mac           |

只提供 macOS 安装包，Windows 与 Linux 不受支持。请从「应用程序」文件夹打开 Emperor：直接在下载位置运行时，macOS 会把它放到随机路径，电脑操作的授权每次启动都要重来。

## 未签名不等于未封签

应用和各个 Helper 都以 hardened runtime 做了 ad-hoc 封签，Electron 的 Node 运行与调试入口已经关闭，`app.asar` 改动一个字节就无法启动。其他程序不能借 Emperor 的身份和你已经授予它的权限运行自己的代码。不要为了打开 Emperor 而关闭整机的 Gatekeeper。

## 核验来源

- 每个文件的 SHA-256 都在 `SHA256SUMS.txt` 里：`shasum -a 256 -c SHA256SUMS.txt`。
- 构建来源由 GitHub 证明：`gh attestation verify <文件> --repo TheSyart/emperor-agent`。它证明文件出自本仓库的发布 workflow，不是代码签名。
- 依赖清单（CycloneDX SBOM）：`emperor-agent-{{tag}}.cdx.json`。

## 更新后重新授权

每个新版本的代码身份都会变。更新后，电脑操作要在「设置 › 电脑操作」重新允许「辅助功能」与「屏幕录制」，听写要在「设置 › 语音」重新允许「麦克风」与「语音识别」。系统设置里的开关看起来已经打开、Emperor 却说没有权限时，以 Emperor 设置页显示的状态为准，按提示重新授权。

## 这个版本的变化

见 [CHANGELOG](https://github.com/TheSyart/emperor-agent/blob/{{tag}}/docs/release/CHANGELOG.md)。
