# 浮层规范

> 文档状态：Active<br>
> 面向读者：前端开发者、设计者<br>
> 最后核验：2026-10-19<br>
> 事实源：`desktop/src/renderer/src/components/ui/`（`useFocusTrap.ts`、`modalStack.ts`、`Modal.vue`、`confirm.ts`、`ConfirmHost.vue`、`toasts.ts`、`ToastStack.vue`、`Popover.vue`）、`components/ui/overlays.test.ts`

Emperor 的浮层分四类：模态弹窗、确认框、轻提示（toast）和锚定面板（popover）。每类只有一个实现，界面不再各写一套。

## 模态弹窗

`ui/Modal`、设置面板 `SettingsModal`、图片灯箱 `ImageLightbox` 和首启的「配置模型」弹窗都是模态层，遵守同一套规则：

- **Esc 只关最上层**：打开时加入 `modalStack`，Esc 交给最上面的一层；设置面板里再打开的弹窗先关，设置面板不动。不可关闭的弹窗吞掉 Esc。
- **焦点进入弹窗**：打开后焦点落在弹窗里第一个控件上。带 `data-autofocus` 的控件优先；关闭按钮（`data-dismiss`）只在没有其他控件时才拿到焦点；什么控件都没有时落在弹窗本身。设置面板落在面板本身，灯箱落在关闭按钮。
- **Tab 不离开弹窗**：Tab 和 Shift+Tab 在弹窗内循环；焦点跑到弹窗外时，下一次 Tab 把它拉回来。
- **背后不可操作**：弹窗所在浮层之外的内容加 `inert` 属性（点击、焦点、读屏都到不了）；嵌套弹窗打开时，下层弹窗也变为 `inert`，关闭后恢复。轻提示栈带 `data-overlay-keep`，弹窗开着时仍可点「复制详情」。
- **关闭后焦点回到入口**：焦点回到打开弹窗前的那个元素（仍在页面上且没被 `inert` 时）。灯箱由 `imageViewer` 把焦点还给缩略图。
- **关闭按钮只有一种**：`IconButton`，sm（28px）方形，标签「关闭」。

**未保存的编辑先确认（`ui/useDirtyGuard`）**：会丢掉内容的外壳提供守卫（`provideDirtyGuard()`：设置面板、能力页），编辑器登记自己的草稿（`useDirtyGuard('长期记忆', dirty)`）。外壳在丢掉内容之前（设置面板：关闭、Esc、点遮罩、换分区或二级页，统一由一个路由守卫检查；能力页：换页签）调用 `confirmDiscard()`：没有改动直接放行，有改动时用确认框问一次「放弃未保存的修改？」，正文点名所有改过的编辑器，按钮是「放弃」（危险色）和「继续编辑」（默认焦点）。草稿用 `useDraft(source)`：来源更新时，只有没改过的草稿跟着更新。同一外壳里切换页签而草稿仍保留时（记忆的两个编辑器）不问。

新写一个模态层时用 `Modal`；确实需要自己的外壳时，调用 `useModalLayer(open, onEscape)` 和 `useFocusTrap(panel, open, { layer })`，`layer` 传遮罩和面板共同的外层，否则遮罩也会被设为 `inert`、点遮罩关不掉。

## 确认框

不可逆或影响外部的操作（删除、清空、丢弃修改、推送、合并、断开连接、停止工作流等）一律先确认，用 `confirm()`，不用 `window.confirm`（Electron 里原生对话框外观不一致，`prompt()` 根本不支持）：

```ts
import { confirm } from '../ui/confirm'

if (
  !(await confirm({
    title: '删除这个凭据？',
    body: '删除后无法恢复。',
    confirmLabel: '删除',
    tone: 'danger',
  }))
)
  return
```

- 标题写成问句，说清楚对什么做什么；后果和补救写在 `body`。
- 确认按钮写动作本身（「删除」「推送」「断开」），不写「确定」；默认才是「确定」。
- `tone: 'danger'` 用于删除、清空、丢弃、关闭 PR、停止这类破坏性操作：确认按钮为红色，初始焦点在「取消」，回车不会误删。默认 tone 的确认按钮是金色主按钮，初始焦点在它上面。
- 取消、Esc、点遮罩都返回 `false`。同时发起的多个确认排队，一次只显示一个。
- `ConfirmHost` 在 `App.vue` 挂一次。测试里用 `answerConfirmsForTest(fn)` 直接作答，不渲染弹窗。
- 渲染层不能出现 `window.confirm`、`alert(`、`prompt(`；`overlays.test.ts` 扫描源码把关。

## 轻提示

组件通过应用上下文发提示：`ctx.showToast(message, { tone })` 发普通提示，`ctx.showError(error, context?)` 发错误。

- 最多同时显示 3 条，后来的排队；一条的计时从它出现在屏幕上开始。
- `info`、`ok`、`warn` 显示 4 秒后消失。同样内容的提示还在时，再发一次只重新计时，不叠出第二条。
- 错误提示不自动消失，带「复制详情」和关闭按钮，读屏立即播报（`role="alert"`）。详情包含消息、错误码、错误 ID、时间和调用栈。Core 返回的错误沿用主进程日志里的 `errorId`（`ipc_…`），能和日志对上；其他错误生成本地 ID（`ui_…`）。
- `context` 写「什么失败了」（「保存记忆失败」），显示为「保存记忆失败：原因」。
- 捕获到异常时用 `showError(error)`，不要把 `error.message` 拼进 `showToast`：后者 4 秒就消失，也拿不到错误 ID。

## 锚定面板

`ui/Popover` 用于点击后在触发按钮旁展开的非模态面板，现有使用者：侧栏通知、输入框的上下文用量。

- 菜单表面（`--menu-fill`，圆角 12，lv3 阴影），`role="dialog"` 并带 `label`。
- 默认在触发元素下方展开，`placement="top"` 在上方；空间不够时翻到另一侧，右边缘对齐。
- 在面板和触发元素之外按下或移动焦点即关闭；Esc 在任何焦点位置都能关闭（捕获阶段，弹窗里的面板先于弹窗关闭），并把焦点还给触发元素。
- 列表类内容自己留行距时传 `:padded="false"`。
- 菜单项列表用 `ui/Menu`，不用 Popover。
