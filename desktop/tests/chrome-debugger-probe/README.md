# E-X2 Chrome 调试提示条实验扩展

这是独立于 Emperor Browser Connector 的本机实验夹具，不参与应用打包或配对。生产扩展继续只使用内容脚本，不请求 `debugger` 权限。

实验前在 Chrome 打开 `http://127.0.0.1:8765/`，然后从 `chrome://extensions` 的开发者模式加载本目录。此扩展把 `debugger` 声明为**必需**权限，因为 Chrome 不允许将它列入 `optional_permissions`。加载和授予这一权限应在实际操作时确认。弹窗只允许附着到当前本机 fixture origin；它不读取页面内容、不调用 `sendCommand`、不连接 Emperor，也不上传数据。

点击“附着本机测试页”，观察 Chrome 的安装警告与调试提示条；关闭提示条后重新打开弹窗，记录 `onDetach` 原因。若仍附着，点击“结束调试连接”。验收后在 Chrome 中移除此实验扩展。记录 Chrome 版本、安装警告、提示条内容、关闭后状态和原始截图或会话证据到 `private-docs/progress/2026-09-23-computer-use/receipts/E-X2.md`。只在上述真实 GUI 证据取得后关闭 E-X2。

定向测试还覆盖提示条在扩展写入连接状态期间被关闭的竞态；此时弹窗必须显示已断开，并保留 Chrome 给出的断开原因。
