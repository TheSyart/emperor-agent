# 设计令牌

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-22（对照 `b4b98b8c`）<br>
> 事实源：`desktop/src/renderer/src/theme/`（`primitives.css`、`semantic.dark.css`、`semantic.light.css`、`components.css`、`base.css`、`retired-tokens.json`、`legacy-keys.json`、`tokens.test.ts`）、`desktop/src/renderer/src/style-audit.test.ts` 与 `style-audit-ratchet.json`、`scripts/codemods/tokens-v2.mjs`、`desktop/src/main/window-background.ts`

界面的颜色、尺寸、字号、圆角、间距和动效都来自三层令牌。组件只用 L2 与 L3，不直接写颜色值，也不直接用 L1 的颜色原子；新增样式先加令牌再使用。这里列出令牌本身；怎样用见[颜色使用规范](color.md)、[排版](typography.md)、[外壳布局](layout.md)与[动效](motion.md)。

| 层       | 文件                                              | 内容                                                                                                                           | 谁可以引用                                                |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| L1 原子  | `primitives.css`                                  | 与主题无关的原始值：中性灰阶、目标色板（ink、paper、gold）、圆角、字号、行高、字重、间距、层叠、动效、控件与图标尺寸、内容宽度 | 只有 L2；尺度类（圆角、间距、字号、动效等）组件可以直接用 |
| L2 语义  | `semantic.dark.css`（默认）、`semantic.light.css` | 颜色的含义：表面、文字、描边、强调色、状态、层级                                                                               | 组件、L3                                                  |
| L3 组件  | `components.css`                                  | 只属于某一类组件的令牌：侧栏、菜单、代码高亮、提示、头像、材质                                                                 | 组件                                                      |
| 退役名单 | `retired-tokens.json`                             | 0.2 之前的令牌名 → 替代它的令牌（这些名字不再定义）                                                                            | 只给 codemod 与样式审计读取                               |

约定：

- 实色是 RGB 三元组，用法 `rgb(var(--x))` 或 `rgb(var(--x) / 0.5)`；半透明叠层、描边、遮罩和阴影是完整值，直接 `var(--x)`。
- 深浅两套 L2 的键集合必须一致；每个 0.2 之前的令牌名要么仍在某一层有定义（只在一层），要么列在 `retired-tokens.json` 里且不再定义（`tokens.test.ts`）。
- 组件 CSS 不得使用 L1 的颜色原子与原始阴影：`--ink-*`、`--paper-*`、`--gold-*`、`--shadow-lv1..3`（`tokens.test.ts` 与样式审计的 `l1-token` 规则）。
- 不再使用 Tailwind：元素重置与表单控件默认外观在 `styles.css`，全部写成令牌 CSS；新样式不写 `@apply` 与工具类。
- 样式审计（`style-audit.test.ts`）在原有规则之外有 13 条 ratchet 规则，计数按文件记在 `style-audit-ratchet.json`，只降不升，目标为 0：`components/ui` 之外的裸 `<button>`、`<input>`、`<select>`、`<textarea>`；字重写成数字（只用 `--weight-*`）与 400/500/600 之外的字重；1px 实线边框（改用 0.5px `--hairline` 阴影或表面色差）；图标 `:size` 不在 12/14/16/20；`@apply`；对 grid 轨道、宽度、高度做过渡；`z-[..]` 与非 `--z-*` 的 z-index；L1 颜色原子；退役令牌名（含写成字符串的 `getPropertyValue('--x')`）。计数比允许值低时测试也会失败，提示把允许值调低（`STYLE_AUDIT_TIGHTEN=1` 自动调低）。
- 合并仍在用旧名的分支后运行 `node scripts/codemods/tokens-v2.mjs`（按类别改写，可重复运行；`--check` 只检查）。
- 主窗口在页面绘制前的底色取 `--surface-canvas`，跟随系统外观（`window-background.ts`，有测试保持一致）。

## 迁移进度

- DS-01 第一步：三层文件落地，L2 沿用 0.2 之前的取值，旧令牌名全部改为别名。验证：逐键解析两套主题下 238 个旧令牌的最终值，与拆分前完全一致；视觉套件 470 张截图逐像素无差异。
- DS-01 第二步（已完成）：L2 指向目标色板（暖中性灰、收敛的金色、新状态色、0.5px 描边与新的层级阴影），浅色主题四层表面（canvas、panel、raised、selected）互不相同；L3 改为引用 L2；旧别名 `--label-caption` 改指 `--text-3`（说明文字保持 4.5:1 以上，`--text-4` 只给占位符与禁用文字）。中英混排开启 `text-autospace`。
- DS-02（已完成）：约 1,400 处旧名引用由 `tokens-v2` codemod 分类改写（表面、文字、描边、强调与状态、层级、圆角、字号、动效、L1 状态色、透明度文字层级、字重、图标尺寸），随后删除别名层 `legacy-aliases.css`（53 个别名）、`nb-*` 中性灰阶、`glass-*` 与 `material-*` 材质、透明度文字层级（`--text-primary/secondary/tertiary`、`--hover-bg-a` 等）、dsh 动效时长（`--duration-ds-*`、`--ease-in-out`）、L1 状态原子（`--approval`、`--state-ok`、`--state-warn`）以及没有用户的 `.glass`、`.focus-ring`；移除 Tailwind。值有变化的改写见下方「DS-02 吸附表」。
- 未做：字号从 `--fs-*` 切到 `--type-*`（会改变全部文字排版，留给逐屏的 UI 任务）；旧尺度 `--radius-row/card/…`、`--space-*`、`--z-*`、`--duration-*` 仍在 L1（间距与层叠没有新的对应令牌）。

## L2 语义令牌

### 表面（Surfaces）

| 令牌                     | 用途                 |
| ------------------------ | -------------------- |
| `--surface-canvas`       | 窗口底色             |
| `--surface-base`         | 面板与卡片           |
| `--surface-raised`       | 面板内的抬升填充     |
| `--surface-overlay`      | 菜单与弹层           |
| `--surface-sunken`       | 代码块、凹陷区       |
| `--surface-selected`     | 选中的行             |
| `--surface-strong`       | 强调中性填充         |
| `--surface-hover`        | 悬停叠层（完整颜色） |
| `--surface-active`       | 按下叠层（完整颜色） |
| `--surface-hover-strong` | 强悬停叠层           |
| `--surface-hover-danger` | 危险操作悬停叠层     |
| `--surface-hover-solid`  | 不透明悬停填充       |

### 文字（Text）

| 令牌               | 用途               |
| ------------------ | ------------------ |
| `--text-1`         | 主文字             |
| `--text-2`         | 次要文字           |
| `--text-3`         | 三级文字、元信息   |
| `--text-4`         | 说明文字、占位符   |
| `--text-disabled`  | 禁用文字           |
| `--text-inverted`  | 反色底上的文字     |
| `--text-link`      | 链接与行内引用     |
| `--text-on-accent` | 强调色填充上的文字 |

### 描边（Strokes，完整颜色；DS-02 起以 0.5px box-shadow 绘制）

| 令牌                    | 用途                                                 |
| ----------------------- | ---------------------------------------------------- |
| `--stroke-1`            | 最弱分隔                                             |
| `--stroke-2`            | 默认细线                                             |
| `--stroke-3`            | 强细线                                               |
| `--stroke-4`            | 最强细线                                             |
| `--stroke-inverted`     | 反色底上的细线                                       |
| `--stroke-solid`        | 不透明边框（三元组）                                 |
| `--stroke-solid-strong` | 不透明强边框（三元组）                               |
| `--hairline`            | 默认的 0.5px 分隔线（`--stroke-2`），画成 box-shadow |

### 强调色（Emperor 金，克制使用，见 [color.md](color.md)）

| 令牌             | 用途                                              |
| ---------------- | ------------------------------------------------- |
| `--accent`       | 发送、每屏唯一主按钮、开关选中                    |
| `--accent-hover` | 强调色悬停                                        |
| `--accent-soft`  | 选中／三级强调填充                                |
| `--brand`        | 品牌标                                            |
| `--focus-ring`   | 焦点环颜色（三元组；画法见 [color.md](color.md)） |
| `--bubble-user`  | 用户消息气泡                                      |

### 状态（Status）

| 令牌               | 用途                 |
| ------------------ | -------------------- |
| `--ok`             | 成功                 |
| `--warn`           | 警告                 |
| `--error`          | 错误、破坏性操作     |
| `--attention`      | 等待用户的审批与计划 |
| `--info`           | 中性的说明与提示     |
| `--ok-soft`        | 成功底色             |
| `--warn-soft`      | 警告底色             |
| `--error-soft`     | 错误底色             |
| `--attention-soft` | 待处理底色           |
| `--info-soft`      | 说明底色             |

### 层级与遮罩（Elevation、scrim）

| 令牌           | 用途                 |
| -------------- | -------------------- |
| `--elev-1`     | 卡片                 |
| `--elev-2`     | 弹层                 |
| `--elev-3`     | 对话框               |
| `--scrim`      | 模态遮罩（完整颜色） |
| `--scrim-soft` | 浅遮罩（完整颜色）   |

## L3 组件令牌

`--accent-glare` `--accent-soft-strong` `--approval-line` `--approval-strong` `--avatar-1` `--avatar-2` `--avatar-3` `--avatar-4` `--avatar-5` `--avatar-6` `--backdrop-blur` `--backdrop-blur-strong` `--button-primary-fg` `--button-primary-fill` `--button-primary-hover` `--caret` `--code-banner-bg` `--code-block-bg` `--code-comment` `--code-constant` `--code-fg` `--code-function` `--code-keyword` `--code-link` `--code-parameter` `--code-punctuation` `--code-string` `--code-string-expression` `--ghost-active-border` `--ghost-active-fill` `--inline-code-bg` `--input-major` `--mask-blur` `--menu-fill` `--panel-edge` `--pointer-ink` `--scrollbar-thumb` `--scrollbar-thumb-hover` `--selector-fill` `--settings-card-control-fill` `--settings-card-fill` `--shadow-color` `--sidebar-fill` `--sidebar-item-active` `--sidebar-item-hover` `--site-icon-plate` `--skeleton-bg` `--state-error-label` `--state-error-soft` `--state-ok-label` `--state-ok-soft` `--state-warn-label` `--state-warn-soft` `--tip-fill` `--toast-bg` `--toast-fg` `--tone-blue` `--tone-cyan` `--tone-violet` `--tooltip-bg` `--tooltip-fg`

外壳（[外壳布局](layout.md)）：`--shell-bar-h` 46（会话头第一行；工作台 PaneHeader 上移 2px 与它底边对齐）、`--icon-button-lg` 36（收起后窄轨的按钮）。UI-S01 的图标栏、画布槽、红绿灯与面板令牌已随 UI-S11 删除。

输入框（UI-S04，[输入框](composer.md)）：`--composer-fill`（卡片底色，两套主题都是 `--surface-raised`）、`--composer-edge`（卡片边缘：深色 `--elev-1`，浅色 0.5px `--hairline` 加 `--elev-1`）。

环境信息卡（UI-S05）：`--env-card-fill`（深色 `--surface-raised`，浅色 `--surface-base`）、`--env-card-edge`（两套主题都是 `--elev-2`）；卡片圆角 `--r-lg`，行高 `--row-h`，分节之间 12px、不画线。

背板与固定色（DS-02）：`--backdrop-blur` 12px（遮罩、看图、附件预览的背景模糊）、`--backdrop-blur-strong` 24px（浮动菜单、看图工具栏）、`--mask-blur` 2px；`--site-icon-plate`（站点图标下的白底）、`--pointer-ink`（电脑操作截图上的指针）两套主题相同；看图底色的透明度 `--image-viewer-veil` 在 `base.css`。减少透明度时 `a11y.css` 把两档背景模糊归零、看图底色改为 0.98。

DS-04 组件尺寸（[组件规范](components.md)）：`--badge-h` 18、`--dot-sm` 6、`--dot-md` 8、`--field-h` 32、`--field-h-sm` 28、`--field-fill`（输入框底色）、`--list-row-sm` 32、`--list-row-md` 40、`--list-row-lg` 52、`--list-inset` 16（组内细线左缩进）、`--pane-header-h` 48、`--switch-thumb`（开关圆钮，两套主题都是白色）。

## L1 尺度（目标值，组件可直接使用）

| 类别      | 令牌                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 圆角      | `--r-xs` 4、`--r-sm` 8、`--r-md` 12、`--r-lg` 16、`--r-xl` 24、`--r-full`                                                                                                                   |
| 控件高度  | `--control-xs` 20、`--control-sm` 28、`--control-md` 32、`--control-lg` 40；行高 `--row-h` 32、`--row-h-lg` 52                                                                              |
| 图标      | `--icon-xs` 12、`--icon-sm` 14、`--icon-md` 16、`--icon-lg` 20，描边 `--icon-stroke` 1.5                                                                                                    |
| 字号/行高 | `--type-caption` 12/18、`--type-footnote` 13/20、`--type-body-sm` 14/22、`--type-body` 15/26、`--type-title-sm` 16/24、`--type-title` 20/28、`--type-display` 28/36；Markdown `--md-h1..h3` |
| 字重      | `--weight-regular` 400、`--weight-medium` 500、`--weight-semibold` 600                                                                                                                      |
| 动效      | `--motion-fast` 120ms、`--motion-base` 200ms、`--motion-slow` 320ms；`--ease-standard`、`--ease-exit`                                                                                       |
| 内容宽度  | `--content-chat` 760、`--content-page` 880、`--content-form` 640（目前没有组件使用；实际的列宽见[外壳布局](layout.md#内容宽度)）                                                            |

旧尺度（`--radius-row/cell/card/takeover/composer/modal/pill`、`--fs-*`/`--lh-*` 与 `--font-*` 简写、`--space-*`、`--z-*`、`--duration-*`、`--ease-out/spring/in`）仍在 L1，组件可以继续使用；DS-02 删除了旧的 `--radius-xs/sm/md/lg/xl`、`--font-size-*` 别名与 dsh 动效时长。`--tracking-*`、`--leading-*` 定义在 L1 但没有使用者。两套字号刻度怎样对应见[排版](typography.md#字号与行高)，两套时长见[动效](motion.md#时长与缓动)。

## DS-02 吸附表

codemod 把旧名改成新名；下面这些改写会让数值变化（其余改写数值不变，构建出的 CSS 逐条比对一致）。

| 旧值                                                                    | 新值                                                            | 涉及                                                                                                                                              | 看得到的变化                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--radius-sm` 6px                                                       | `--r-sm` 8px                                                    | 17 处：行内代码、小标签（输入框面板来源标签、提问卡序号、子智能体能力标签）、模型选择器返回键、几种 24–28px 的小行、Chrome 扩展安装步骤里的路径框 | 圆角大 2px                                               |
| `--radius-xl` 20px                                                      | `--r-xl` 24px                                                   | 附件预览窗                                                                                                                                        | 圆角大 4px                                               |
| Tailwind `rounded-md` 6px                                               | `--r-sm` 8px                                                    | Markdown 代码块与表格（文件预览、计划审阅、PR 正文）                                                                                              | 圆角大 2px                                               |
| `--font-size-2xs`、Tailwind `text-[10px]` 10px                          | `--fs-xxxs` 11px                                                | 输入框面板的来源标签、附件 chip 的大小说明                                                                                                        | 字大 1px                                                 |
| 字重 510、450                                                           | 500                                                             | 工作流面板、子智能体能力标签                                                                                                                      | 几乎看不出                                               |
| 字重 560、650、700（含 Tailwind `font-bold`、重置里的 `bolder`）        | 600                                                             | 输入框面板条目名、轨迹记录类型标签、Markdown 文件类型徽标、代码高亮里的粗体、附件 chip 文件名、未单独设字重的 `<b>`/`<strong>`                    | 粗体略细                                                 |
| `rgb(var(--fg) / var(--text-secondary))`（深色约 194，浅色约 105）      | `--text-2`（168 / 95）                                          | 输入框面板说明、Markdown 引用块、附件说明与预览标题                                                                                               | 深色略暗，浅色略深                                       |
| `rgb(var(--fg) / var(--text-tertiary))`（约 160 / 137）                 | `--text-3`（138 / 117）                                         | 输入框面板次要文字、链接 chip 图标、输入框占位符                                                                                                  | 同上                                                     |
| `rgb(var(--fg) / var(--hover-bg-a))`                                    | `--surface-hover`                                               | 回合审查行悬停                                                                                                                                    | 无                                                       |
| `--approval` 245 158 11（两套主题相同）                                 | `--attention`（深色 240 136 62，浅色 194 87 12）                | 审批、授权、计划卡的边框与计划胶囊、工具树里的待审批图标                                                                                          | 更偏橙，浅色更深                                         |
| `--state-ok` 34 197 94                                                  | `--ok`（76 195 138 / 31 157 85）                                | 定时任务与浏览器的成功文字、用量图表                                                                                                              | 深色略柔和，浅色更深                                     |
| `--state-warn` 245 158 11                                               | `--warn`（232 162 59 / 181 96 11）                              | Skill 问题提示、Hook 测试与粘贴对话框的警告边框、用量图表                                                                                         | 浅色明显更深、更易读                                     |
| `--duration-ds-fast` 100ms、`--duration-ds-slow` 300ms、`--ease-in-out` | `--motion-fast` 120ms、`--motion-slow` 320ms、`--ease-standard` | 约 70 处悬停、展开与动画                                                                                                                          | 略慢 20ms，曲线前快后缓                                  |
| 图标 11 / 13 / 15 / 19 / 22px                                           | 12 / 14 / 16 / 20 / 20px                                        | 73 处                                                                                                                                             | 图标大 1px 或小 2px                                      |
| Markdown `<hr>`：1px `#e5e7eb`                                          | 0.5px `--hairline`                                              | Markdown 正文里的分隔线                                                                                                                           | 深色下不再是一条亮线                                     |
| 首启弹窗背景 z-index 70                                                 | `--z-drawer` 60                                                 | 首启引导（UI-S17 起铺满窗口）                                                                                                                     | 无（仍在页面、吸顶栏之上，在弹层、提示、模态与菜单之下） |
| 运行中定时任务的旋转 `LoaderCircle`                                     | `Spinner`（金色）                                               | 定时任务行                                                                                                                                        | 加载圈样式统一                                           |
