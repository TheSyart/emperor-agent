# 设计令牌

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-20<br>
> 事实源：`desktop/src/renderer/src/theme/`（`primitives.css`、`semantic.dark.css`、`semantic.light.css`、`components.css`、`legacy-aliases.css`、`legacy-keys.json`、`tokens.test.ts`）、`desktop/src/main/window-background.ts`

界面的颜色、尺寸、字号、圆角、间距和动效都来自三层令牌。组件只用 L2 与 L3，不直接写颜色值，也不直接用 L1 的颜色原子；新增样式先加令牌再使用。

| 层       | 文件                                              | 内容                                                                                                                           | 谁可以引用                                                |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| L1 原子  | `primitives.css`                                  | 与主题无关的原始值：中性灰阶、目标色板（ink、paper、gold）、圆角、字号、行高、字重、间距、层叠、动效、控件与图标尺寸、内容宽度 | 只有 L2；尺度类（圆角、间距、字号、动效等）组件可以直接用 |
| L2 语义  | `semantic.dark.css`（默认）、`semantic.light.css` | 颜色的含义：表面、文字、描边、强调色、状态、层级                                                                               | 组件、L3                                                  |
| L3 组件  | `components.css`                                  | 只属于某一类组件的令牌：侧栏、菜单、代码高亮、提示、头像、材质                                                                 | 组件                                                      |
| 迁移别名 | `legacy-aliases.css`                              | 0.2 之前的令牌名 → 现在对应的 L2 令牌                                                                                          | 旧代码；DS-02 迁移完调用点后删除                          |

约定：

- 实色是 RGB 三元组，用法 `rgb(var(--x))` 或 `rgb(var(--x) / 0.5)`；半透明叠层、描边、遮罩和阴影是完整值，直接 `var(--x)`。
- 深浅两套 L2 的键集合必须一致；每个 0.2 之前的令牌名都必须在某一层有定义，并且只在一层定义（`tokens.test.ts`）。
- 组件 CSS 不得使用 `--ink-*`、`--paper-*`、`--gold-*`（`tokens.test.ts`）。
- 主窗口在页面绘制前的底色取 `--surface-canvas`，跟随系统外观（`window-background.ts`，有测试保持一致）。

## 迁移进度

- DS-01 第一步：三层文件落地，L2 沿用 0.2 之前的取值，旧令牌名全部改为别名。验证：逐键解析两套主题下 238 个旧令牌的最终值，与拆分前完全一致；视觉套件 470 张截图逐像素无差异。
- DS-01 第二步（已完成）：L2 指向目标色板（暖中性灰、收敛的金色、新状态色、0.5px 描边与新的层级阴影），浅色主题四层表面（canvas、panel、raised、selected）互不相同；L3 改为引用 L2；旧别名 `--label-caption` 改指 `--text-3`（说明文字保持 4.5:1 以上，`--text-4` 只给占位符与禁用文字）。中英混排开启 `text-autospace`。
- DS-02：迁移调用点到 L2/L3 名称并删除别名层；字号从 `--fs-*` 切到 `--type-*`。

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

| 令牌                    | 用途                   |
| ----------------------- | ---------------------- |
| `--stroke-1`            | 最弱分隔               |
| `--stroke-2`            | 默认细线               |
| `--stroke-3`            | 强细线                 |
| `--stroke-4`            | 最强细线               |
| `--stroke-inverted`     | 反色底上的细线         |
| `--stroke-solid`        | 不透明边框（三元组）   |
| `--stroke-solid-strong` | 不透明强边框（三元组） |

### 强调色（Emperor 金，克制使用，见 [color.md](color.md)）

| 令牌             | 用途                           |
| ---------------- | ------------------------------ |
| `--accent`       | 发送、每屏唯一主按钮、开关选中 |
| `--accent-hover` | 强调色悬停                     |
| `--accent-soft`  | 选中／三级强调填充             |
| `--brand`        | 品牌标                         |
| `--focus-ring`   | 焦点环颜色（三元组）           |
| `--bubble-user`  | 用户消息气泡                   |

### 状态（Status）

| 令牌               | 用途                 |
| ------------------ | -------------------- |
| `--ok`             | 成功                 |
| `--warn`           | 警告                 |
| `--error`          | 错误、破坏性操作     |
| `--attention`      | 等待用户的审批与计划 |
| `--ok-soft`        | 成功底色             |
| `--warn-soft`      | 警告底色             |
| `--error-soft`     | 错误底色             |
| `--attention-soft` | 待处理底色           |

### 层级与遮罩（Elevation、scrim）

| 令牌           | 用途                 |
| -------------- | -------------------- |
| `--elev-1`     | 卡片                 |
| `--elev-2`     | 弹层                 |
| `--elev-3`     | 对话框               |
| `--scrim`      | 模态遮罩（完整颜色） |
| `--scrim-soft` | 浅遮罩（完整颜色）   |

## L3 组件令牌

`--accent-glare` `--accent-soft-strong` `--active-bg-a` `--approval-line` `--approval-strong` `--avatar-1` `--avatar-2` `--avatar-3` `--avatar-4` `--avatar-5` `--avatar-6` `--button-primary-fg` `--button-primary-fill` `--button-primary-hover` `--caret` `--code-banner-bg` `--code-block-bg` `--code-comment` `--code-constant` `--code-fg` `--code-function` `--code-keyword` `--code-link` `--code-parameter` `--code-punctuation` `--code-string` `--code-string-expression` `--ghost-active-border` `--ghost-active-fill` `--glass-alpha` `--glass-bg` `--glass-blur` `--glass-border` `--glass-border-a` `--glass-saturate` `--glass-shadow` `--glass-solid-alpha` `--hover-bg-a` `--inline-code-bg` `--input-major` `--mask-blur` `--material-1-alpha` `--material-1-bg` `--material-1-blur` `--material-2-alpha` `--material-2-bg` `--material-2-blur` `--material-3-alpha` `--material-3-bg` `--material-3-blur` `--menu-fill` `--nb-60` `--panel-edge` `--scrim-a` `--scrollbar-thumb` `--scrollbar-thumb-hover` `--selector-fill` `--settings-card-control-fill` `--settings-card-fill` `--shadow-color` `--shadow-lv1-blur` `--sidebar-fill` `--sidebar-item-active` `--sidebar-item-hover` `--skeleton-bg` `--state-error-label` `--state-error-soft` `--state-ok-label` `--state-ok-soft` `--state-warn-label` `--state-warn-soft` `--text-primary` `--text-secondary` `--text-tertiary` `--tip-fill` `--toast-bg` `--toast-fg` `--tone-blue` `--tone-cyan` `--tone-violet` `--tooltip-bg` `--tooltip-fg`

外壳（[外壳布局](layout.md)）：`--shell-bar-h` 46（会话头第一行；工作台 PaneHeader 上移 2px 与它底边对齐）、`--icon-button-lg` 36（收起后窄轨的按钮）。UI-S01 的图标栏、画布槽、红绿灯与面板令牌已随 UI-S11 删除。

输入框（UI-S04，[输入框](composer.md)）：`--composer-fill`（卡片底色，两套主题都是 `--surface-raised`）、`--composer-edge`（卡片边缘：深色 `--elev-1`，浅色 0.5px `--hairline` 加 `--elev-1`）。

环境信息卡（UI-S05）：`--env-card-fill`（深色 `--surface-raised`，浅色 `--surface-base`）、`--env-card-edge`（两套主题都是 `--elev-2`）；卡片圆角 `--r-lg`，行高 `--row-h`，分节之间 12px、不画线。

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
| 内容宽度  | `--content-chat` 760、`--content-page` 880、`--content-form` 640                                                                                                                            |

旧尺度（`--radius-*`、`--fs-*`/`--lh-*`、`--space-*`、`--z-*`、`--duration-*`）仍在 L1，DS-02 迁到上表后删除。
