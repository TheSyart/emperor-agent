# 组件规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-21（对照 `a33caa42`）<br>
> 事实源：`desktop/src/renderer/src/components/ui/`（组件、`index.ts`、`floatingMenu.ts`、`headTailCap.ts`、`useCopyFeedback.ts`、`elapsed.ts`，测试 `display.test.ts`、`actions.test.ts`、`primitives.test.ts`、`overlays.test.ts`）、`desktop/src/renderer/src/components/settings/ui/`、`desktop/src/renderer/src/theme/components.css`；开发模式下打开 `?ui-gallery`、`?settings-gallery` 查看全部组件与状态

界面控件统一来自 `components/ui/`。组件只用 [设计令牌](tokens.md) 的 L2/L3 令牌，深浅两套主题都成立；可交互的控件都能用键盘操作，焦点统一画 `--focus-ring`。文字规格见[排版](typography.md)，动效见[动效](motion.md)，弹窗、确认框与轻提示见[浮层规范](overlays.md)。下面只写已经实现的组件；新增变体先改组件和这里，再在页面里用。

## 基础与操作

| 组件       | 用途与变体                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Icon       | 统一图标注册表，尺寸 xs 12 / sm 14 / md 16 / lg 20，线条 1.5；不接受刻度以外的尺寸                                                                          |
| Button     | primary（金色，每屏最多一个）/ secondary / ghost / danger（只在确认场景）；sm 28 / md 32 / lg 40                                                            |
| IconButton | 只有图标的按钮，xs 20 / sm 28 / md 32 / lg 36（收起后的窄轨）；必须有 `label`，提示走 Tooltip，不用原生 title；`selected` 画 `--surface-selected`           |
| LinkButton | 行内文字按钮，`--text-link`                                                                                                                                 |
| Spinner    | sm / md，neutral / accent；减少动态效果时不旋转                                                                                                             |
| Skeleton   | 行、块、圆                                                                                                                                                  |
| Kbd        | 快捷键提示                                                                                                                                                  |
| Tooltip    | 悬停与聚焦气泡（Tooltip 与 IconButton 共用 `useTooltip`），可带快捷键；`top` 气泡离窗口顶边不足 40px 时改在下方（无标题栏窗口的顶栏），贴左右边时收回窗口内 |

## 显示

| 组件   | 用途与变体                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Badge  | 静态标签，高 18。`tone`：neutral / accent（只给品牌或选中标记）/ ok / warn / error / attention / info；`variant`：soft（浅底，默认）/ count（数字，等宽数字）/ dot-label（前置 6px 圆点 + 文字，无底色） |
| Tag    | 可交互胶囊，高 28：筛选、附件、引用。`selected` 表示筛选已打开（aria-pressed）；`removable` 加 × 按钮，聚焦时按 Backspace / Delete 移除；`leading` 插槽放 16px 缩略图                                    |
| Dot    | 状态圆点，6 / 8px：ok / warn / error / running（金色脉冲，一屏只有一个「运行中」）/ idle / attention（等待用户的审批与计划）。有 `label` 时读屏可读，否则只作装饰                                        |
| Avatar | 16 / 20 / 24 / 28 / 40。sprite（子智能体头像）/ color（六种头像色之一 + 首字）/ logo（模型商标志或插件图片，失败时退回颜色块）/ initials（中性底首字）；刻度以外的尺寸取最近一档并报错                   |

子智能体头像是透明底的角色，没有方片和外框（UI-S13），从 448px 的整张素材里裁出，占头像框的 94%；裁剪和缩放用一次 `createImageBitmap` 完成，画进尺寸正好是「显示尺寸 × 设备像素比」的 canvas；页面上不保留整张素材，同一头像同一尺寸只解码一次。

## 列表与表面

| 组件               | 用途与变体                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ListRow            | 列表行，高 32 / 40 / 52。插槽 leading、标题、subtitle、meta、trailing；`selected`、`nested`（缩进一级）、`danger`、`disabled`。trailing 的操作只在悬停或键盘聚焦时出现；上下方向键、Home / End 在同一列表内移动，Enter / Space 选择 |
| List / ListSection | List 是 listbox，行是 option；ListSection 是带 12/500 三级文字标题的分组，组内行之间画左缩进 16 的 0.5px 细线（选中行两侧不画）。列表不再套卡片                                                                                     |
| Surface            | 面板级容器：raised（默认，比面板高一级 + 细线）/ sunken（代码、凹陷区）/ overlay（浮层 + 层级阴影）；`pad` none / sm 12 / md 16；`radius` md 12 / lg 16；`interactive` 加悬停与焦点（配 `as="button"`）                             |
| EmptyState         | block（20px 图标 + 标题 + 描述 + 按钮，居中）/ inline（单行，可带一个尾部操作）；`framed` 画虚线框，放在卡片里时自动去掉                                                                                                            |
| Notice             | 提示条：左侧图标 + 标题 + 说明 + 可选操作；tone 与 Badge 相同，warn / error 以 role=alert 播报。只在问题存在时出现                                                                                                                  |
| DisclosureRow      | 会话流里的 28px 可折叠行：14px 图标（悬停换成箭头）、13px 标题与摘要、「·」分隔、可选尾部操作；正文左缩进 22px，展开收起用 CollapseTransition（见[会话流](conversation.md)）                                                        |
| IoBlock            | 工具展开后的 IN / OUT 块：`--surface-raised`、`--r-md`、无边框，每段最高 150px，过长时「展开全部」；`tree` 把对象显示为 JsonTree（未知工具的通用正文）                                                                              |
| PaneHeader         | 面板顶栏，固定 48px：标题 + 可选 Tabs + 右侧操作；长标题截断，高度不随内容变化。工作台用它做顶栏，上移 2px 与会话头 46px 的第一行底边对齐，左侧是 segmented 面板切换、右侧关闭，不放标题（见[外壳布局](layout.md)）                 |

## 输入

| 组件        | 用途与变体                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TextField   | 单行输入：高 32（sm 28）、圆角 `--r-sm`、字段底色上一条细线；聚焦画 `--focus-ring`，出错画错误色细线                                                                                  |
| TextArea    | 多行输入，外观同 TextField，随内容在 `minRows` 与 `maxRows` 之间增高                                                                                                                  |
| SearchField | 唯一的搜索框：前置搜索图标，有内容时出现清除按钮；Esc 清空并停在这里，框为空时 Esc 交给外层（关闭弹层）                                                                               |
| Select      | 选择按钮（md 32 / sm 28），展开 Menu（向下，至少 180 宽）；外观同 TextField。按钮上 ↑ / ↓ 打开，列表里方向键循环、Home / End 到两端、Tab 关闭，选中后焦点回到按钮；选项可带说明与停用 |
| Segmented   | 少量互斥选项，外观是分段 Tabs，语义是单选组                                                                                                                                           |
| Switch      | 开关；打开时用金色（金色允许出现的少数位置之一）                                                                                                                                      |
| Checkbox    | 16px 方框：未选 / 选中 / 部分选中（`indeterminate`），点部分选中的框会变成选中                                                                                                        |
| Field       | 标签 + 控件 + 提示 / 错误，自动接好 id、aria-describedby 与 aria-invalid                                                                                                              |

## 菜单与触发器

| 组件     | 用途与变体                                                                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu     | 锚定在按钮上的菜单：`--menu-fill`、圆角 12、内边距 4，最宽 360。`placement` top（默认）/ bottom，空间不够时才翻到另一侧；`align` end（默认）/ start；`dense` 行高 34（默认 40）；`width` 是最小宽度；`footer` 插槽上方一条细线。Esc 关闭并把焦点还给触发按钮，点击或聚焦到菜单外关闭；菜单本身不处理方向键（Select 与模型选择器自己加） |
| MenuItem | 菜单行：14/22，圆角 10，悬停填充。`variant` item / label（12/16 三级文字的小标题）/ separator；`selected` 在行尾画 ✓（`aria-checked`）；`danger` 红字；`disabled`；`description` 第二行 12/18；`keepOpen` 选中后不关闭菜单。`icon` 插槽 16px                                                                                            |
| Chip     | 输入框底栏的触发器（权限、模型）：28 高的胶囊，13/20 500，二级文字，最宽 220。`tone` default / approval（计划，`--attention` 系）/ accent；`active` 表示对应菜单开着；`chevron` 加下拉箭头                                                                                                                                              |

## 代码与工具输出

工具展开后的正文用一组「块」组件。它们共用：`--code-block-bg` 底色、圆角 12（`--radius-card`）；超过 16 行时只显示头尾，中间是「… 其余 N 行」，点开后变「收起」；右上角「复制」，复制后 1 秒内显示「复制成功」。

| 组件          | 用途                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeBlock     | 代码：吸顶的语言与复制栏，highlight.js 着色，13/22 等宽；`small` 是 12/18（工作流面板）。未知语言按纯文本                                                                 |
| DiffBlock     | 写入、编辑、记忆修改的差异：增行 `--ok`、删行 `--error`、上下文三级文字，底部 `└ +A -R · N file(s)`                                                                       |
| TerminalBlock | 命令与输出：顶栏是运行状态点、工作目录与命令；输出保留 ANSI 颜色（映射到令牌）且不自动换行；非 0 退出码或被信号终止时显示红色标签；运行中只显示顶栏，没有输出时「无输出」 |
| ReadBlock     | 读文件：48px 行号栏，只读了一部分时标出「显示 n / 总 行」                                                                                                                 |
| SearchBlock   | grep / glob 结果：「N 处匹配 · M 个文件」或「N 个路径」，按文件分组、可折叠；没有结果时「无结果」                                                                         |
| WebBlock      | 网页搜索与读取：回答、来源列表（最高 320）、状态码；只有 http(s) 地址做成链接                                                                                             |
| JsonTree      | 可折叠的 JSON（默认展开一层），键、字符串、数字用代码高亮色；`IoBlock` 的 `tree` 用它显示未知工具的参数                                                                   |

## 其他显示组件

| 组件         | 用途                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ElapsedClock | 用时，每秒更新、等宽数字：`9s`、`1m 05s`、`1h 02m`；给了结束时间就停住。用在轮次状态与运行中的过程行                                                                                           |
| Shimmer      | 文字上掠过一道亮带表示「正在进行」：accent（金色，轮次状态）或 neutral；`active` 为否时是普通二级文字。减少动态效果时静止                                                                      |
| DocumentIcon | 按文件扩展名取的文件类型图标（装饰性，读屏忽略）；`directory` 画文件夹。尺寸由调用方给（文件树 14、气泡 16、改动卡 18）                                                                        |
| 看图器       | `ImageLightbox`（由 `ImageViewerHost` 按需加载）：← / → 换图，+ / − 缩放，滚轮以指针为中心缩放，拖动平移，双击在适应窗口与 100% 之间切换，点空白处或 Esc 关闭；缩放 0.1–8 倍；始终是深色观看面 |

## 设置页原语

设置页用 `components/settings/ui/` 搭建（写法见[扩展指南](../development/extending-emperor.md)，布局规则见[外壳布局](layout.md#设置面板)）：`SettingsSection`（一页）、`SettingsGroup`（带标题的一组，`rows` 是一张卡片、`stack`、`form`；`plain` 不画卡片）、`SettingsRow`（左文字右控件，容器窄于 440 时上下排）、`SettingsLinkRow`（整行打开二级页）、`SettingsRowMenu`（行尾「⋯」）、`SettingsCard`（可展开的卡片）、`SettingsHero`（二级页头）、`SettingsTable`、`DefinitionList`（键值表，空值显示「—」）、`Metric`（数字卡）、`CodeEditor`（等宽编辑器，⌘S 保存）、`ShortcutEditor`（录制快捷键）。

## 页签

Tabs 一个组件三种外观：underline（页面与面板视图，选中项是一级文字 + 500 字重 + 2px 横线，不用金色）、segmented（筛选与工作台的面板切换，可带数字）、editor（文件与终端，`closable` 的页签有 × 按钮，Delete 关闭）。左右方向键、Home / End 移动并选中，跳过停用的页签。页签可带 `title`（悬停说明：完整路径、停用的原因），写在页签外层，停用的页签也能显示。

工作台的「文件」与「终端」共用 `workspace/WorkspaceTabBar`：editor 页签条放在 `--surface-canvas` 上，选中的页签用面板的 `--surface-base` 与下方内容连成一片，条底一条 0.5px 发丝线；「+」紧跟在最后一个页签后，面板自己的操作在最右。两个面板的页签条不各写一套。

Menu 与 Popover 默认右边缘对齐触发按钮；触发按钮在面板左侧（例如「审查」的「分支名 ▾」）时用 `align="start"` 左对齐，不向左盖住相邻的栏。

## 反例

- 不要手写 `.count`、`.tag`、`.dot`、`.empty` 和提示条：用 Badge、Dot、EmptyState、Notice。
- 不要用裸 `<input>`、`<input type="checkbox">` 和自绘搜索框：用 TextField、Checkbox、SearchField。
- 不要给徽章、图表和装饰用金色；状态只用状态色。
- 不要在卡片里再套卡片：分组用 ListSection，容器用 Surface。
- 不要用 Chip 做筛选、附件或引用：那是 Tag。Chip 只是输入框底栏打开菜单的触发器。
- 不要手写 `<pre>` 显示工具输出或代码：用 CodeBlock、TerminalBlock 等块组件，长输出的折叠、复制和颜色才一致。
- 不要用原生 `title` 做提示：IconButton 写 `label`，其余用 Tooltip。
