# 动效

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者、维护者<br>
> 最后核验：2026-10-21<br>
> 事实源：`desktop/src/renderer/src/theme/primitives.css`（`--motion-*`、`--duration-*`、`--ease-*`）、`styles/dsh/animations.css`、`styles/a11y.css`、`components/motion/`（`AppTransition.vue`、`CollapseTransition.vue`）、`composables/useSpring.ts`、`composables/useResizable.ts`、`composables/useReducedMotion.ts`、`composables/useStreamingText.ts`、`components/ui/`（`Spinner.vue`、`Dot.vue`、`Skeleton.vue`、`Shimmer.vue`、`useTooltip.ts`、`ImageLightbox.vue`）、`components/conversation/ChatTimeline.vue`、`components/shell/AppFrame.vue`；测试 `style-audit.test.ts`、`styleAuditRules.ts`、`CollapseTransition.test.ts`、`desktop/tests/visual/baseline-stability.spec.ts`

动效只用来说明变化：东西从哪里来、展开到哪里、什么还在运行。它要短、可以被打断、不挡操作；关掉系统的动态效果之后，界面照样完整可用。

## 原则

- **只动 transform、opacity 和颜色。** 宽度、高度、grid 轨道、内外边距、位置不做 CSS 过渡（样式审计两条规则：「no layout-property transitions」与 ratchet 规则 `layout-transition`，后者必须为 0）。唯一的例外是会话流的折叠（见下文），那里有意让高度参与动画，因为下面的行要跟着移动。
- **列宽不动画。** 拖动侧栏或工作台时宽度逐帧跟随指针，收起、展开、自动让位都立即生效（`AppFrame.vue`，不经过弹簧）。
- **进场有动效，退场直接消失。** 菜单、弹层、弹窗、提示、轻提示进场时淡入，关闭时立即移除；只有会话里的接管卡（审批、授权、提问、计划）有对称的进出场。
- **「运行中」的金色指示每屏只放一个**（规则见[颜色使用规范](color.md)，代码不强制）：侧栏是运行中的金色圆点，会话里是轮次状态的金色 shimmer；过程行、工具行的持续动效用中性色。
- **减少动态效果统一在 `styles/a11y.css` 处理**，组件里不写 `prefers-reduced-motion` 媒体查询（样式审计「no scattered prefers-reduced-motion blocks」）。需要在脚本里判断时用 `useReducedMotion()` 或 `prefersReducedMotion()`。

## 时长与缓动

| 令牌              | 值                           | 用在哪                                                                                                            |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--motion-fast`   | 120ms                        | 悬停与按下的颜色变化、焦点环、展开箭头的旋转、悬停才出现的操作（Button、IconButton、Tag、Tabs、ListRow、Select…） |
| `--motion-base`   | 200ms                        | 浮层淡入（`ds-fade-in`）、轻提示上浮（`ds-rise-in`）、开关圆钮、页签下划线、侧栏导航的高亮                        |
| `--motion-slow`   | 320ms                        | 少数慢速变化：工作台拖动柄的显隐、模型行的底色                                                                    |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 默认缓动：起步快、收尾缓                                                                                          |
| `--ease-exit`     | `cubic-bezier(0.4, 0, 1, 1)` | 退场用；目前没有组件使用                                                                                          |

旧刻度仍在 L1：`--duration-instant` 80ms（消息下方悬停才出现的操作）、`--duration-fast` 140ms（轨迹视图、重试与备用模型行、资源卡、电脑操作指针）、`--duration` 220ms（表单控件默认样式的颜色过渡）、`--duration-slow` 340ms（电脑操作指针的淡出）；`--ease-out` `cubic-bezier(0.22, 1, 0.36, 1)` 用于轨迹时间线与电脑操作指针，`--ease-spring`、`--ease-in` 没有使用者。新样式只用 `--motion-*` 与 `--ease-standard`。

写法：

```css
.row {
  transition: background-color var(--motion-fast) var(--ease-standard);
}
```

时长和缓动不写裸值。现在仍有几处例外，不要照抄：约 30 处在时长令牌后面跟了 CSS 关键字 `ease`；看图器（160ms 进场、按钮 120ms）、菜单面板与活动视图的 120ms、以及下表里的持续动画周期是写死的；`AppTransition` 与 `CollapseTransition` 在脚本里写了与 `--ease-out`/`--ease-in`、`--motion-base`/`--ease-standard` 相同的数值。

## 进场

| 对象                                       | 动效                                                                           | 实现                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------- |
| 菜单、弹层、弹窗、设置面板、时间轴浮层     | 透明度从 0 淡入，200ms                                                         | 全局类 `.ds-fade-in`（`animations.css`）     |
| 轻提示                                     | 从下方 6px 上浮并淡入，200ms                                                   | `ds-rise-in`                                 |
| 提示气泡                                   | 悬停或聚焦 400ms 后出现并淡入；指针离开、失焦或按下时立即消失                  | `useTooltip`（Tooltip 与 IconButton 共用）   |
| 看图器                                     | 160ms 淡入                                                                     | `ImageLightbox`                              |
| 会话接管卡（审批、授权、提问、计划）       | `materialize`：从 0.97 倍、8px 模糊淡入，以卡片底边中点为原点；退场反向；240ms | `AppTransition`（唯一使用者 `TakeoverSeat`） |
| 侧栏会话行（每次挂载，包括滚动与分组切换） | 淡入，200ms                                                                    | `SessionRow`                                 |

`AppTransition` 还有 `fade`、`scale`、`slide-up` 三种预设，目前没有使用者。弹窗遮罩没有动画，跟弹窗同时出现。

## 展开与收起

- 会话流的过程组、工具行、思考行用同一个过渡 `CollapseTransition`：高度从 0 到内容高度、透明度从 0 到 1 一起变化，200ms，`--ease-standard`。过渡期间裁掉溢出；如果 `transitionend` 没来（内容没变、窗口在后台），280ms 后照样结束。
- 展开箭头旋转 90° 或 180°，`--motion-fast`。
- 其他折叠（设置卡片、目标栏、待办栏等）只旋转箭头，内容直接出现。

## 持续动效（运行中、加载中）

| 指示          | 动效                                                                                     | 周期      | 使用者                                                             |
| ------------- | ---------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| Spinner       | 1.5px 圆环旋转                                                                           | 0.8s 线性 | 按钮的 `loading`、过程行、输入框、工作台、导出与刷新对话框         |
| Dot `running` | 金色圆点外扩一圈 6px 光环并淡出                                                          | 1.6s      | 侧栏的运行中会话；终端、后台任务、MCP 服务等的状态点在运行时也是它 |
| 文字 shimmer  | 一道亮带掠过文字：金色（`--accent` → `--accent-glare`）或中性（`--text-3` → `--text-1`） | 1.8s 线性 | 轮次状态（金色）；过程行、工具行、压缩与重试行（中性）             |
| 扫光          | 300px 宽的亮带从行左侧扫到右侧，最后 10% 停顿                                            | 2.6s      | 运行中的 `DisclosureRow`（工具、思考、Hook 行）                    |
| Skeleton      | 透明度在 1 与 0.55 之间起伏                                                              | 1.6s      | 组件已提供，目前没有页面使用                                       |
| 会话加载占位  | 透明度在 0.45 与 1 之间往返                                                              | 1.4s      | `ConversationLoading`                                              |
| 浏览器加载条  | 40% 宽的金色条从左滑到右                                                                 | 1.1s      | 工作台浏览器加载中                                                 |
| 轨迹播放头    | 透明度起伏                                                                               | 1.2s      | 轨迹时间线，只在运行中显示                                         |

计时数字（`ElapsedClock`）每秒更新一次，是文字变化，不是动画。

## 拖动与弹簧

- `useSpring.ts` 提供三组弹簧参数：`gentle`（刚度 180、阻尼 26，默认）、`snappy`（260、30）、`bouncy`（220、18，有轻微回弹，只给甩动这类带速度的操作）。弹簧从当前值和当前速度接着走，中途改目标不会顿一下。
- 目前只有 `useResizable` 用到弹簧：松手时按速度推算落点，吸附到最近的吸附点（默认 24px 内），用 `snappy` 弹过去。只有文件面板的树宽有吸附点（240 / 280 / 320）；轨迹检查器和 Pull Request 列表的拖动柄没有吸附点，松手即停。
- 键盘也能调整这些宽度：方向键每次 10px，按住 Shift 40px，Home / End 到两端。外壳的侧栏和工作台拖动柄是另一套实现：每次 16px，Shift 40px。

## 滚动与流式输出

- 没有平滑滚动（不使用 `scroll-behavior: smooth`）。只有设置 › 诊断里跳到某一项时用一次平滑的 `scrollIntoView`。
- 会话跟随底部时直接把滚动位置设到最底，不做动画；离底部 25px 以内算「在底部」。用户向上滚动后停止跟随，出现「回到底部」按钮（没有动效）。
- 流式回答每 80ms 最多重绘一次正文（`useStreamingText`），输出结束立即显示全文。

## 主题切换

切换深浅主题只改 `<html data-theme>`，没有整页过渡。本身带颜色过渡的元素（悬停底色、表单控件）会跟着渐变到新颜色，其余立即换色。

## 减少动态效果

macOS 打开「减少动态效果」后（Chromium 的 `prefers-reduced-motion`）：

- `a11y.css` 把全部 `--motion-*`、`--duration-*` 降到 1ms；所有元素的 CSS 动画只播放一次、时长 1ms，过渡 1ms，滚动不平滑。持续动效因此停在一帧上。
- 扫光整个去掉；shimmer 文字变成静态的金色或二级文字色。
- Spinner 停止旋转；`CollapseTransition` 不做过渡，直接展开收起；弹簧直接跳到终点；`AppTransition` 退化为淡入淡出。
- 子智能体头像预览只换帧、不做交叉淡化。
- 录音波形只显示最新的音量；电脑操作预览里的指针不再滑动。

同一个文件还处理另外两个系统偏好：减少透明度（背景模糊归零、看图底色不透明）、增强对比度（加深 `--stroke-solid*`）。

## 像素基线里的动效

视觉测试里的关键截图逐像素比对（`npm --prefix desktop run visual:baselines`，见[开发指南](../development/README.md#质量门禁)）。截图时 CSS 动画与过渡停住、光标隐藏；带 `@baseline` 标签的测试里时钟从固定时刻开始、慢到整轮测试都停在同一毫秒，随机数用固定种子，所以计时、相对时间和运行中的指示每次都画成同一帧（`baseline-stability.spec.ts`）。新加持续动画时，确认它在 `animations: 'disabled'` 下停在一个确定的状态。
