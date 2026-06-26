# W17 · 打包 / 发布 / 对账（REL）

依赖：全部　|　子系统映射：发布与切换收尾（无单一 Python 源；退役 Python）。

### MIG-REL-001 · electron-builder 打包（内嵌进程内核心）

- **功能点**：出 dmg/exe/AppImage，核心进程内、无 Python、无 server。
- **源(Python)**：现 `desktop/` 打包脚手架（去掉 bundled backend / PyInstaller）。
- **目标(TS)**：`apps/desktop` electron-builder 配置。
- **依赖**：MIG-APP-004
- **设计**：单一 Electron 包内含 `core`（编译进主进程 bundle）；三平台安装包。
- **风险/复杂度**：M。
- **验证**：三平台构建产物可双击启动。**验收**：干净机器即开即用。
- **状态**：todo · PR: —

### MIG-REL-002 · CI 矩阵

- **功能点**：lint + vitest + build + package 的多平台 CI。
- **源(Python)**：现 `.github/workflows/ci.yml`（pytest+vitest+ruff）→ 改为 TS 全栈。
- **目标(TS)**：更新 `.github/workflows/*`。
- **依赖**：MIG-REL-001
- **设计**：`pnpm -r build`、`pnpm -r test`(vitest)、`tsc --noEmit`、electron-builder 干跑；按 tag 发布产物。
- **风险/复杂度**：S。
- **验证**：CI 在 PR 上跑全绿、tag 出产物。**验收**：红线阻断、产物可下。
- **状态**：todo · PR: —

### MIG-REL-003 · 数据兼容验证

- **功能点**：用 Python 版产生的真实 `memory/`、`model_config.json`、`mcp_config.json`、`.team/` 启动 TS 版，零迁移可读。
- **源(Python)**：现有用户数据布局。
- **目标(TS)**：兼容性测试夹具 + 启动验证。
- **依赖**：全部 store 波次（FND/MEM/SESS/SCHED/TEAM/EXT/RTE）
- **设计**：把一份真实 Python 数据快照作为 fixture，TS 版加载断言无丢失/无 corrupt 误判。
- **风险/复杂度**：M。
- **验证**：自动化兼容性测试。**验收**：老数据被 TS 版正确读出。
- **状态**：todo · PR: —

### MIG-REL-004 · 全量 parity 签收

- **功能点**：487 个 Python 测试 → vitest 的逐条对账清单全绿。
- **源(Python)**：`tests/`（487 测试）。
- **目标(TS)**：各 `packages/core/**/*.test.ts`。
- **依赖**：全部波次
- **设计**：维护一张「Python 测试 → vitest 用例」映射表（可放 STATUS.md 或单独 PARITY.md），逐条标记已移植/通过；行为差异零容忍（容差项仅 tokenizer/PDF，显式标注）。
- **风险/复杂度**：L（量大）。
- **验证**：映射表 100% 覆盖且对应 vitest 全绿。**验收**：无未对账的 Python 测试。
- **状态**：todo · PR: —

### MIG-REL-005 · 退役 Python

- **功能点**：删除 `agent/`、`tests/`(py)、`requirements*.txt`、`pyproject.toml` 等，更新文档。
- **源(Python)**：整个 Python 后端。
- **目标(TS)**：仅留 monorepo TS。
- **依赖**：MIG-REL-003,004
- **设计**：parity 签收通过后整体删除；更新 `README.md`、`AGENTS.md`（或新建 TS 版协作指南）、`PROJECT_AUDIT_REPORT.md` 收尾。
- **风险/复杂度**：M（不可逆，须在 parity 通过后）。
- **验证**：仓库无 `.py`（除历史归档）；TS 版功能走查通过。**验收**：纯 TS 桌面 agent 上线，Python 退役。
- **状态**：todo · PR: —
