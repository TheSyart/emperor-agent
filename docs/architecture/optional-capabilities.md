# 可选能力生命周期

> 文档状态：Active<br>
> 面向读者：维护者、开发者<br>
> 最后核验：2026-09-22<br>
> 事实源：`packages/core/src/capabilities/portfolio.ts`、Core diagnostics、`desktop/src/renderer/src/components/settings/MemorySection.vue`

默认关闭或低频使用不等于无人负责。每一项长期保留的可选能力都必须登记唯一 owner、默认状态、真实用户入口、数据权威、评估命令、维护预算、下次复审日期和可执行的退役条件。Core diagnostics 的 `optionalCapabilities` 返回这份脱敏登记。

## 当前组合

| 能力        | 状态与默认值                             | 用户入口                                                                 | 数据权威                                                                |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `watchlist` | active；默认可用但没有活动项时保持 inert | 设置 → 记忆的 Watchlist 标签（含「手动检查」）与 Scheduler 的 system job | `memory/watchlist.md` 是用户权威，state 文件只保存最近一次派生 decision |

## 复审规则

- 复审同时查看产品入口是否真实存在、维护测试是否仍覆盖失败与恢复语义，以及维护预算是否仍被接受。
- 达到登记的退役条件时，删除入口、代码和文档；不能只隐藏 UI 后永久保留无人维护的实现。
- 新增可选能力时，先在 portfolio 注册并让 diagnostics 可见，再接用户入口。没有 owner 或复审条件的能力不得合入。
