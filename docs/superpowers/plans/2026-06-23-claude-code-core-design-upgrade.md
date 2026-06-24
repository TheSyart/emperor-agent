# Claude Code Core Design Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 Emperor Agent 项目中产出一套 Claude Code 核心源码设计剖析文档，并附带可执行的史诗级升级路线。

**Architecture:** 采用“源码分层剖析 + 与 Emperor Agent 对照 + 升级 Epics”的文档结构。只产出研究与设计文档，不改动运行时代码，避免在没有完整升级评审前把 Claude Code 的复杂机制半成品移入 Python 主线。

**Tech Stack:** Markdown 文档、Python/TypeScript 源码静态阅读、`rg`/`find`/`sed` 只读分析、Emperor Agent 现有 `agent/*` 与 `desktop/*` 架构对照。

---

## File Structure

- Create `docs/claude-code-core-design/README.md`  
  总入口：阅读顺序、核心结论、Claude Code 与 Emperor Agent 的架构差异地图。
- Create `docs/claude-code-core-design/01-composition-root.md`  
  剖析启动装配、配置加载、模型/权限/MCP/插件/技能/遥测初始化边界，并对照 `agent/cli.py`、`agent/loop.py`、`agent/web/container.py`。
- Create `docs/claude-code-core-design/02-agent-execution-state-machine.md`  
  还原 `query()` 的任务执行流程：请求前上下文治理、模型流式、tool_use 收集、工具执行、follow-up、恢复/压缩/stop hooks、max turns。
- Create `docs/claude-code-core-design/03-tool-protocol-and-permissions.md`  
  对比 Claude Code `Tool` 对象协议与 Emperor `Tool` 抽象，明确 schema、validate、permission、read-only/concurrency、progress、UI summary、result budget 的升级方向。
- Create `docs/claude-code-core-design/04-context-memory-compaction.md`  
  分析 snip、microcompact、autocompact、reactive compact、tool result budget、content replacement，并对照 `memory.py`、`compactor.py`、`runner.py`。
- Create `docs/claude-code-core-design/05-task-subagent-runtime.md`  
  剖析 `TaskState`、LocalAgentTask、LocalMainSessionTask、sidechain transcript、background notification、AgentTool/runAgent，并映射到 `subagents/`、`team/`、`runtime/active.py`。
- Create `docs/claude-code-core-design/06-emperor-upgrade-roadmap.md`  
  输出升级 Epics：Runner 状态机拆分、Tool Protocol v2、Streaming Tool Executor、Permission Pipeline v2、Task Framework、Context Budget Pipeline、Runtime Replay 收敛。

## Tasks

### Task 1: Build Read-Only Source Index

**Files:**
- Read: `/Users/anhuike/Documents/workspace/claude-code-source-code/src/main.tsx`
- Read: `/Users/anhuike/Documents/workspace/claude-code-source-code/src/query.ts`
- Read: `/Users/anhuike/Documents/workspace/claude-code-source-code/src/Tool.ts`
- Read: `/Users/anhuike/Documents/workspace/claude-code-source-code/src/services/tools/*`
- Read: `/Users/anhuike/Documents/workspace/claude-code-source-code/src/utils/permissions/*`
- Read: `agent/runner.py`
- Read: `agent/loop.py`
- Read: `agent/tools/*`
- Read: `agent/control/*`
- Read: `agent/permissions/*`

- [ ] **Step 1: Index Claude Code directories**

Run:

```bash
find /Users/anhuike/Documents/workspace/claude-code-source-code/src -maxdepth 2 -type d | sort
```

Expected: directories include `query`, `services`, `tools`, `tasks`, `state`, `utils`, `screens`, `entrypoints`.

- [ ] **Step 2: Locate core loops and protocols**

Run:

```bash
rg -n "export async function\\* query|export type Tool|class StreamingToolExecutor|export async function\\* runAgent" /Users/anhuike/Documents/workspace/claude-code-source-code/src
```

Expected: matches in `src/query.ts`, `src/Tool.ts`, `src/services/tools/StreamingToolExecutor.ts`, `src/tools/AgentTool/runAgent.ts`.

- [ ] **Step 3: Index Emperor comparison files**

Run:

```bash
find agent/control agent/permissions agent/runtime agent/tools agent/team agent/subagents -maxdepth 2 -type f | sort
```

Expected: files include `agent/runner.py`, tool registry/base files, control manager/policy/store, permission policy/manager, runtime store/events, team manager/store.

### Task 2: Write Core Design Documents

**Files:**
- Create: `docs/claude-code-core-design/README.md`
- Create: `docs/claude-code-core-design/01-composition-root.md`
- Create: `docs/claude-code-core-design/02-agent-execution-state-machine.md`
- Create: `docs/claude-code-core-design/03-tool-protocol-and-permissions.md`
- Create: `docs/claude-code-core-design/04-context-memory-compaction.md`
- Create: `docs/claude-code-core-design/05-task-subagent-runtime.md`
- Create: `docs/claude-code-core-design/06-emperor-upgrade-roadmap.md`

- [ ] **Step 1: Create documentation directory**

Run:

```bash
mkdir -p docs/claude-code-core-design
```

Expected: directory exists.

- [ ] **Step 2: Write analysis docs**

Create the seven Markdown files listed above. Each document must include:

- Claude Code source references by path.
- Emperor Agent comparison points.
- Specific upgrade recommendations.
- No large copied source blocks.
- No unfinished-marker text.

- [ ] **Step 3: Check all deliverables exist**

Run:

```bash
ls docs/claude-code-core-design
```

Expected: `README.md` and files `01` through `06` are present.

### Task 3: Write Upgrade Implementation Plan

**Files:**
- Create: `docs/superpowers/plans/2026-06-23-claude-code-core-design-upgrade.md`

- [ ] **Step 1: Create plan directory**

Run:

```bash
mkdir -p docs/superpowers/plans
```

Expected: directory exists.

- [ ] **Step 2: Save execution plan**

Create `docs/superpowers/plans/2026-06-23-claude-code-core-design-upgrade.md` with:

- Plan header.
- File structure.
- Task checklist.
- Verification commands.
- Assumptions.

### Task 4: Verify Documentation Quality

**Files:**
- Verify: `docs/claude-code-core-design/*`
- Verify: `docs/superpowers/plans/2026-06-23-claude-code-core-design-upgrade.md`

- [ ] **Step 1: Scan for unfinished-marker language**

Run:

```bash
rg -n "T[B]D|TO[D]O|待[定]|待[补]|place[Hh]older" docs/claude-code-core-design docs/superpowers/plans
```

Expected: no matches.

- [ ] **Step 2: Confirm external source paths are intentional references**

Run:

```bash
rg -n "/Users/anhuike/Documents/workspace/claude-code-source-code/src" docs/claude-code-core-design
```

Expected: matches are source-reference statements, not copied source dumps.

- [ ] **Step 3: Check Markdown diff hygiene**

Run:

```bash
git diff --check
```

Expected: no trailing whitespace or whitespace errors.

## Assumptions

- 本计划只创建分析文档和升级路线，不修改运行时代码。
- 文档默认使用中文；命令、路径、类型名、配置 key 保留英文。
- Claude Code 源码只作为本地研究对象，输出聚焦架构与设计，不做大段源码转载。
- 产物落在当前项目 `docs/` 下，不写入 `memory/`、`.team/`、本地配置或构建目录。
