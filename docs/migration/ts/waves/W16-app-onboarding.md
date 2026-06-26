# W16 · Onboarding / 诊断 / 桌宠（入 GUI）（APP）

依赖：W15、W03　|　子系统映射：`agent/cli.py`、`agent/onboarding.py`、`agent/local_config.py`(UI)、`agent/desktop_pet/*`。
**纯桌面**：终端 CLI/TUI 入口退役，其功能并入桌面应用 GUI。

### MIG-APP-001 · 首启向导入 GUI

- **功能点**：把 `init` 向导（模型/运行时配置）做成 GUI 首启流程。
- **源(Python)**：`agent/onboarding.py`（`run_onboarding`、`WizardModelSettings`/`WizardRuntimeSettings`、`build_model_config`）。
- **目标(TS)**：`apps/desktop` 首启向导组件 + 调 `CoreApi.model.save(...)`。
- **依赖**：MIG-CFG-002,003、MIG-IPC-001
- **设计**：Rich/Questionary CLI 向导→Vue 向导页；`build_model_config` 逻辑入 core；release 不带 key，首启必填一次。
- **风险/复杂度**：M。
- **验证**：移植 `build_model_config` 单测；手动首启走查。**验收**：首启可配出可用 model_config。
- **状态**：todo · PR: —

### MIG-APP-002 · doctor / 诊断入应用内

- **功能点**：把 `doctor` 检查与 `/api/diagnostics` 聚合做成应用内诊断面板。
- **源(Python)**：`agent/onboarding.py`（`DoctorCheck`）、`agent/web/services/diagnostics_service.py`、`agent/local_config.py:local_config_diagnostics`。
- **目标(TS)**：`packages/core/src/api/diagnostics.ts` + 桌面诊断面板。
- **依赖**：MIG-IPC-001、MIG-CFG-001
- **设计**：覆盖 model config/local config/scheduler store/runtime store/external/desktop pet/依赖提示；corrupt 备份可见。
- **风险/复杂度**：S。
- **验证**：移植 diagnostics 单测。**验收**：诊断项齐全、corrupt 可见。
- **状态**：todo · PR: —

### MIG-APP-003 · 桌宠进程管理

- **功能点**：可选 Electron 桌宠 companion（默认关闭）。
- **源(Python)**：`agent/desktop_pet/*`（进程管理、pid/state、偏好）。
- **目标(TS)**：`apps/desktop/src/main/pet.ts`（沿用现有 `--pet-window` 机制）。
- **依赖**：MIG-CFG-001、MIG-IPC-001
- **设计**：默认关闭，缺依赖只提示不影响主服务；偏好读写经 local_config。
- **风险/复杂度**：S。
- **验证**：移植 `test_desktop_pet*.py` 思路。**验收**：开关/进程管理一致。
- **状态**：todo · PR: —

### MIG-APP-004 · 主进程托管核心（去掉 spawn 后端）

- **功能点**：Electron 主进程进程内初始化 TS 核心，删除「spawn Python 后端 + 健康等待」。
- **源(Python/前端)**：现 `desktop/src/main/index.ts`（`spawnBackend`/`waitForBackend`/`probeBackend`/`reclaimBackend`/bundled backend）。
- **目标(TS)**：`apps/desktop/src/main/index.ts` 改为 `const core = new AgentLoop(...)` 进程内实例化。
- **依赖**：MIG-CORE-011、MIG-IPC-002
- **设计**：删除子进程拉起/端口探活/PyInstaller 捆绑；窗口 ready 即核心 ready。**这是「双击即用、无需后端启动」的落点。**
- **风险/复杂度**：M。
- **验证**：手动：干净机器双击启动直接可用、无子进程、无监听端口。**验收**：无 Python、无 server、即开即用。
- **状态**：todo · PR: —

### MIG-APP-005 · 退役 Python CLI 入口

- **功能点**：移除 `agent.py`/`agent/cli.py`/`webui.py` 终端入口。
- **源(Python)**：`agent.py`、`agent/cli.py`（`main`/`build_parser`/`run_dev_check`）、`webui.py`。
- **目标(TS)**：无（删除）；开发期质量检查 `run_dev_check` 用 `pnpm` 脚本替代。
- **依赖**：MIG-APP-004
- **设计**：确认无任何运行路径依赖 CLI；文档更新。
- **风险/复杂度**：S。
- **验证**：审查：无 CLI 引用。**验收**：仓库无 Python 入口。
- **状态**：todo · PR: —
