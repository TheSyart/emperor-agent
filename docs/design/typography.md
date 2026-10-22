# 排版

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-22<br>
> 事实源：`desktop/src/renderer/src/theme/primitives.css`（字体、`--fs-*`/`--lh-*`、`--type-*`、`--md-h*`、`--weight-*`）、`theme/base.css`、`styles.css`、`desktop/src/renderer/index.html`、`components/pages/PageShell.vue`、`components/settings/SettingsModal.vue`、`components/settings/ui/`、`components/ui/`（`PaneHeader.vue`、`Button.vue`、`Tabs.vue`、`Badge.vue`、`ListRow.vue`、`ListSection.vue`、`Field.vue`、`TooltipBubble.vue`、`MenuItem.vue`、`CodeBlock.vue`）、`components/conversation/parts/ConversationMarkdown.vue`、`components/conversation/nodes/UserBubble.vue`、`components/sidebar/`；测试 `style-audit.test.ts`、`styleAuditRules.ts`、`theme/tokens.test.ts`、`desktop/tests/visual/process.spec.ts`、`pages.spec.ts`、`settings-groups.spec.ts`

界面是中文为主、夹杂英文与代码的桌面应用。排版的目标是：字号少而稳，层级主要靠颜色和字重而不是靠放大；中英混排自然；数字对齐。字号、行高和字重都来自[设计令牌](tokens.md)，颜色层级见[颜色使用规范](color.md)。

## 字体

| 令牌          | 字体栈（按顺序回退）                                                                                                                | 用在哪                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `--font-sans` | `-apple-system`、`BlinkMacSystemFont`、`Segoe UI`、`PingFang SC`、`Hiragino Sans GB`、`Microsoft YaHei`、`Helvetica Neue`、`Arial`… | 全部界面文字（`body`、表单控件继承）          |
| `--font-mono` | `SF Mono`、`JetBrains Mono`、`ui-monospace`、`Fira Code`、`Consolas`、`Menlo`，最后回退 `PingFang SC`、`Microsoft YaHei`            | 代码、路径、命令、ID、`code`/`kbd`/`pre` 元素 |

- 不加载网页字体。macOS 上英文是 SF，中文是苹方；等宽字体里的中文落到苹方，所以代码注释里的中文和正文字形一致。
- 页面声明 `<html lang="zh-CN">`（`index.html`），浏览器按简体中文选择字形和标点。
- `body` 统一设置 `-webkit-font-smoothing: antialiased` 与 `text-rendering: optimizeLegibility`（`base.css`），组件里不再单独设置。
- 根元素不设 `font-size`，所有字号都是令牌给出的像素值，不用 `rem`/`em` 推算层级（行内代码这类相对父级的缩放除外）。

## 字号与行高

字号永远和行高成对使用。两套写法并存：

| 写法                                        | 令牌                                                                                                                                                                                                                            | 现状                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--type-*`（字号 / 行高，只能放进 `font:`） | `--type-caption` 12/18、`--type-footnote` 13/20、`--type-body-sm` 14/22、`--type-body` 15/26、`--type-title-sm` 16/24、`--type-title` 20/28、`--type-display` 28/36；Markdown `--md-h1` 20/30、`--md-h2` 18/28、`--md-h3` 16/26 | 0.2 的目标刻度。`components/ui` 的大部分组件、会话流、工作台已经使用；新组件用它                                       |
| `--fs-*` + `--lh-*`（或 `--font-*` 简写）   | `--fs-xxxs` 11/14、`--fs-xxs` 12/18、`--fs-xs` 13/20、`--fs-s` 14/22、`--fs-base` 16/24、`--fs-md` 16/28、`--fs-hero` 20/28、`--fs-code` 13/22                                                                                  | 旧刻度，仍是 L1 令牌，侧栏、设置原语、页面外框、菜单、提示、徽章还在用。整体切换会改变全部文字排版，留给逐屏的界面任务 |

写法示例：

```css
.title {
  font: var(--weight-semibold) var(--type-body-sm) var(--font-sans);
}
.meta {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
```

两套刻度在 12、13、14 上的字号与行高一致（`--type-caption` = `--fs-xxs`，`--type-footnote` = `--fs-xs`，`--type-body-sm` = `--fs-s`），混用不会出现错位。界面常用的只有 12、13、14 三档；15 只给会话正文；16 以上只给标题。

## 文字角色

| 角色           | 规格                                                                       | 实现                                                                        |
| -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 整页标题       | 20/28，600，`--text-1`，单行省略                                           | `PageShell` 的 `.page-title`（`--fs-hero`）；副标题 13/20 `--text-3`        |
| 设置分区标题   | 16/24，600                                                                 | `SettingsModal` 顶栏；导航标题同规格                                        |
| 二级页标题     | 20/28                                                                      | `SettingsHero`                                                              |
| 弹窗标题       | 16/24，500                                                                 | `Modal`；说明文字 14/22                                                     |
| 面板顶栏标题   | 14/22，600                                                                 | `PaneHeader`                                                                |
| 设置分组标题   | 13/20，600，`--text-1`；分组说明 12/18 `--text-3`                          | `SettingsGroup`                                                             |
| 列表分组标签   | 12/18，500，`--text-3`                                                     | `ListSection`、设置导航的组标签、Git 改动分组、菜单里的 `label` 行（12/16） |
| 侧栏分组标题   | 13/20，500，`--text-3`                                                     | `SidebarSectionHeader`（置顶、项目、对话）                                  |
| 侧栏行         | 页面入口 14/22，新对话 14/22 500；会话标题 14/20，选中 500；时间 12/20     | `SidebarNav`、`SessionRow`                                                  |
| 设置行         | 标题 14/22 500，说明 12/18                                                 | `SettingsRow`、`SettingsLinkRow`（右侧取值 13/20、等宽数字）                |
| 列表行         | 标题 13/20，副标题与元信息 12/18                                           | `ListRow`                                                                   |
| 按钮           | sm 12/18、md 13/20、lg 14/22，都是 500                                     | `Button`                                                                    |
| 页签           | underline 13/20 500（大号 16/24）；segmented 12/18 500；editor 12/18 400   | `Tabs`                                                                      |
| 徽章           | 11/18，500；数字徽章等宽数字                                               | `Badge`（`--fs-xxxs`，高 18）                                               |
| 输入控件       | 13/20，400；字段标签 13/20 500；提示与错误 12/18                           | `TextField`、`TextArea`、`Select`、`Field`                                  |
| 菜单项         | 14/22；描述 12/18                                                          | `MenuItem`                                                                  |
| 提示气泡       | 13/20，多行按换行显示                                                      | `TooltipBubble`                                                             |
| 会话正文       | 15/26（`--type-body`），段落间 12px                                        | 回答正文（`.ds-md`）与用户气泡；见[会话流](conversation.md)                 |
| Markdown 标题  | h1 20/30、h2 18/28、h3 16/26，都是 600；h4–h6 与正文同大，600              | `ConversationMarkdown`；都小于页面标题                                      |
| Markdown 表格  | 表头 14/22 500，单元格 14/22                                               | `ConversationMarkdown`                                                      |
| 过程行与工具行 | 13/20；工具行附注 12/18                                                    | `ProcessGroup`、`ToolCallRow`                                               |
| 代码块         | 13/22 等宽（`--font-code`）；工具输出里的小号 12/18（`--font-code-small`） | `CodeBlock`                                                                 |
| 行内代码       | 等宽，父级字号的 0.875 倍，`--inline-code-bg` 底、`--r-sm` 圆角            | `ConversationMarkdown`                                                      |

其他 Markdown 区域（文件预览、计划审阅、PR 正文，全局类 `.markdown-body`）是 14px 正文、行高 28，标题 20 / 18 / 16。

## 字重

只用三档：`--weight-regular` 400、`--weight-medium` 500、`--weight-semibold` 600。

- **600**：标题与 Markdown 标题、`strong`/`b`、品牌名、需要强调的数字（用量统计、Metric）。
- **500**：控件文字（按钮、页签、徽章、Tag、Chip、字段标签、表头），以及「当前项」——选中的会话标题、当前页面入口、设置导航当前项、面包屑的当前一级。
- **400**：其余正文与说明。
- 页签选中时字重不变（underline 与 segmented 本来就是 500），靠一级文字色和 underline 的 2px 横线区分，不用金色。
- 字重必须写成 `var(--weight-*)`，数字写法和 400/500/600 之外的值都会被样式审计拦下（ratchet 规则 `font-weight-bare`、`font-weight-off-scale`，允许值为 0）。

## 中文排版

- **中英文间距**：`body` 开启 `text-autospace: normal`，浏览器在中文与英文、数字之间自动加一个窄空格，源文本里不手写空格。已经自带间距或者格式固定的文字关掉它：侧栏会话的相对时间用 `text-autospace: no-autospace`，让「6月26日」不变成「6 月 26 日」，而「5 分钟」本来就带空格。浏览器不支持时这条规则被忽略，不影响布局。
- **数字**：会变化或需要上下对齐的数字一律 `font-variant-numeric: tabular-nums`——计数、时间与用时、token 用量、体积、行号、Git 增删数、缩放比例（约 70 处）。快捷键提示 `Kbd` 用 `font-feature-settings: 'tnum'`。
- **换行**：
  - 说明文字和提示条用 `text-wrap: pretty`，避免最后一行只剩一个字；只有首启引导的大标题用 `text-wrap: balance`。
  - 代码、URL、命令、审批目标用 `word-break: break-all`，长串可以在任意位置断开。
  - 正文与工具输出用 `overflow-wrap: anywhere`（或 `word-break: break-word`），只在放不下时才断开长单词。
- **截断**：单行截断是标准写法（`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`），用于页面与分区标题、会话标题、菜单项。多行截断只在 MCP 卡片、诊断项和记录结构里出现。
- **字距**：默认 0，中文不加字距。只有几处英文或小字有轻微字距：品牌名与 `Kbd` 0.02em、空会话首页标题与首启引导的品牌名 0.01em。字距令牌 `--tracking-*` 与行高倍数 `--leading-*` 定义在 L1，目前没有组件使用。

## 写样式时

- 新组件用 `font: <字重> var(--type-*) var(--font-sans|mono)`。改旧组件时可以顺手把同值的 `--fs-*`/`--lh-*` 换成 `--type-*`，但值有变化的改动要单独看截图。
- 不写 9–15px 的裸字号，不写 `text-[Npx]` 类（样式审计）。16px 以上的裸值和 `font:` 简写里的像素值审计查不到，目前有：空会话首页标题 26/32、设置 Metric 数值 18/26、轨迹文件里的若干 `font:` 简写；这些是待收敛的例外，不要照抄。
- 文字颜色用 `--text-1..4`，不要用透明度做层级（见[颜色使用规范](color.md)）。
- 会话正文的排版有视觉测试守着：`process.spec.ts` 的「reply typography」断言正文 15/26、段落间 12px、h1 20/30、链接色与来源图标；`pages.spec.ts` 断言页面标题 20/600、正文列 880；`settings-groups.spec.ts` 断言设置分区标题 16/600。
