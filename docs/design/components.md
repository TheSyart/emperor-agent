# 组件规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-19<br>
> 事实源：`desktop/src/renderer/src/components/ui/`（组件与 `display.test.ts`、`actions.test.ts`）、`desktop/src/renderer/src/theme/components.css`；开发模式下打开 `?ui-gallery` 查看全部组件与状态

界面控件统一来自 `components/ui/`。组件只用 [设计令牌](tokens.md) 的 L2/L3 令牌，深浅两套主题都成立；可交互的控件都能用键盘操作，焦点统一画 `--focus-ring`。下面只写已经实现的组件；新增变体先改组件和这里，再在页面里用。

## 基础与操作

| 组件       | 用途与变体                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Icon       | 统一图标注册表，尺寸 xs 12 / sm 14 / md 16 / lg 20，线条 1.5；不接受刻度以外的尺寸               |
| Button     | primary（金色，每屏最多一个）/ secondary / ghost / danger（只在确认场景）；sm 28 / md 32 / lg 40 |
| IconButton | 只有图标的按钮，xs 20 / sm 28 / md 32；必须有 `label`，提示走 Tooltip，不用原生 title            |
| LinkButton | 行内文字按钮，`--text-link`                                                                      |
| Spinner    | sm / md，neutral / accent；减少动态效果时不旋转                                                  |
| Skeleton   | 行、块、圆                                                                                       |
| Kbd        | 快捷键提示                                                                                       |

## 显示

| 组件   | 用途与变体                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Badge  | 静态标签，高 18。`tone`：neutral / accent（只给品牌或选中标记）/ ok / warn / error / attention / info；`variant`：soft（浅底，默认）/ count（数字，等宽数字）/ dot-label（前置 6px 圆点 + 文字，无底色） |
| Tag    | 可交互胶囊，高 28：筛选、附件、引用。`selected` 表示筛选已打开（aria-pressed）；`removable` 加 × 按钮，聚焦时按 Backspace / Delete 移除；`leading` 插槽放 16px 缩略图                                    |
| Dot    | 状态圆点，6 / 8px：ok / warn / error / running（金色脉冲，一屏只有一个「运行中」）/ idle / attention（等待用户的审批与计划）。有 `label` 时读屏可读，否则只作装饰                                        |
| Avatar | 16 / 20 / 24 / 28 / 40。sprite（子智能体头像）/ color（六种头像色之一 + 首字）/ logo（模型商标志或插件图片，失败时退回颜色块）/ initials（中性底首字）；刻度以外的尺寸取最近一档并报错                   |

子智能体头像从 1254px 的整张素材里裁出，裁剪和缩放用一次 `createImageBitmap` 完成，画进尺寸正好是「显示尺寸 × 设备像素比」的 canvas；页面上不保留整张素材，同一头像同一尺寸只解码一次。

## 列表与表面

| 组件               | 用途与变体                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ListRow            | 列表行，高 32 / 40 / 52。插槽 leading、标题、subtitle、meta、trailing；`selected`、`nested`（缩进一级）、`danger`、`disabled`。trailing 的操作只在悬停或键盘聚焦时出现；上下方向键、Home / End 在同一列表内移动，Enter / Space 选择 |
| List / ListSection | List 是 listbox，行是 option；ListSection 是带 12/500 三级文字标题的分组，组内行之间画左缩进 16 的 0.5px 细线（选中行两侧不画）。列表不再套卡片                                                                                     |
| Surface            | 面板级容器：raised（默认，比面板高一级 + 细线）/ sunken（代码、凹陷区）/ overlay（浮层 + 层级阴影）；`pad` none / sm 12 / md 16；`radius` md 12 / lg 16；`interactive` 加悬停与焦点（配 `as="button"`）                             |
| EmptyState         | block（20px 图标 + 标题 + 描述 + 按钮，居中）/ inline（单行，可带一个尾部操作）；`framed` 画虚线框，放在卡片里时自动去掉                                                                                                            |
| Notice             | 提示条：左侧图标 + 标题 + 说明 + 可选操作；tone 与 Badge 相同，warn / error 以 role=alert 播报。只在问题存在时出现                                                                                                                  |
| PaneHeader         | 面板顶栏，固定 48px：标题 + 可选 Tabs + 右侧操作；长标题截断，高度不随内容变化                                                                                                                                                      |

## 输入

| 组件        | 用途与变体                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| TextField   | 单行输入：高 32（sm 28）、圆角 `--r-sm`、字段底色上一条细线；聚焦画 `--focus-ring`，出错画错误色细线    |
| TextArea    | 多行输入，外观同 TextField，随内容在 `minRows` 与 `maxRows` 之间增高                                    |
| SearchField | 唯一的搜索框：前置搜索图标，有内容时出现清除按钮；Esc 清空并停在这里，框为空时 Esc 交给外层（关闭弹层） |
| Select      | 选择按钮，展开 Menu；外观同 TextField                                                                   |
| Segmented   | 少量互斥选项，外观是分段 Tabs，语义是单选组                                                             |
| Switch      | 开关；打开时用金色（金色允许出现的少数位置之一）                                                        |
| Checkbox    | 16px 方框：未选 / 选中 / 部分选中（`indeterminate`），点部分选中的框会变成选中                          |
| Field       | 标签 + 控件 + 提示 / 错误，自动接好 id、aria-describedby 与 aria-invalid                                |

## 页签

Tabs 一个组件三种外观：underline（页面与面板视图，选中项是一级文字 + 500 字重 + 2px 横线，不用金色）、segmented（筛选，可带数字）、editor（文件与终端，`closable` 的页签有 × 按钮，Delete 关闭）。左右方向键、Home / End 移动并选中，跳过停用的页签。

## 反例

- 不要手写 `.count`、`.tag`、`.dot`、`.empty` 和提示条：用 Badge、Dot、EmptyState、Notice。
- 不要用裸 `<input>`、`<input type="checkbox">` 和自绘搜索框：用 TextField、Checkbox、SearchField。
- 不要给徽章、图表和装饰用金色；状态只用状态色。
- 不要在卡片里再套卡片：分组用 ListSection，容器用 Surface。
