# 外壳布局

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-22（对照 `94d6a737`）<br>
> 事实源：`desktop/src/renderer/src/components/shell/`（`AppFrame.vue`、`columns.ts`、`frameState.ts`）、`desktop/src/renderer/src/components/sidebar/`（`SidebarRoot.vue`、`SidebarTopRow.vue`、`SidebarBrandRow.vue`、`SidebarNav.vue`、`SessionRow.vue`、`SidebarProjectRow.vue`、`SidebarSectionHeader.vue`、`SidebarSearchResults.vue`、`useContentSearch.ts`、`SidebarFooter.vue`、`SidebarRail.vue`、`sidebarNav.ts`）、`desktop/src/renderer/src/runtime/sidebarModel.ts`、`desktop/src/renderer/src/theme/components.css`、`desktop/src/renderer/src/components/settings/`（`SettingsModal.vue`、`SettingsNav.vue`、`settingsSections.ts`、`ui/`）、`components/conversation/`（`ConversationView.vue`、`ChatTimeline.vue`、`environment/EnvironmentCard.vue`、`environment/EnvironmentRow.vue`、`computer-use/ComputerUsePreviewStack.vue`）、`components/composer/ComposerCard.vue`、`components/pages/PageShell.vue`、`components/ui/`（`Modal.vue`、`PaneHeader.vue`）、`components/workspace/WorkspacePanel.vue`、`components/workspace/SourcesView.vue`；测试 `SidebarRoot.integration.test.ts`、`SessionRow.test.ts`、`sidebarDayGroups.test.ts`、`desktop/tests/visual/sidebar.spec.ts`、`desktop/tests/visual/settings-groups.spec.ts`、`desktop/tests/visual/environment.spec.ts`

主窗口用系统标题栏，下面是平铺的几栏：侧栏、中栏（对话、轨迹或整页）、右侧工作台。侧栏画在 `--surface-canvas` 上，中栏与工作台在 `--surface-base` 上，栏与栏之间只有一条 0.5px 发丝线（`--border-l1`）。布局与入口位置是 Emperor 自己的；质感参考了 Codex（颜色、字体、间距、圆角、阴影），布局不照搬（2026-10-20 决定）。

## 结构

从左到右：

| 区域   | 宽度                                     | 底色               | 说明                                                     |
| ------ | ---------------------------------------- | ------------------ | -------------------------------------------------------- |
| 侧栏   | 默认 280，可拖 264–420；收起为 56 的窄轨 | `--surface-canvas` | 顶行、品牌行、新对话与页面入口、置顶 / 项目 / 对话、底部 |
| 中栏   | 余下宽度；下限对话 480、轨迹 640         | `--surface-base`   | 对话、轨迹或整页                                         |
| 工作台 | 默认 560，可拖 360–960；关闭为 0         | `--surface-base`   | 审查 / 终端 / 文件 / 浏览器                              |

- 没有圆角面板和外围留边；层级靠底色明度与发丝线区分。卡片、代码块等在 `--surface-base` 上再抬一级。
- 会话头第一行高 46（`--shell-bar-h`），工作台 `PaneHeader` 高 48、上移 2px，两者底边对齐。工作台顶栏左侧是四个面板的 segmented 切换，右侧是关闭；打开时回到上次用的面板，还没选过面板时显示四个面板的入口，没有「首页」（UI-S06）。环境信息卡的「查看全部」打开的「来源」是盖在面板上的临时视图（UI-S13）：没有自己的页签，打开时切换器不选中任何一项，也不记为上次用的面板；返回、选一个面板、在工作台打开别的内容、关闭工作台或换会话都会关掉它，原来的面板（审查与文件的状态）原样留在下面。
- 整页（定时任务、能力、GitHub）没有会话头，标题在页面内容里（PageShell）：内容宽 880、居中，标题 20/600，页签在标题下。Pull Request 是唯一占满宽度的页面，但它的标题行和页签仍在同一个 880 列、同一高度，所以 GitHub 的 PR / Issue / CI 三个标签切换时标题不动。

## 侧栏

从上到下（`data-sidebar-block`：`top` → `brand` → `new` → `pages` → `sections` → `footer`）：

1. **顶行**（`SidebarTopRow`）：收起、后退、前进（`shell/navHistory`，各自在历史尽头禁用）。
2. **品牌行**（`SidebarBrandRow`）：Emperor 标与名称；右侧搜索、通知铃铛。
3. **新对话**（`SidebarNav`）：侧栏里唯一抬起的对象——高 36、`--surface-raised` 底、`--elev-1`（悬停 `--elev-2`）、圆角 `--r-md`、13/500；悬停时右侧显示 ⌘N。旁边的 `+` 在项目中新建会话。
4. **页面入口**：Pull Request（只在 GitHub 插件启用时出现，`visibleSidebarPages`）、定时任务、能力。比会话低一级：文字二级色、图标三级色；当前页 `--surface-selected` + 主文字 + 500。原「探索」是能力页顶部的「推荐」。
5. **会话**：置顶（总在最上方）、项目、对话（`data-sidebar-section`）。
6. **底部**（`SidebarFooter`）：「设置」在左，明暗切换在右。

节奏：

- 所有行 32 高、圆角 8（`--radius-row`）；分组标题 28 高，13/20、500、三级文字，吸顶；标题右侧的 `+`、`⋯` 只在悬停、焦点在标题内或菜单打开时出现。
- 区块之间靠 12px 留白分开，不画分隔线。
- 项目行：文件夹图标、名称、会话数（说明文字色、等宽数字，悬停时换成「新建该项目会话」）。项目内的会话缩进一级，左侧一条引导线落在文件夹图标中线上。
- 会话行（`SessionRow`）：16px 状态槽——运行中金色呼吸点（Dot `running`），等待回答或审批 `--attention` 点，有新进展 `ok` 点；标题 14/20；右侧紧凑相对时间（`sidebarRelativeTime`：刚刚 / N 分钟 / N 小时（今天）/ 昨天 / N 天（一周内）/ 9月10日（今年）/ 2025/12/31（更早），说明文字色、等宽数字、不加中英文间距），悬停时换成「⋯」。选中 `--surface-selected`、标题 500。行带 `data-session-id`。
- 对话按 `updated_at` 分「今天 / 昨天 / 7 天内 / 30 天内 / 更早」；手动排序时不分组。
- 焦点在会话行上时，↑ / ↓ 把焦点移到相邻的行并打开那个会话。

搜索：

- 品牌行的放大镜（或 ⌘K）在页面入口下方展开搜索框，结果替换会话列表（`SidebarSearchResults`）。
- 先列「会话」：标题、项目名、路径即时匹配（`searchSidebarSessions`，不含已归档）；停顿 250ms 后列「内容」：Core `sessions.search` 找到的、聊天内容里提到这段文字的会话（只搜用户消息和模型回答），每条带命中的句子（`useContentSearch`，旧查询的结果丢弃）。
- ↑ / ↓ 选择、回车打开；Esc 先清空，再关闭。

## 内容宽度

内容列都在组件里设置宽度上限、在栏里居中；L1 的 `--content-chat` / `--content-page` / `--content-form` 目前没有组件使用。

| 内容                       | 宽度                                                                                                                                                      | 实现                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 对话的消息列               | 最宽 748（`--chat-content-width`），列外左右留 32、底部留 56                                                                                              | `ConversationView`、`ChatTimeline`                                 |
| 输入框卡片                 | 最宽 780（`--composer-card-max` = 748 + 32），比消息列宽 32；改动、子智能体状态条、待办、目标、队列几条 dock 在卡片内缩                                   | `ComposerCard`、`QueueDock`、`SubagentDock`、`TodoDock`、`GoalBar` |
| 接管卡（审批、提问、计划） | 与消息列同宽 748；收起后的一行 780                                                                                                                        | `ApprovalPanel`、`PlanReviewPanel`、`TakeoverSeat`                 |
| 用户气泡                   | 最宽为消息列的 80%                                                                                                                                        | `UserBubble`                                                       |
| 整页                       | 880 加左右各 24 的内边距，居中；Pull Request 的列表与详情占满宽度，标题行仍在 880 列里；PR 详情最宽 960                                                   | `PageShell`、`PullRequestDetail`                                   |
| 设置面板的选项区           | 最宽 720                                                                                                                                                  | `SettingsModal`                                                    |
| 对话框                     | 默认 380；按内容取 400–880（确认框 400，导入与密钥类 440–480，导出与诊断 520，MCP 与 Skill 导入 560，定时任务 600，添加模型 760），窄窗口里不超过可用宽度 | `Modal` 的 `width`                                                 |

## 环境信息卡

- 对话区和卡片是同一个区域（UI-S16）：消息区的滚动容器铺满对话栏，滚动条在最右边（卡片下面）；卡片浮在对话栏右上角（距顶 12、距右 16），不随对话滚动，不占一列。宽 340（`--env-card-width` = `min(340px, 100cqi − 32px)`，对话栏放不下时为栏宽减 32），圆角 `--r-lg`。最大高度到输入框一组（改动药丸、各条 dock、输入框）上方 16 为止，有电脑操作预览时到预览上方 12 为止；内容多时卡片内部滚动，永远不盖输入框。
- 消息列（748）和输入框在整个对话栏里居中。居中会撞上卡片（列的右边缘离卡片不到 16）时，二者一起左移到刚好让开，左边至少留 32：对话栏 ≥ 1152（748 + 340 + 2 × 32）时可以做到，左移量 = 列宽 / 2 + 卡片宽 + 32 − 栏宽 / 2（小于 0 时不移）。实现是纯 CSS：`@container conversation (min-width: 1152px)` 里算出 `--chat-shift`，滚动容器和输入框座位的右内边距各加两倍左移量，列宽不变，「回到底部」、子智能体状态条、改动药丸、待办、目标、队列和接管卡都跟着走；左侧的轮次刻度不动。
- 对话栏窄于 1152 时，正文与输入框保持居中，卡片浮在对话上面，阴影换成 `--elev-3`（`.conversation-root[data-env-overlay]`）。右侧工作台打开时按变窄后的对话栏计算。
- 对话栏 ≥ 1152 时卡片默认显示；更窄时默认收起，用会话头的按钮打开。用户在宽栏里关掉、或在窄栏里打开，都记为手动选择（`frameState.ts`）。电脑操作预览在右下角，同样从 1152 起放在旁边（正文同样让开它），更窄时折成一个计数标签。
- 每一项是一行 32 的 `EnvironmentRow`，分节之间 12、不画线。一行放不下时（UI-S14）：「子智能体」「后台任务」这类行名保持完整，值截断成省略号、指针停留时显示全部；分支名、计划标题和来源名是数据，截断的是它们，值保持完整。子智能体一行的值在有运行或等待回答的子智能体时不计已完成的。「来源」是一个小节（UI-S13）：12/18 的小标题「来源」和右侧的总数，下面最多 3 行（你提供的 → 已查看 → 搜索命中，名字放不下时截断），超过 3 个时多一行「查看全部 N 个 ›」；没有「输出」一行。

## 顶栏对齐

- 会话头第一行 46（`--shell-bar-h`），工作台顶栏是 48 的 `PaneHeader`，向上收 2px（`margin-top: calc(var(--shell-bar-h) - var(--pane-header-h))`），两条底边落在同一条线上。
- 侧栏顶行 36、品牌行 40；整页没有固定高度的顶栏，标题行高 28、上方留 32。
- 设置面板的顶栏 54；面板窄于 640 时高度随内容。

## 收起与断点

- 收起后侧栏列宽 56，渲染窄轨（`SidebarRail`）：品牌标（悬停换成展开图标）、后退 / 前进、新对话、搜索、通知、页面入口，底部设置与明暗切换；按钮 36、图标 20、提示在右侧。点品牌标或 ⌘B 展开。
- 视口宽度小于 1024px 时侧栏自动收起为窄轨。
- 断点主要是容器查询，按所在栏或卡片的宽度变化，不按窗口宽度：设置面板与整页窄于 640 时导航折成顶部一行、边距收紧；轨迹窄于 640 时检查器盖在列表上；PR 详情窄于 560 时标题行堆叠；对话栏窄于 560 时隐藏轮次刻度条；对话栏从 1152 起消息列给环境信息卡和电脑操作预览让位，更窄时卡片盖在对话上（见[环境信息卡](#环境信息卡)）；设置行、表单与用量卡片在 520 / 480 / 440 处减列。按窗口宽度的媒体查询只有几处：输入框面板（820）、首启引导（760）、提问与计划卡（720）、看图器（600）。Pull Request 页窄于 720 时只显示列表或详情之一。
- 空间不够时，工作台先缩到 360，再自动关闭；只改渲染宽度，不改用户保存的宽度（`columns.ts` 的让位链）。
- 列宽变化不做过渡动画：拖动时宽度逐帧跟随，收起和展开立即生效。

## 设置面板

- 尺寸 880 × min(720, 100vh − 80)，圆角 r-xl（24），lv3 阴影，遮罩模糊。左侧导航 200px，底色 `--surface-canvas`；右侧页面底色 `--surface-base`，页面标题 16/600，顶栏 54px。
- 导航四组九项：「常规」单独一组，然后「智能」（模型、子智能体、记忆）、「操控」（电脑操作、浏览器、语音）、「系统」（用量、高级），组标签 12/500 三级文字。导航项是 32px 的纯文字行，选中用 `--surface-selected`。面板窄于 640px 时导航折成顶部一行，组标签隐藏。
- 每页只有一种排法：分组标签 + 一张卡片 + 行（`SettingsGroup` + `SettingsRow`）。卡片里不再放卡片，列表自带外框时分组用 `plain`。打开二级页的行是 `SettingsLinkRow`（整行可点，末尾箭头）；列表行只留一个主操作按钮，其余（包括删除）放进行尾的「⋯」（`SettingsRowMenu`）。
- 不常用的内容放二级页（`?settings=<分区>&page=<页面>`，标题「分区 › 页面」）：常规 › 已归档对话、记忆 › 历史 / 情景记忆 / Watchlist、用量 › 详细、高级 › Hooks / 诊断。
- 会自己刷新的分区（记忆、电脑操作；能力 › 插件）不放刷新按钮。编辑类页面接入未保存守卫（[浮层规范](overlays.md#模态弹窗)）。
