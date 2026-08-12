# 可选能力生命周期

> 文档状态：Active<br>
> 面向读者：维护者、开发者<br>
> 最后核验：2026-08-12<br>
> 事实源：`packages/core/src/capabilities/portfolio.ts`、Core diagnostics、各能力 gate 与评估脚本

默认关闭不等于无人负责。每一项长期保留的可选能力都必须登记唯一 owner、默认状态、真实用户入口、数据权威、评估命令、维护预算、下次复审日期和可执行的退役条件。Core diagnostics 的 `optionalCapabilities` 返回这份脱敏登记；它不包含本机路径、凭据或评估原始输出。

## 当前组合

| 能力                | 状态与默认值                             | 用户入口                                                                             | 数据权威                                                                     |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `code_intelligence` | evaluation-gated；默认 `off`             | 只有 host 注入与 parser revision 绑定的通过 receipt 后，才在 Build 注册工具          | 图和 LSP cache 是派生数据，workspace 源文件是权威                            |
| `hybrid_memory`     | evaluation-gated；默认 `off`             | 本地配置可请求 `eval/on`，只有通过与 embedding provider 绑定的 receipt 才改变 prompt | 检索 index 是派生数据，memory Markdown 与 session record 是权威              |
| `soft_git_rewind`   | evaluation-gated；默认 `off`             | 显式请求 `on` 且 platform/Git receipt 匹配后，文件 checkpoint UI 才显示 Git 回退     | recovery transaction/rescue ref 用于恢复，Git 与文件 checkpoint 保持各自权威 |
| `watchlist`         | active；默认可用但没有活动项时保持 inert | Memory 面板、手动检查与 Scheduler system job                                         | `memory/watchlist.md` 是用户权威，state 文件只保存最近一次派生 decision      |

## 复审规则

- Gate 型能力没有匹配 receipt 时必须降级为 `off/eval`，项目文件、renderer 或模型参数不能自行开启。
- 评估 receipt 只证明其声明的 dataset、provider/parser 或 platform/version；不能跨边界复用。
- 复审必须同时查看产品入口是否真实存在、维护测试是否仍覆盖失败/恢复语义，以及预算是否仍被接受。
- 达到登记的退役条件时，应删除入口、派生数据 reader 和文档；不能只隐藏 UI 后永久保留无人维护的实现。
- 新增可选能力时，先在 portfolio 注册并让 diagnostics 可见，再接用户入口。没有 owner 或复审条件的能力不得合入。
