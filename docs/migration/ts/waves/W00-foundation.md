# W00 · 基础设施（FND）

依赖：—　|　子系统映射：跨子系统共用的存储/锁/事件/时间原语 + monorepo 骨架。
本波是所有后续波次的地基：把 Python 里反复出现的「原子 JSON 写 + 腐坏隔离 + filelock + JSONL append + 事件」抽成 TS 共用原语。

### MIG-FND-001 · monorepo / 工具链骨架

- **功能点**：建 pnpm workspaces，`packages/core` + `apps/desktop`，TS strict、vitest、electron-vite 接线占位。
- **源(Python)**：无（新建）；参照 `pyproject.toml`/`requirements*.txt`/现 `desktop/` 构建。
- **目标(TS)**：仓库根 `pnpm-workspace.yaml`、`packages/core/{package.json,tsconfig.json,vitest.config.ts}`、`apps/desktop`（现 `desktop/` 纳入 workspace）。
- **依赖**：—
- **设计**：core 为纯 TS 库（无 Electron 依赖），desktop 依赖 core。统一 tsconfig base + strict。vitest 在 core 内。electron-vite 沿用现有桌面构建，仅加 core 为本地依赖。
- **风险/复杂度**：S。
- **验证**：`pnpm -r build` 通过；core 空测试 `pnpm --filter core test` 绿。**验收**：两包可独立构建、core 可被 desktop import。
- **状态**：todo · PR: —

### MIG-FND-002 · 原子 JSON store + 腐坏隔离原语

- **功能点**：通用「读改写整份 JSON、tmp 写后 rename 原子替换、解析失败备份为 `*.corrupt-*` 并返回默认」。
- **源(Python)**：`agent/tasks/store.py`、`agent/scheduler/store.py`、`agent/runtime/store.py`、`agent/memory_versions.py`（`_atomic_write_text` + `except BaseException` cleanup+re-raise 模式）、`agent/local_config.py`(`_preserve_corrupt_local_config`)。
- **目标(TS)**：`packages/core/src/store/atomic-json.ts`：`readJson<T>(path, default)`, `writeJsonAtomic(path, data)`, `isolateCorrupt(path)`。
- **依赖**：MIG-FND-001
- **设计**：写：写 `*.tmp` → `fs.rename`（同目录，原子）；失败删 tmp 并抛。读：解析失败 → 复制为 `name.corrupt-<ts>` → 返回默认 → 把腐坏信息暴露给 diagnostics（回调）。**不变量**：终态写要么完整要么保留旧文件，绝不留半写。
- **风险/复杂度**：M（跨平台 rename 原子性、Windows 占用）。
- **验证**：移植各 store 的「corrupt 恢复 / 原子写」相关断言；新增 vitest：并发写、损坏文件隔离。**验收**：注入半写/损坏，数据不丢、corrupt 备份生成。
- **状态**：todo · PR: —

### MIG-FND-003 · 文件锁（filelock）

- **功能点**：跨写者串行化（scheduler action log / external store 合并）。
- **源(Python)**：`agent/scheduler/store.py`、`agent/external/store.py` 的 filelock 用法。
- **目标(TS)**：`packages/core/src/store/file-lock.ts`（封装 `proper-lockfile`）：`withLock(path, fn)`。
- **依赖**：MIG-FND-001
- **设计**：进程内+跨进程锁；超时与 stale 锁回收。**不变量**：合并坏行隔离到 `*.corrupt-*.jsonl`，合法继续合并（对齐 scheduler action log 语义）。
- **风险/复杂度**：S。
- **验证**：vitest：并发 withLock 串行化、stale 锁释放。**验收**：并发合并不丢、不串。
- **状态**：todo · PR: —

### MIG-FND-004 · id / 时间 工具

- **功能点**：`now_ts()`(秒/浮点)、`now_ms()`、`new_id(prefix)`(uuid hex 截断，如 `plan_`/`disc_`/`toolu_`)。
- **源(Python)**：`agent/control/models.py:now_ts`、`agent/scheduler/models.py`(`now_ms/new_job_id/validate_job_id`)、`agent/team/models.py`(`now_ts/new_id/validate_*`)、`agent/external/models.py:_new_id`。
- **目标(TS)**：`packages/core/src/util/ids.ts`、`util/time.ts`。
- **依赖**：MIG-FND-001
- **设计**：保持 id 前缀与长度（影响磁盘可读性，但非格式契约）；`validate_job_id`/`validate_member_name`/`validate_actor_name` 规则逐字保真。
- **风险/复杂度**：S。
- **验证**：移植各 `validate_*` 的断言。**验收**：非法 id/名被拒、合法通过。
- **状态**：todo · PR: —

### MIG-FND-005 · 类型化事件总线

- **功能点**：进程内事件发射/订阅，承载 runtime 事件流（替代 Python 的 emit 回调链）。
- **源(Python)**：`agent/runtime/events.py`(事件构造器)、runner/loop 的 `emit` 注入路径。
- **目标(TS)**：`packages/core/src/events/bus.ts`：`TypedEmitter<RuntimeEvent>`；`events/runtime-events.ts`（事件工厂，W14 填充具体事件）。
- **依赖**：MIG-FND-001
- **设计**：强类型事件联合；同步/异步订阅；W15 由 Electron 主进程把事件桥到渲染层 IPC。
- **风险/复杂度**：S。
- **验证**：vitest：发布/订阅/退订。**验收**：类型安全的事件流可用。
- **状态**：todo · PR: —

### MIG-FND-006 · 结构化日志

- **功能点**：替代 `loguru`，统一结构化日志 + 级别。
- **源(Python)**：全仓 `from loguru import logger` 用法。
- **目标(TS)**：`packages/core/src/util/log.ts`（封装 `pino` 或 `consola`）。
- **依赖**：MIG-FND-001
- **设计**：debug/info/warn/error；prompt-cache 等调试行保留。桌面侧落盘到 `logs/`。
- **风险/复杂度**：S。
- **验证**：vitest：级别过滤。**验收**：核心各模块统一 logger。
- **状态**：todo · PR: —

### MIG-FND-007 · JSONL append-only 日志 + 归档

- **功能点**：append-only `.jsonl` 读写 + 热/冷轮转归档（history、inbox、runtime events、action log 共用）。
- **源(Python)**：`agent/memory.py`(HistoryLog 热段/归档)、`agent/runtime/store.py`(events.jsonl + archive + index)、`agent/team/bus.py`(inbox jsonl)。
- **目标(TS)**：`packages/core/src/store/jsonl.ts`：`appendJsonl`, `readJsonl`, `rotateToArchive`。
- **依赖**：MIG-FND-002
- **设计**：逐行 JSON；坏行隔离；热段大小阈值轮转到 `archive/`，索引写 `index.json`。**磁盘兼容**：行 schema 与 Python 一致。
- **风险/复杂度**：M。
- **验证**：移植 history/runtime store 的轮转与坏行隔离断言。**验收**：读旧 jsonl 一致、轮转可回读。
- **状态**：todo · PR: —

### MIG-FND-008 · 错误与结果基类型

- **功能点**：领域错误（corrupt、parse、quality、evidence 等）与通用结果类型。
- **源(Python)**：各处 `class XxxError(ValueError/RuntimeError)`（`SchedulerStoreCorrupt`、`PlanQualityError`、`PlanEvidenceError`、`CompactionParseError` 等）。
- **目标(TS)**：`packages/core/src/errors.ts`。
- **依赖**：MIG-FND-001
- **设计**：错误层级对齐；可被 diagnostics/IPC 序列化为安全错误（不泄内部栈）。
- **风险/复杂度**：S。
- **验证**：vitest：错误类型可辨识。**验收**：各子系统复用统一错误基类。
- **状态**：todo · PR: —
