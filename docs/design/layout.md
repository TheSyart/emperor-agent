# 外壳布局

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-19<br>
> 事实源：`desktop/src/renderer/src/components/shell/`（`AppFrame.vue`、`columns.ts`、`frameState.ts`）、`desktop/src/renderer/src/components/sidebar/SidebarRail.vue`、`desktop/src/renderer/src/theme/components.css`、`desktop/src/renderer/src/theme/base.css`、`desktop/src/main/window-chrome.ts`、`desktop/src/renderer/src/components/settings/`（`SettingsModal.vue`、`SettingsNav.vue`、`settingsSections.ts`、`ui/`）；测试 `AppFrame.test.ts`、`SidebarRail.test.ts`、`window-chrome.test.ts`、`desktop/tests/visual/shell.spec.ts`、`desktop/tests/electron/shell/run.ts`、`desktop/tests/visual/settings-groups.spec.ts`

主窗口是「画布 + 面板」：窗口底色是 `--surface-canvas`，图标栏和侧栏直接画在画布上；中间的对话（或整页）和右侧工作台各是一块面板。层级靠明度区分，画布上不画任何列边框。

## 结构

从左到右：

| 区域   | 宽度                             | 底色                  | 说明                                                            |
| ------ | -------------------------------- | --------------------- | --------------------------------------------------------------- |
| 图标栏 | 固定 56（`--rail-w`）            | 画布                  | 常驻，不随侧栏收起；顶部是红绿灯区域                            |
| 侧栏   | 默认 236，可拖 200–360；收起为 0 | 画布                  | 只放项目与对话：顶栏（Emperor 标 + 收起按钮）、置顶、项目、对话 |
| 中栏   | 余下宽度；下限对话 480、轨迹 640 | 面板 `--surface-base` | 对话、轨迹或整页                                                |
| 工作台 | 默认 560，可拖 360–960；关闭为 0 | 面板 `--surface-base` | 审查 / 终端 / 文件 / 浏览器                                     |

- 面板：圆角 12（`--panel-radius`），四周留 8px 画布槽（`--shell-gutter`）；两块面板之间也是 8px。深色主题面板边缘是 0.5px 的最弱描边，浅色主题用 `--elev-1`（`--panel-edge`）。
- 面板里的内容以 `--surface-base` 为背景；卡片、代码块等在面板上再抬一级。
- 宽度都是列宽：中栏与工作台列包含它们的槽（中栏列四周各 8，工作台列上、右、下各 8），面板等于列宽减去槽。

## 窗口标题栏

macOS 上主窗口隐藏系统标题栏（`titleBarStyle: 'hiddenInset'`），内容铺满窗口：

- 红绿灯位置 `{ x: 16, y: 24 }`（`window-chrome.ts`）。macOS 26 的三个按钮各 14×14、间距 23，整组宽 60，竖直中心 y = 31，正好是顶栏的中线（8 + 46 / 2）。
- 红绿灯从图标栏伸进侧栏顶部约 20px。旁边的内容从 x = 84 开始（`--shell-lights-clear` = 16 + 60 + 8）：侧栏顶栏的左内边距是 84 − 56 = 28；侧栏收起时，中栏面板从 x = 84 开始，而不是图标栏右侧 8px，避免红绿灯压在面板角上。
- `window-chrome.test.ts` 保证这些数值与 `components.css` 的令牌一致。

## 顶栏对齐

各列顶栏高 46（`--shell-bar-h`），从画布槽下沿（y = 8）开始，底边都在 y = 54：

| 列     | 顶栏                                                | 高度                                                      |
| ------ | --------------------------------------------------- | --------------------------------------------------------- |
| 图标栏 | `.rail-top`：空白，放红绿灯                         | 54（槽 + 顶栏）                                           |
| 侧栏   | `SidebarBrandRow`（`.sidebar-bar`）                 | 46                                                        |
| 中栏   | 会话头第一行（`.conversation-header > .title-row`） | 46；空白新对话的浮动头同样 46                             |
| 工作台 | `PaneHeader`                                        | 48，上移 2px（`margin-top: 46 − 48`），底边与其他顶栏对齐 |

整页（定时任务、能力、GitHub）没有顶栏，标题在页面内容里（PageShell）：内容宽 880、居中，标题 20/600，页签在标题下。Pull Request 是唯一占满宽度的页面，但它的标题行和页签仍在同一个 880 列、同一高度，所以 GitHub 的 PR / Issue / CI 三个标签切换时标题不动。

## 拖拽区

窗口没有系统标题栏，拖动下面这些空白处移动窗口：

- 图标栏顶部（红绿灯区域）、侧栏顶栏、会话头第一行、工作台 PaneHeader。它们带 `data-app-drag` 属性，`theme/base.css` 把它变成 `-webkit-app-region: drag`。
- 拖拽区里的控件（`button`、`a`、输入框、`role="button"` / `role="tab"`、带 `tabindex` 的元素）一律 `no-drag`，照常点击。
- 移出 `#app` 的浮层（菜单、弹窗、提示、灯箱）一律 `no-drag`：即使盖在顶栏上也能点。列宽拖动条也是 `no-drag`。
- 新加顶栏时加 `data-app-drag`；不要把拖拽区放在没有 `no-drag` 的可点元素上（Electron 的拖拽区会吞掉点击，CDP 合成的点击测不出来，只能用真实指针验证：`node scripts/e2e-cu.mjs --mode=shell`）。

## 图标栏

- 从上到下：新对话（⌘N）、搜索（⌘K）、会话、定时任务、能力（原「探索」是能力页的「推荐」）、Pull Request（只在 GitHub 插件启用时出现）；底部是通知铃铛和设置。
- 按钮是 IconButton `size="lg"`（36，`--icon-button-lg`），图标 20，提示在右侧。当前路由的入口画 `--surface-selected`（IconButton `selected`），并带 `aria-current="page"`。
- 「会话」在对话路由上一直是选中状态：点击收起或展开侧栏（⌘B）；在整页上点击回到当前会话。
- 后退 / 前进不再有按钮，用 ⌘[ / ⌘]。

## 收起与断点

- 视口宽度小于 1024px 时侧栏自动收起，图标栏仍在；收起的侧栏保持挂载（宽度 0、`inert`），展开时保留搜索与分组的折叠状态。
- 空间不够时，工作台先缩到 360，再自动关闭；只改渲染宽度，不改用户保存的宽度（`columns.ts` 的让位链）。
- 列宽变化不做过渡动画：拖动时宽度逐帧跟随，收起和展开立即生效。
- 0.2 之前保存的默认侧栏宽度 280 读取时换成新的默认 236；其他宽度夹到 200–360。

## 设置面板

- 尺寸 880 × min(720, 100vh − 80)，圆角 r-xl（24），lv3 阴影，遮罩模糊。左侧导航 200px，底色 `--surface-canvas`；右侧页面底色 `--surface-base`，页面标题 16/600，顶栏 54px。
- 导航四组九项：「常规」单独一组，然后「智能」（模型、子智能体、记忆）、「操控」（电脑操作、浏览器、语音）、「系统」（用量、高级），组标签 12/500 三级文字。导航项是 32px 的纯文字行，选中用 `--surface-selected`。面板窄于 640px 时导航折成顶部一行，组标签隐藏。
- 每页只有一种排法：分组标签 + 一张卡片 + 行（`SettingsGroup` + `SettingsRow`）。卡片里不再放卡片，列表自带外框时分组用 `plain`。打开二级页的行是 `SettingsLinkRow`（整行可点，末尾箭头）；列表行只留一个主操作按钮，其余（包括删除）放进行尾的「⋯」（`SettingsRowMenu`）。
- 不常用的内容放二级页（`?settings=<分区>&page=<页面>`，标题「分区 › 页面」）：常规 › 已归档对话、记忆 › 历史 / 情景记忆 / Watchlist、用量 › 详细、高级 › Hooks / 诊断。
- 会自己刷新的分区（记忆、电脑操作；能力 › 插件）不放刷新按钮。编辑类页面接入未保存守卫（[浮层规范](overlays.md#模态弹窗)）。
