# Emperor 作用域驱动上下文状态系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Emperor 从“多个 Markdown/JSONL 文件驱动的记忆系统”升级为“有作用域、有注入策略、有写入权限、有压缩游标、有上下文审计的状态系统”。

**Architecture:** 本计划不处理文件路径迁移；它建立在 `/Users/anhuike/Documents/workspace/emperor-agent/docs/superpowers/plans/2026-07-06-global-state-store-claude-code-alignment.md` 之上同步推进。全局 store 计划负责“文件放哪里”，本计划负责“信息属于哪个作用域、谁可以写、何时写、何时注入模型、这次模型调用到底看到了什么”。核心做法是引入 `MemoryScope`、`ActiveMemoryBinding`、`ContextPolicy`、`ContextPlan`、`MemoryPatch`、`CompactionCursor`、`TurnCheckpoint` 和 `memory.explainContext`。

**Tech Stack:** TypeScript, `@emperor/core`, Electron/Vue diagnostics UI, Node filesystem APIs, Vitest.

---

## 关键证据与当前路径

### Emperor 当前机制证据

- `stateRoot` 当前默认从 `runtimeRoot/.emperor` 派生，后续由全局 store 计划迁移：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/paths.ts:28`
- 会话激活时 checkpoint 优先于 unarchived history：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts:270`
- turn 写入 session history 与 runtime event：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts:351`
- `SessionStore` 管 session index/meta：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/store.ts:51`
- `ConversationStore` 管 `history.jsonl`、`history_index.json`、`history_archive/`、`_checkpoint.json`：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/conversation.ts:9`
- `ProjectSessionMemoryStore` 在 build session 中把 memory API 指向 project memory：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/conversation.ts:166`
- `ProjectStore` / `ProjectStateStore` 管 `AGENTS.local.md` managed project memory：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/store.ts:32`、`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/state-store.ts:33`
- `MemoryStore` 管 `MEMORY.local.md`、daily episode、`USER.local.md`、history/checkpoint 兼容 API：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/store.ts:14`
- `ContextBuilder` 当前用 if/else 决定 chat/build 注入：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/context-builder.ts:100`
- build mode 注入 `project_agents`，chat mode 注入 `long_term_memory`：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/context-builder.ts:147`
- `Compactor` 能输出 episode / memory / user，但主 runner 当前传 `compactor: null`：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/compactor.ts:153`、`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts:396`
- `ContextPipeline.microcompact()` 是请求前临时裁剪，不改磁盘：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/pipeline.ts:124`
- prompt snapshot 入口在 runner：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/runner.ts:601`
- runtime replay 的 compact 是 UI 读取侧压缩，不是 memory：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/runtime/store.ts:32`
- `save_user_profile` 当前整份覆盖 `USER.local.md`：`/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/tools/builtin.ts:265`

### 与全局 store 计划的边界

- 全局 store 计划负责：`stateRoot`、`~/.emperor-agent`、旧路径迁移、附件/媒体/配置路径。
- 本计划负责：作用域语义、注入矩阵、checkpoint 有效性、compactor 写入目标、压缩游标、prompt snapshot 审计、UI 解释。
- 两份计划都会触及 `AgentLoop`、`ContextBuilder`、`MemoryStore`、`ProjectStore`、diagnostics；执行时必须共用同一套 `stateRoot` 和 memory path 解析，避免重复定义。

### 与算法子计划（memory-compaction-algorithm-optimization）之间的文件归属

本计划与其算法子计划 `2026-07-06-memory-compaction-algorithm-optimization.md` 共享大量类型和文件，两份计划最初各自把同一批新文件列成了 "Create"，如果被拆给两个 agent 并行实现会产生两套不兼容的 `MemoryPatch`/`markdown schema`/`compaction ledger`。约定归属如下，任何一方实现时都必须遵守，不得重新创建对方已拥有的文件：

- `packages/core/src/memory/patch.ts`、`packages/core/src/memory/markdown-schema.ts`：**本计划**的 Task 7/8 创建（通用 patch 应用/校验/Markdown schema 机制，供 compaction 之外的写入者复用，例如 Task 8 里改造的 `save_user_profile`）。算法子计划的同名任务只能 "Modify" 并在其上叠加 compaction 专属的路由逻辑，不得重新定义 `MemoryPatch`/`MemoryPatchOperation` 等类型。
- `packages/core/src/memory/compaction-ledger.ts`：**算法子计划**的 Task 1 创建（`CompactionCursorStore`/`CompactionLedger` 的具体落地更完整）。本计划 Task 9 只能引用/扩展，不得重新创建。
- 本文档"Compaction cursor and job"一节里的 `SessionMemoryCursor` 是目标契约草图，权威定义和落地文件在算法子计划 Task 1 的 `memory/compaction-models.ts`；`CompactionJob` 是早期草图，算法子计划已用更完整的 `CompactionRunRecord`取代，本计划不再单独建任务实现 `CompactionJob`，视为示意性内容。
- 后续如需新增两份计划都会碰到的共享文件，落地前必须先确认只有一处 "Create"，另一处显式写 "Modify，见 XXX 计划 Task N"。

---

## 目标分层模型

```text
Profile Layer
  USER.local.md
  用户长期偏好、身份、工作习惯；chat/build 都注入。

Semantic Memory Layer
  MEMORY.local.md
  AGENTS.local.md managed block
  全局长期记忆与项目长期记忆；由 scope 决定读写与注入。

Episodic Layer
  YYYY-MM-DD.md
  日期情景记录、会话摘要；默认 retrieval/archive，不是 always-on prompt memory。

Session Layer
  history.jsonl
  history_index.json
  history_archive/
  _checkpoint.json
  对话 transcript、热历史、冷归档、turn 恢复状态。

Runtime Layer
  runtime/events.jsonl
  UI 事件、工具事件、执行事件；默认不进入模型上下文和 compactor。

Context Layer
  ContextPolicy
  ContextPlan
  ContextAssembler
  Microcompactor
  每次模型调用前选择、解释、裁剪、注入上下文。

Audit Layer
  prompt-snapshots/
  memory versions
  model_call rows
  compaction ledger
  解释模型当时看到了什么、哪些版本、为什么没看到某些内容。
```

核心数据流：

```text
user / model / tools
  -> Session Layer: history + checkpoint + runtime events
  -> Compaction Layer: history range -> MemoryPatch
  -> Memory Layer: profile/global/project/episode
  -> Context Layer: policy -> plan -> assembled messages -> microcompact
  -> Audit Layer: prompt snapshot + model_call + memory versions
  -> model call
```

---

## Target Contracts

### Memory scope and binding

```ts
export type MemoryScope =
  | { kind: 'user_profile' }
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }
  | { kind: 'episode'; date: string }
  | { kind: 'session'; sessionId: string }

export interface MemoryBindingTarget {
  scope: MemoryScope
  readable: boolean
  writable: boolean
  path?: string | null
}

export interface ActiveMemoryBinding {
  profile: MemoryBindingTarget & { scope: { kind: 'user_profile' } }
  longTerm:
    | (MemoryBindingTarget & { scope: { kind: 'global' } })
    | (MemoryBindingTarget & { scope: { kind: 'project'; projectId: string } })
  episode: MemoryBindingTarget & { scope: { kind: 'episode'; date: string } }
}
```

Rules:

- Chat session resolves `longTerm.scope.kind === 'global'`.
- Build session resolves `longTerm.scope.kind === 'project'` and requires `projectId`.
- Episode is writable by compactor but not readable by default for prompt injection.
- Upper layers must not infer scope from `readMemory()`; they must use `ActiveMemoryBinding`.

### Memory artifact metadata

```ts
export type MemoryArtifactKind =
  | 'user_profile'
  | 'global_memory'
  | 'project_memory'
  | 'daily_episode'
  | 'conversation_history'
  | 'runtime_event_log'
  | 'checkpoint'
  | 'prompt_snapshot'
  | 'history_archive'
  | 'model_call_audit'

export type MemoryVisibility =
  | 'always_injected'
  | 'chat_only'
  | 'build_only'
  | 'session_context'
  | 'retrieval_only'
  | 'runtime_only'
  | 'debug_only'
  | 'recovery_only'
  | 'never_model_visible'

export type MemoryMutability =
  | 'append_only'
  | 'managed_patch'
  | 'managed_rewrite'
  | 'replaceable_checkpoint'
  | 'derived'

export type MemoryWriter =
  | 'onboarding'
  | 'agent_loop'
  | 'user_tool'
  | 'compactor'
  | 'runtime'
  | 'system'

export interface MemoryArtifactMeta {
  artifactId: string
  kind: MemoryArtifactKind
  scope: MemoryScope
  visibility: MemoryVisibility
  mutability: MemoryMutability
  createdAt: string
  updatedAt: string
  version: number
  contentHash: string
  writers: MemoryWriter[]
  injectedIn: Array<'chat' | 'build'>
  path: string
}
```

Required artifact mapping:

```text
USER.local.md            user_profile          user_profile  always_injected      managed_patch
MEMORY.local.md          global_memory         global        chat_only            managed_patch
AGENTS.local.md          project_memory        project       build_only           managed_patch
YYYY-MM-DD.md            daily_episode         episode       retrieval_only       append_only/managed_patch
history.jsonl            conversation_history  session       session_context      append_only
_checkpoint.json         checkpoint            session       recovery_only        replaceable_checkpoint
runtime/events.jsonl     runtime_event_log     session       runtime_only         append_only
prompt-snapshots/        prompt_snapshot       session       debug_only           append_only
history_archive/         history_archive       session       never_model_visible  append_only
model_call rows          model_call_audit      session       debug_only           append_only
```

### Context policy and plan

```ts
export type ContextPlanItemKind =
  | 'system_bootstrap'
  | 'tool_instructions'
  | 'user_profile'
  | 'global_memory'
  | 'project_memory'
  | 'project_path'
  | 'project_index'
  | 'episode'
  | 'session_history'
  | 'checkpoint'
  | 'microcompact_notice'

export interface ContextPolicy {
  mode: 'chat' | 'build'
  include: ContextPlanItemKind[]
  exclude: ContextPlanItemKind[]
}

export interface ContextPlanItem {
  id: string
  kind: ContextPlanItemKind
  scope?: MemoryScope
  source: string
  included: boolean
  reason: string
  tokenEstimate?: number | null
  contentHash?: string | null
  version?: number | null
}

export interface MicrocompactRecord {
  turnId: string
  appliedAt: string
  omitted: Array<{
    // Derived, not a new persisted field: history rows only carry `turn_id` today, no
    // per-message id. Compute as `${turnId}:${indexWithinTurn}` where indexWithinTurn is
    // the message's position among rows sharing that turn_id in the projected array —
    // stable for the duration of one turn's projection, which is all this audit needs.
    messageId: string
    role: 'user' | 'assistant' | 'tool'
    originalChars: number
    originalTokenEstimate: number
    originalHash: string
    replacementText: string
    reason: 'old_long_text' | 'tool_output_too_large' | 'assistant_response_too_large' | 'within_token_budget'
  }>
}

export interface ContextPlan {
  sessionId: string
  turnId: string
  mode: 'chat' | 'build'
  activeMemoryBinding: ActiveMemoryBinding
  items: ContextPlanItem[]
  omitted: Array<{ kind: ContextPlanItemKind | string; source: string; reason: string }>
  microcompact: MicrocompactRecord | null
  createdAt: string
}
```

Policies:

```ts
export const CONTEXT_POLICIES: Record<'chat' | 'build', ContextPolicy> = {
  chat: {
    mode: 'chat',
    include: ['system_bootstrap', 'tool_instructions', 'user_profile', 'global_memory', 'project_index', 'session_history'],
    exclude: ['project_memory', 'project_path'],
  },
  build: {
    mode: 'build',
    include: ['system_bootstrap', 'tool_instructions', 'user_profile', 'project_memory', 'project_path', 'session_history'],
    exclude: ['global_memory'],
  },
}
```

### Memory write and patch

```ts
export interface MemoryWriteRequest {
  target:
    | { kind: 'user_profile' }
    | { kind: 'global' }
    | { kind: 'project'; projectId: string }
    | { kind: 'episode'; date: string }
  operation: 'patch' | 'append' | 'replace_section'
  reason: string
  source: {
    sessionId?: string
    turnId?: string
    toolCallId?: string
    compactionId?: string
  }
  content: string
}

export type MemoryPatchOperation =
  | { op: 'append_section_item'; section: string; item: string }
  | { op: 'replace_section'; section: string; content: string }
  | { op: 'mark_deprecated'; itemId: string; reason: string }
  | { op: 'update_item'; itemId: string; content: string }

export interface MemoryPatch {
  target: MemoryScope
  baseVersion: number
  baseHash: string
  operations: MemoryPatchOperation[]
  rationale: string
}
```

Patch validation must reject:

- base hash mismatch
- forbidden section writes
- suspected secrets
- prompt injection text such as “ignore previous instructions”
- unexpected scope writes, such as build project facts written to global memory by default
- destructive user profile deletion unless explicit replace is requested

Patch application is two-phase:

```text
generate patch -> validate patch -> snapshot current file -> apply patch -> record ledger
```

### Compaction cursor and job

```ts
export interface SessionMemoryCursor {
  sessionId: string
  lastHistorySeq: number
  compactedUntilSeq: number
  archivedUntilSeq: number
  lastCompactionAt?: string
  lastCompactionId?: string
  status: 'active' | 'compacting' | 'archived' | 'closed'
}

export interface CompactionJob {
  jobId: string
  sessionId: string
  mode: 'chat' | 'build'
  projectId?: string
  fromSeq: number
  toSeq: number
  status: 'queued' | 'running' | 'patch_generated' | 'validated' | 'applied' | 'failed'
  createdAt: string
  updatedAt: string
}
```

> Ownership note: `SessionMemoryCursor` here is the target contract; the authoritative type and file are created in `2026-07-06-memory-compaction-algorithm-optimization.md` Task 1 (`memory/compaction-models.ts`) — do not create a second definition when implementing this plan. `CompactionJob` as sketched above is superseded by that plan's `CompactionRunRecord`; treat it as illustrative only, not a separate file to implement.

Rules:

- `history.jsonl` append remains the fact source.
- `compactedUntilSeq` means semantic compaction has been attempted and recorded.
- `archivedUntilSeq` means history rows moved to cold storage.
- Archive is not semantic compaction.
- Preferred v1 invariant: only history at or before `compactedUntilSeq` should be archived.

### Turn checkpoint

```ts
export interface TurnCheckpoint {
  sessionId: string
  turnId: string
  baseHistorySeq: number
  createdAt: string
  updatedAt: string
  phase:
    | 'user_received'
    | 'context_built'
    | 'model_called'
    | 'tool_calls_pending'
    | 'tool_calls_running'
    | 'tool_calls_completed'
    | 'assistant_response_pending'
    | 'history_commit_pending'
    | 'committed'
    | 'aborted'
  contextPlanId?: string
  promptSnapshotId?: string
  pendingToolCalls?: Array<{
    toolCallId: string
    toolName: string
    argsHash: string
    status: 'pending' | 'running' | 'completed' | 'failed'
  }>
  partialMessages: Array<Record<string, unknown>>
  committedHistorySeq?: number
}
```

Restore rule:

```ts
function shouldRecoverFromCheckpoint(checkpoint: TurnCheckpoint, history: { lastSeq: number }): boolean {
  if (checkpoint.phase === 'committed') return false
  if (checkpoint.phase === 'aborted') return false
  if (checkpoint.baseHistorySeq > history.lastSeq) return false
  if (checkpoint.committedHistorySeq) return false
  return true
}
```

### Prompt snapshot

```ts
export interface PromptSnapshot {
  snapshotId: string
  sessionId: string
  turnId: string
  modelCallId: string
  mode: 'chat' | 'build'
  projectId?: string
  contextPlan: ContextPlan
  memoryVersions: Array<{
    scope: MemoryScope
    artifactKind: MemoryArtifactKind
    version: number
    hash: string
  }>
  historyRange: { fromSeq: number; toSeq: number }
  checkpointId?: string
  microcompact?: MicrocompactRecord
  finalMessagesHash: string
  finalMessages: Array<Record<string, unknown>>
  createdAt: string
}
```

---

## Required invariants

1. `runtime/events.jsonl` never enters model context directly.
2. `model_call` audit rows never enter model context directly.
3. Build mode does not inject global `MEMORY.local.md` by default.
4. Chat mode does not inject concrete project `AGENTS.local.md` by default.
5. `USER.local.md` is injected in both chat and build mode.
6. Checkpoint restores only when not committed and base history is valid.
7. Microcompact does not write disk and does not mutate `history.jsonl`.
8. History archive is not semantic compaction.
9. Compactor must record `compactedUntilSeq`.
10. Build session project facts default to project memory, not global memory.
11. `USER.local.md` cannot be overwritten without validation/snapshot.
12. Every model call must have `ContextPlan` or equivalent audit.

---

## Task 1: Memory scope, artifact taxonomy, and layer model

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/artifacts.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/versions.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/artifacts.test.ts`

- [ ] Define `MemoryScope`, `MemoryArtifactKind`, `MemoryVisibility`, `MemoryMutability`, `MemoryWriter`, `MemoryArtifactMeta`.
- [ ] Define helper constructors for user profile, global memory, project memory, daily episode, conversation history, runtime event log, checkpoint, prompt snapshot, history archive, model call audit.
- [ ] Encode the artifact mapping table from this plan as executable data.
- [ ] `packages/core/src/memory/versions.ts` already ships an independent `MemoryVersionTarget = 'memory' | 'user' | 'episode' | 'project'` enum, wired into every existing write path (`MemoryStore.writeMemory/writeUser/appendEpisode`, `ProjectStore.updateMemory`). It does not line up with the new `MemoryScope.kind` (`user_profile | global | project | episode | session`) — different names for the same concepts, and `MemoryVersionTarget` has no `session` case. Reconcile before Task 7/9 land: either (a) rename `MemoryVersionTarget` values to match `MemoryScope.kind` and write a one-time index migration for `memory/versions/index.json` (its `target` field is serialized verbatim on disk), or (b) add an explicit two-way mapping (`memoryScopeToVersionTarget()` / `versionTargetToMemoryScope()`) and use it at every `snapshotPath()`/`restore()` call site. Pick one and use it consistently — do not let new code pass raw `MemoryScope.kind` strings into `snapshotPath({ target })` unchecked.
- [ ] `memoryVersionFromDict()` (`versions.ts:24-26`) silently coerces any unrecognized `target` string to `'memory'`. Add a test proving a scope string outside the reconciled set throws instead of being silently miscategorized.
- [ ] Add tests proving:
  - `USER.local.md` is `always_injected`.
  - `MEMORY.local.md` is `chat_only`.
  - `AGENTS.local.md` is `build_only`.
  - runtime event log and model call audit are not model-visible.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/memory/artifacts.test.ts
```

Expected: artifact taxonomy tests pass.

---

## Task 2: ActiveMemoryBinding replaces implicit `readMemory()` scope

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/conversation.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/context-builder.test.ts`

- [ ] Add `resolveActiveMemoryBinding(session)` or equivalent method on `AgentLoop`.
- [ ] Chat sessions return profile + global longTerm + writable episode.
- [ ] Build sessions require `projectId` and return profile + project longTerm + writable episode.
- [ ] Keep `SessionMemoryStore` / `ProjectSessionMemoryStore` for legacy read call sites (`loadUnarchivedHistory`, `appendHistory`, checkpoint read/write) — do not route any new patch-based write through them.
- [ ] `ProjectSessionMemoryStore` currently overrides `readTodayEpisode()` → `''`, `appendEpisode()` → no-op, and `writeUser()` → no-op (`packages/core/src/sessions/conversation.ts:189-199`). This silently drops any episode or profile write attempted through the session memory facade during a build session. The new patch committer (this plan's Task 7, and the algorithm sub-plan's Task 8) must resolve the write target directly from `ActiveMemoryBinding` — never through `activeMemoryStore.appendEpisode()` / `activeMemoryStore.writeUser()` — so build-session profile and episode patches actually land instead of being silently swallowed by these overrides.
- [ ] Add `active_memory_binding` to `turn_scope` runtime event.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/agent/context-builder.test.ts
```

Expected: chat binding is global; build binding is project with project id and project memory path.

---

## Task 3: ContextPolicyRegistry for chat/build injection rules

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/policy.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/policy.test.ts`

- [ ] Define `ContextPolicy`, `ContextPlanItemKind`, and `CONTEXT_POLICIES`.
- [ ] Chat policy includes bootstrap, tool instructions, user profile, global memory, project index, session history.
- [ ] Build policy includes bootstrap, tool instructions, user profile, project memory, project path, session history.
- [ ] Chat policy excludes project memory/project path by default.
- [ ] Build policy excludes global memory by default.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/context/policy.test.ts
```

Expected: policy tests encode injection matrix.

---

## Task 4: ContextPlanner -> ContextAssembler split

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/planner.ts`
- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/assembler.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/context-builder.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/context-builder.test.ts`

- [ ] `ContextPlanner` builds `ContextPlan` from session, active binding, policy, artifact metadata, and current history source.
- [ ] `ContextAssembler` renders the final prompt sections/messages from `ContextPlan`.
- [ ] `ContextBuilder` remains as compatibility facade but stops owning hidden chat/build if/else rules.
- [ ] Build mode plan must include omitted global memory with reason: `build mode intentionally does not inject global MEMORY`.
- [ ] Chat mode plan must include omitted project memory with reason: `chat mode has no active bound project memory`.
- [ ] Context plan must include token estimates and content hashes where available.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/agent/context-builder.test.ts
```

Expected: prompt output remains behavior-compatible while `ContextPlan` explains included and omitted items.

---

## Task 5: TurnCheckpoint state machine

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/checkpoint.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/conversation.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/runner.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/sessions/sessions.test.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/runner.test.ts`

- [ ] Write checkpoint as `TurnCheckpoint` versioned shape.
- [ ] Read legacy `{ ts, history }` checkpoints for compatibility, but mark them as legacy in diagnostics.
- [ ] Store `sessionId`, `turnId`, `baseHistorySeq`, `phase`, `contextPlanId`, `promptSnapshotId`, pending tool call statuses, partial messages.
- [ ] Implement `shouldRecoverFromCheckpoint()`.
- [ ] Ignore committed, aborted, stale, corrupt, or impossible checkpoints.
- [ ] On successful turn completion: append final assistant message, flush history, mark checkpoint committed, then remove/archive checkpoint.
- [ ] `ConversationStore.writeCheckpoint/readCheckpoint/clearCheckpoint` (`sessions/conversation.ts:83-104`) and `MemoryStore.writeCheckpoint/readCheckpoint/clearCheckpoint` (`memory/store.ts:150-179`) are near-duplicate implementations of the same `{ts, history}` shape today. While upgrading both to `TurnCheckpoint`, factor the shared read/write/atomic-rename logic into one place (e.g. `sessions/checkpoint.ts`) instead of keeping two parallel copies.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/sessions/sessions.test.ts packages/core/src/agent/runner.test.ts
```

Expected: committed/stale checkpoint restores from history; paused/tool checkpoint restores from checkpoint.

---

## Task 6: PromptSnapshot as complete audit object

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/prompts/manifest.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/runner.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/prompts/manifest.test.ts`

- [ ] Extend prompt snapshot manifest with `PromptSnapshot` fields from this plan.
- [ ] Save `ContextPlan`, active binding, memory versions/hashes, history range, checkpoint id, microcompact record, final messages hash.
- [ ] Keep a human-readable prompt file and add a machine-readable JSON manifest.
- [ ] Snapshot must answer why build mode did not see global `MEMORY.local.md`.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/prompts/manifest.test.ts
```

Expected: snapshot manifest contains context plan and memory version audit.

---

## Task 7: MemoryPatch two-phase commit and validation

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/patch.ts`
- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/patch.test.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/store.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/store.ts`

- [ ] Define `MemoryWriteRequest`, `MemoryPatch`, `MemoryPatchOperation`, validation result, and patch application result.
- [ ] Validate base hash/version before applying.
- [ ] Reject suspected secrets and prompt-injection phrases.
- [ ] Reject unexpected scope write: project facts from build compaction cannot target global memory by default.
- [ ] Snapshot current target via `MemoryVersionStore` before applying.
- [ ] Apply patch, then record target, source, operation count, and rationale in a ledger.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/memory/patch.test.ts
```

Expected: safe patch applies; hash mismatch, secret, prompt injection, and wrong-scope writes are rejected.

---

## Task 8: Markdown schemas for profile/global/project/episode

**Files:**

- Create: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/markdown-schema.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/markdown-schema.test.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/tools/builtin.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/projects/state-store.ts`

- [ ] Define canonical `USER.local.md` sections: `Stable Preferences`, `Working Style`, `Long-Term Constraints`, `Deprecated`.
- [ ] Define canonical `MEMORY.local.md` sections: `Long-Term Projects`, `Cross-Project Decisions`, `Open Questions`, `Deprecated`.
- [ ] Define project memory sections: `Project Identity`, `Architecture Notes`, `Build Commands`, `Design Decisions`, `Open Tasks`, `Known Issues`, `Deprecated`.
- [ ] Define episode sections: `Summary`, `Decisions`, `Follow-ups`, `Raw References`.
- [ ] `SaveUserProfileTool` currently takes a raw file path and calls `writeFileSync()` directly (`tools/builtin.ts:274-282`), constructed in `agent/loop.ts:435` as `new SaveUserProfileTool(this.sharedMemory.userFile)`. This bypasses `MemoryStore.writeUser()` entirely, and therefore also bypasses the `MemoryVersionStore.snapshotPath()` pre-write snapshot that every other memory-writing path already gets (`memory/store.ts:144-147`). Rewire the tool to write through `MemoryStore.writeUser()` (or the new patch-apply path once Task 7 lands) instead of an independent `writeFileSync`, so every profile overwrite gets a pre-write snapshot to diff/restore from — do this before or together with the 40%-deletion guard below, since a guard with no pre-image to compare against is incomplete.
- [ ] Update `save_user_profile` compatibility path so future writes use patch-managed updates unless explicit replace is requested.
- [ ] Reject profile updates deleting more than 40% of existing non-empty lines without explicit replace.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/memory/markdown-schema.test.ts packages/core/src/tools.test.ts
```

Expected: schema parsing and patch-preserving profile writes pass.

---

## Task 9: Mode-aware compactor and CompactionCursor

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/compactor.ts`
- Uses: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/compaction-ledger.ts` (created by `2026-07-06-memory-compaction-algorithm-optimization.md` Task 1 — do not recreate here, see file-ownership note above)
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/memory/compactor-token.test.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/memory-service.test.ts`

- [ ] Replace generic compaction with `compactSession({ sessionId, mode, projectId, range, activeMemoryBinding, messages })`.
- [ ] Output `episodePatch`, `userProfilePatch`, optional `globalMemoryPatch`, optional `projectMemoryPatch`, `discarded`, and `decisions`.
- [ ] Chat compaction routes stable user preferences to profile, cross-session facts to global memory, day summary to episode.
- [ ] Build compaction routes project facts to project memory, stable user preferences to profile, day summary to episode.
- [ ] Build compaction writes global memory only for explicit cross-project learning.
- [ ] Record `SessionMemoryCursor` with `compactedUntilSeq` and `lastCompactionId`.
- [ ] Prevent duplicate compaction of the same history seq range.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/memory/compactor-token.test.ts packages/core/src/api/services/memory-service.test.ts
```

Expected: build facts target project memory, chat facts target global memory, cursor prevents duplicate compaction.

---

## Task 10: Automatic compaction trigger/job design

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/loop.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/runner.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/memory-service.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/agent/runner.test.ts`

- [ ] Manual `memory.compact` uses the same mode-aware compaction path as automatic compaction.
- [ ] Automatic compaction is feature-flagged with `EMPEROR_AUTO_MEMORY_COMPACT=1`.
- [ ] Trigger candidates: token threshold, N new turns, idle session, session close, archive-before-compaction.
- [ ] V1 only needs token threshold and manual trigger; other triggers can be represented as disabled policies in diagnostics.
- [ ] Compaction runs after successful final assistant reply, never during ask/plan/pause/tool-running state.
- [ ] Compaction failure emits `record_degraded(kind: "memory_compaction")` and does not mutate history.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/agent/runner.test.ts
```

Expected: compactor is not invoked while paused; with flag enabled and threshold exceeded, it receives active binding and history seq range.

---

## Task 11: Runtime/model context isolation and microcompact audit

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/pipeline.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/context/tool-results.ts`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/tools-and-context.test.ts`

- [ ] Ensure runtime events are not accepted as conversation messages for model context.
- [ ] Ensure `model_call` rows remain filtered from `loadUnarchivedHistory()`.
- [ ] Extend `[local_microcompact]` replacement to include role, original chars, original hash, and reason.
- [ ] Compute `messageId` for each omitted entry as `` `${turnId}:${indexWithinTurn}` `` (see comment on `MicrocompactRecord` above) — no schema change to `history.jsonl` is needed.
- [ ] Emit `MicrocompactRecord` into `ContextPlan` and prompt snapshot.
- [ ] Test that microcompact does not mutate source history.
- [ ] Scope note: `AgentLoop.buildMainRunner()` is the only runner this plan's compaction/binding work targets. Dispatch subagent runners and Team runners (`buildDispatchRunnerFactory`, `createTeamManager` in `agent/loop.ts`) are constructed with `compactor: null` today and stay out of scope — they are short-lived task executions, not long-running chat/build sessions.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/tools-and-context.test.ts
```

Expected: runtime/model-call isolation and microcompact audit tests pass.

---

## Task 12: `memory.explainContext` and UI diagnostics

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/core-api.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/memory-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/diagnostics-service.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/renderer/src/types.ts`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/desktop/src/renderer/src/components/panels/MemoryPanel.vue`
- Test: `/Users/anhuike/Documents/workspace/emperor-agent/packages/core/src/api/services/memory-service.test.ts`

- [ ] Add internal API `memory.explainContext(sessionId, turnId)`.
- [ ] Return current mode, active memory binding, injected items, omitted items with reasons, checkpoint status, microcompact summary, prompt snapshot reference.
- [ ] UI labels distinguish User Profile, Global Memory, Project Memory, Episode Log, Session Transcript, Runtime Events, Recovery Checkpoint.
- [ ] Build session UI states: “当前项目会话使用项目记忆，默认不注入全局长期记忆。”
- [ ] No label may show a bare on-disk filename like `AGENTS.local.md` or `USER.local.md` without a qualifier — both are easy to confuse with the project's own committable `AGENTS.md` and with the seed-template directory. Use `全局私有项目记忆 (AGENTS.local.md)` / `用户偏好档案 (USER.local.md)` style labels consistently across diagnostics, `/memory explain`, and the memory panel.
- [ ] `/memory explain` or equivalent command can call the same service later; this task only requires service and diagnostics payload.

Acceptance:

```bash
npm test --workspace @emperor/core -- packages/core/src/api/services/memory-service.test.ts
npm --prefix desktop run typecheck
```

Expected: explain payload is typed and renderer compiles.

---

## Task 13: Cross-plan integration and architecture docs

**Files:**

- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/docs/superpowers/plans/2026-07-06-global-state-store-claude-code-alignment.md`
- Create: `/Users/anhuike/Documents/workspace/emperor-agent/docs/architecture/memory-scope-and-compaction.md`
- Modify: `/Users/anhuike/Documents/workspace/emperor-agent/README.md`

- [ ] Add cross-reference from global state store plan to this plan.
- [ ] Document that global store migration changes storage roots only; scope semantics are governed here.
- [ ] Architecture doc includes layer model, artifact taxonomy, injection matrix, checkpoint lifecycle, memory patch protocol, compaction cursor, prompt snapshot audit, and `memory.explainContext`.
- [ ] Include user-visible symptom mapping:
  - chat remembers but build does not
  - build remembers but chat does not
  - just discussed but later forgotten
  - UI shows event but model does not know it
  - session repeats old steps after restore
  - user profile lost content

Acceptance:

```bash
git diff --check
```

Expected: no whitespace errors.

---

## Test Plan

Core:

- [ ] `npm test --workspace @emperor/core`
- [ ] `npm run typecheck --workspace @emperor/core`
- [ ] Chat/build injection matrix tests.
- [ ] Active memory binding tests.
- [ ] Context plan included/omitted reason tests.
- [ ] Checkpoint committed/stale/recoverable tests.
- [ ] Memory patch validation tests.
- [ ] Compactor scope and cursor tests.
- [ ] Microcompact non-mutation and audit tests.
- [ ] Runtime/model-call isolation tests.

Desktop:

- [ ] `npm --prefix desktop run test`
- [ ] `npm --prefix desktop run typecheck`
- [ ] Memory panel labels and build-mode explanation render correctly.

Full:

- [ ] `git diff --check`
- [ ] `make check`

Manual verification:

- [ ] Chat session prompt snapshot includes user profile + global memory and omits project memory.
- [ ] Build session prompt snapshot includes user profile + project memory and omits global memory.
- [ ] Paused ask/tool checkpoint restores; completed checkpoint does not shadow history.
- [ ] Manual compaction in chat updates profile/global/episode according to patch decisions.
- [ ] Manual compaction in build updates profile/project/episode and does not write project facts to global memory by default.
- [ ] `memory.explainContext` explains injected/omitted memory and microcompact records.

---

## Rollout Strategy

1. Land artifact taxonomy, active binding, and diagnostics first; this explains current behavior without changing prompt content.
2. Land `ContextPolicyRegistry` and `ContextPlan`; keep prompt output compatible.
3. Land checkpoint state machine to reduce repeated old-turn restores.
4. Land prompt snapshot audit.
5. Land patch-based memory writes.
6. Land mode-aware manual compactor with cursor.
7. Enable automatic compactor behind `EMPEROR_AUTO_MEMORY_COMPACT=1`.
8. After stable tests and manual verification, decide whether auto compaction defaults on.

---

## Risk Register

- **Risk:** Changing checkpoint format breaks old sessions.
  **Mitigation:** legacy checkpoint shape remains readable; new writes use `TurnCheckpoint`.

- **Risk:** Context plan refactor changes prompt behavior.
  **Mitigation:** first land planner/assembler with behavior-compatible rendered prompt and prompt snapshot tests.

- **Risk:** Build compactor leaks project facts into global memory.
  **Mitigation:** patch validator rejects project-fact-to-global writes unless explicitly classified as cross-project learning.

- **Risk:** Patch-managed memory blocks legitimate full rewrites.
  **Mitigation:** allow explicit replace with version snapshot and destructive-change threshold.

- **Risk:** Diagnostics increase event size.
  **Mitigation:** runtime events store summary and snapshot id; full audit stays in prompt snapshot manifest.

- **Risk:** Memory guard text affects model behavior.
  **Mitigation:** add guards without changing higher-priority bootstrap order and verify prompt snapshots.

---

## Assumptions

- This plan does not move files to `~/.emperor-agent`; that belongs to `2026-07-06-global-state-store-claude-code-alignment.md`.
- Existing Markdown memory files remain supported; this plan adds stable section schema and patch protocol.
- Runtime events remain UI/debug artifacts and never become direct model context.
- Build mode remains project-isolated by default.
- Episode logs are retrieval/archive sources by default, not always-on prompt memory.
- Automatic compaction starts behind `EMPEROR_AUTO_MEMORY_COMPACT=1`.
- `memory.explainContext` is required diagnostics surface, not optional UI decoration.
- Dispatch subagent runs and Team member runs never get a compactor (`compactor: null` in `agent/loop.ts`'s dispatch/team runner factories) and are out of scope for `ActiveMemoryBinding`/compaction; only the main session runner is covered.
- File ownership across the two memory plans is asymmetric and fixed: `memory/patch.ts` and `memory/markdown-schema.ts` are created here (Task 7/8); `memory/compaction-ledger.ts` is created by the algorithm sub-plan (its Task 1) and only referenced here. See "与算法子计划之间的文件归属" above.
