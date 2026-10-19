# 颜色使用规范

> 文档状态：Active<br>
> 面向读者：设计者、前端开发者<br>
> 最后核验：2026-10-19<br>
> 事实源：`desktop/src/renderer/src/theme/semantic.dark.css`、`semantic.light.css`、[设计令牌](tokens.md)

方向是高级、简约、克制：界面以暖中性灰为主，层级靠表面明度和 0.5px 细线区分，不靠大面积色块。Emperor 金保留，但只出现在少数关键位置。

## 金色（`--accent`、`--text-link`、`--focus-ring`）只用于

- 发送按钮，以及每屏唯一的主按钮；
- 选中的开关；
- 链接与行内引用；
- 焦点环；
- 品牌标；
- 唯一的「运行中」指示。

不用金色的地方：tab 选中改用 `--text-1` 加 500 字重；侧栏选中行用 `--surface-selected`；审批卡和计划卡用 `--attention`（橙），不用金色；徽章、图表和装饰不用金色。

## 状态色

`--ok`、`--warn`、`--error`、`--attention`、`--info` 只表达状态，配套的 `*-soft` 用作底色。状态色不做装饰，也不用于普通按钮。

## 用户气泡

用户消息气泡用 `--bubble-user`：深色主题是暖深灰，浅色主题是暖米色，都不是金色。
