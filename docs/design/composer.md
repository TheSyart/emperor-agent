# 输入框

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-22（对照 `1a5cef69`）<br>
> 事实源：`desktop/src/renderer/src/components/composer/`（`ComposerCard.vue`、`PermissionChip.vue`、`PlanChip.vue`、`ModelPicker.vue`、`ContextMeter.vue`、`ChangesPill.vue`、`TodoDock.vue`、`SubagentDock.vue`、`GoalBar.vue`、`QueueDock.vue`）、`components/chat/composerController.ts`、`composerPalette.ts`、`composerModelControl.ts`、`components/conversation/HeroProfilePrompt.vue`、`theme/components.css`（`--composer-*`）、`desktop/src/main/screenshot-ipc.ts`；测试 `ComposerBottomBar.test.ts`、`QueueDock.test.ts`、`composerArchitecture.test.ts`、`desktop/tests/visual/composer.spec.ts`

输入框在对话面板底部：上面是按需出现的几条 dock，下面一张卡片，卡片里是富文本编辑器和一排控件。布局沿用 Emperor 自己的结构；0.2 只提升卡片的质感（参考 Codex 的视觉品质，不照搬它的布局）。

## 卡片

- 底色 `--composer-fill`（两套主题都是 `--surface-raised`），圆角 `--r-xl` 24，没有边框。边缘 `--composer-edge`：深色只靠 `--elev-1` 的阴影，浅色是 0.5px `--hairline` 描边加 `--elev-1`。
- 宽度跟对话内容列一致（`--composer-card-max`）；空会话的 Hero 居中显示同一张卡片。
- 编辑器在上，控件行在下。一行草稿时，从卡片上沿到控件行上沿的输入区至少 56px（上内边距 16 + 一行 28 + 与控件行的间距 12）；草稿变长时编辑器长高，最多 336px 后滚动。
- 编辑器上方按需出现一行说明：附件托盘、留到别的对话的听写结果、像密钥的内容的提示、未知 `/词` 的提示。
- 拖入文件时卡片外圈加 2px 焦点色描边。

## 控件行

| 位置 | 控件                | 内容                                                                                                   |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| 左   | `+`（28px 圆形）    | 菜单：上传图片或文件、插入 Skill 或插件、截图（只在 macOS 桌面应用里出现）、分隔线、计划模式、目标模式 |
| 左   | 权限芯片            | 盾牌图标 + 预设简称；菜单只有三个预设                                                                  |
| 左   | 计划 / 目标胶囊     | 计划或目标开着时出现，「计划 ×」「目标 ×」，点击退出                                                   |
| 右   | 模型芯片            | 供应商 logo + 模型名 + 思考强度；两层菜单，模型列表底部是「添加模型…」                                 |
| 右   | 上下文环            | 已知上下文窗口时出现，点开是上下文用量面板                                                             |
| 右   | 发送位（32px 圆形） | 空草稿：麦克风（有听写时）；有草稿：金色发送键；运行中：停止键，有草稿时旁边多一个「加入队列」         |

- 发送位是唯一的金色主操作；其他控件都是中性色。
- 截图由 main 运行系统的交互式截图（`screencapture -i`），窗口暂时隐藏，截下的 PNG 作为附件放进托盘；Esc 什么都不放。屏幕录制权限被拒绝时轻提示写明去哪里允许。
- 听写时整行换成录音条（取消、波形、停止）和发送键，行为见用户手册的[语音听写](../user/chat-build.md#语音听写)。

## 卡片上方的 dock

从上到下：变更汇总（Build 会话的工作区 Git 改动总计，点击打开「审查」）、子智能体状态条（有子智能体在运行而对话里它们那一组不在屏幕上时，见[会话流 › 子智能体](conversation.md#输入框上方的状态条)）、待办、Goal 条（暂停 / 恢复、编辑、清除；编辑把 `/goal edit <目标>` 放进输入框）、排队消息（插入当前执行 / 编辑 / 删除；前一轮失败或被停止后未运行的消息写「待发送 · 上一轮失败」等，操作是发送 / 编辑 / 丢弃）。每条只在有内容时出现；审批等卡片接管输入框时只保留 Goal 条。

## 个人档案访谈提示

个人档案访谈待开始时，第一个空会话的 Hero 在卡片下方显示一行「补充个人偏好 · 用一个简短访谈设置称呼、沟通方式和工作偏好」和「开始访谈」「不再提醒」。只出现一次：这个对话在本次运行中一直显示到你作答，别的对话和以后的启动都不再显示（`localStorage` 的 `emperor.profilePrompt.v1`）。访谈始终在「设置 › 记忆 › 用户档案」里；输入框上方不再放提示条。
