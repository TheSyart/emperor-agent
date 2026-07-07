import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { LLMProvider } from '../providers/base'
import type { TokenTracker } from './token-tracker'
import { HistoryLog } from './history'
import { todayUtc8 } from './time-utc8'
import {
  type ActiveMemoryBinding,
  type CompactionDraft,
  type CompactionPatchBundle,
  type CompactionRunRecord,
  type CompactionTrigger,
  type DraftOperation,
  type DraftTarget,
  type MemoryScope,
} from './compaction-models'
import { CompactionCursorStore, CompactionLedger } from './compaction-ledger'
import { CompactionInputProjector, renderProjectedConversation } from './compaction-input'
import { buildCompactionPrompt, jsonRepairPrompt, schemaRepairPrompt, scopeRepairPrompt } from './compaction-prompt'
import { parseCompactionDraft } from './compaction-draft'
import { CompactionPatchCommitter } from './compaction-commit'
import { selectCompactionRange } from './compaction-range'
import { memoryContentHash, type MemoryPatch, type MemoryPatchOperation } from './patch'
import type { MemoryVersionStore } from './versions'
import { routeBuildDecision, routeChatDecision, type CompactionMemoryDecision } from './compaction-routing'

export interface ScopedCompactionModel {
  provider: LLMProvider
  model: string
  providerName?: string | null
  modelRole?: string | null
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string | null
  routeReason?: string | null
}

export interface ScopedCompactionMemory {
  root: string
  memoryDir: string
  userFile: string
  versions: MemoryVersionStore
  readUser(): string
  readGlobalMemory(): string
  readEpisode(): string
  readProjectMemory(projectId: string): string
}

export interface CompactSessionOptions {
  sessionId: string
  mode: 'chat' | 'build'
  projectId?: string | null
  historyFile: string
  trigger?: CompactionTrigger
  keepTailTurns?: number
  memory: ScopedCompactionMemory
  model: ScopedCompactionModel
  tokenTracker?: TokenTracker | null
}

export interface ScopedCompactionResult {
  status: 'compacted' | 'skipped' | 'degraded'
  message: string
  count: number
  compaction?: {
    compactionId: string
    mode: 'chat' | 'build'
    projectId: string | null
    range: { fromSeq: number; toSeq: number }
    cursor: ReturnType<CompactionCursorStore['readOrInit']>
    applied: Array<{ scope: MemoryPatch['target']; path: string; operationCount: number }>
    discarded: CompactionPatchBundle['discarded']
    decisions: CompactionPatchBundle['decisions']
  }
  error?: string
}

export async function compactSession(opts: CompactSessionOptions): Promise<ScopedCompactionResult> {
  const history = new HistoryLog(dirname(opts.historyFile), opts.historyFile)
  const activeRows = history.loadActiveRows()
  const count = countMessageRows(activeRows)
  const cursorStore = new CompactionCursorStore(opts.memory.root)
  const ledger = new CompactionLedger(opts.memory.root)
  const cursor = cursorStore.readOrInit(opts.sessionId)
  const trigger = opts.trigger ?? { kind: 'manual' }
  const range = selectCompactionRange({
    sessionId: opts.sessionId,
    cursor,
    history,
    trigger,
    keepTailTurns: opts.keepTailTurns ?? 4,
  })
  if (!range) {
    return {
      status: 'skipped',
      count,
      message: '没有新的可压缩稳定会话历史。',
    }
  }

  const rows = activeRows.filter((row) => {
    const seq = Number(row.seq) || 0
    return seq >= range.fromSeq && seq <= range.toSeq
  })
  const compactedCount = countMessageRows(rows)
  const binding = activeMemoryBinding({
    mode: opts.mode,
    projectId: opts.projectId ?? null,
    root: opts.memory.root,
    memoryDir: opts.memory.memoryDir,
    userFile: opts.memory.userFile,
  })
  if (opts.mode === 'build' && !opts.projectId) {
    return {
      status: 'degraded',
      count,
      message: '记忆压缩失败，build session 缺少 projectId。',
      error: 'missing_project_id',
    }
  }

  const snapshots = {
    userProfile: opts.memory.readUser(),
    globalMemory: opts.memory.readGlobalMemory(),
    projectMemory: opts.mode === 'build' && opts.projectId ? opts.memory.readProjectMemory(opts.projectId) : null,
    episode: opts.memory.readEpisode(),
  }
  const projected = new CompactionInputProjector({ mode: opts.mode }).project(rows)
  const projectedConversation = renderProjectedConversation(projected)
  const prompt = buildCompactionPrompt({
    sessionId: opts.sessionId,
    mode: opts.mode,
    projectId: opts.projectId ?? null,
    range,
    activeMemoryBinding: binding,
    snapshots,
    projectedConversation,
  })

  let draftText = ''
  try {
    draftText = await callCompactionModel(opts.model, prompt, opts.tokenTracker)
  } catch (exc) {
    return degraded(count, exc)
  }
  let parsed = parseCompactionDraft(draftText)
  if (!parsed.ok) {
    try {
      const repair = parsed.quality.validJson ? schemaRepairPrompt(parsed.errors) : jsonRepairPrompt()
      draftText = await callCompactionModel(opts.model, `${repair}\n\nInvalid draft:\n${draftText.slice(0, 12_000)}`, opts.tokenTracker)
      parsed = parseCompactionDraft(draftText)
    } catch (exc) {
      return degraded(count, exc)
    }
  }
  if (!(parsed.ok && parsed.draft)) {
    return degraded(count, new Error(parsed.errors.join(', ') || 'invalid_compaction_draft'))
  }
  let draft = parsed.draft
  if (needsScopeRepair(draft, opts.mode)) {
    try {
      const repairedText = await callCompactionModel(opts.model, `${scopeRepairPrompt()}\n\nInvalid draft:\n${draftText.slice(0, 12_000)}`, opts.tokenTracker)
      const repaired = parseCompactionDraft(repairedText)
      if (repaired.ok && repaired.draft && !needsScopeRepair(repaired.draft, opts.mode)) {
        draftText = repairedText
        draft = repaired.draft
      }
    } catch {
      // Deterministic routing below still protects memory scopes if repair cannot run.
    }
  }

  const compactionId = `compact_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const bundle = draftToBundle({
    draft,
    compactionId,
    sessionId: opts.sessionId,
    mode: opts.mode,
    projectId: opts.projectId ?? null,
    range: { fromSeq: range.fromSeq, toSeq: range.toSeq },
    snapshots,
    memory: opts.memory,
  })
  const input: CompactionRunRecord['input'] = {
    historyHash: sha256(projectedConversation),
    historyCount: rows.length,
    userProfileHash: memoryContentHash(snapshots.userProfile),
    globalMemoryHash: memoryContentHash(snapshots.globalMemory ?? ''),
    projectMemoryHash: snapshots.projectMemory === null || snapshots.projectMemory === undefined ? undefined : memoryContentHash(snapshots.projectMemory),
    episodeHash: memoryContentHash(snapshots.episode),
  }
  const committer = new CompactionPatchCommitter({
    root: opts.memory.root,
    memoryDir: opts.memory.memoryDir,
    userFile: opts.memory.userFile,
    versions: opts.memory.versions,
    cursorStore,
    ledger,
  })
  const committed = committer.commitBundle(bundle, {
    trigger,
    activeMemoryBinding: binding,
    input,
    allowBuildGlobalWrite: opts.mode !== 'build' || Boolean(bundle.patches.globalMemoryPatch),
  })
  if (!committed.ok) return degraded(count, new Error(committed.errors.join(', ') || 'compaction_commit_failed'))

  return {
    status: 'compacted',
    count,
    message: compactionMessage(compactedCount, range),
    compaction: {
      compactionId,
      mode: opts.mode,
      projectId: opts.projectId ?? null,
      range: { fromSeq: range.fromSeq, toSeq: range.toSeq },
      cursor: cursorStore.readOrInit(opts.sessionId),
      applied: committed.applied,
      discarded: bundle.discarded,
      decisions: bundle.decisions,
    },
  }
}

function countMessageRows(rows: Array<Record<string, unknown>>): number {
  return rows.filter((row) => 'role' in row && 'content' in row && row.type !== 'model_call').length
}

function compactionMessage(count: number, range: { stableBoundarySeq: number; keepTailFromSeq: number }): string {
  const tailKept = range.keepTailFromSeq <= range.stableBoundarySeq
  return tailKept
    ? `已压缩 ${count} 条稳定历史消息，保留最近未压缩上下文。`
    : `已压缩 ${count} 条稳定历史消息。`
}

async function callCompactionModel(
  model: ScopedCompactionModel,
  prompt: string,
  tokenTracker?: TokenTracker | null,
): Promise<string> {
  const response = await model.provider.chat({
    model: model.model,
    maxTokens: model.maxTokens,
    temperature: model.temperature,
    reasoningEffort: model.reasoningEffort ?? null,
    messages: [{ role: 'user', content: prompt }],
    tools: null,
  })
  if (tokenTracker && response.usage && Object.keys(response.usage).length) {
    tokenTracker.record(model.model, response.usage, {
      provider: model.providerName ?? null,
      usageType: 'memory_compaction',
      modelRole: model.modelRole ?? 'secondary',
      routeReason: model.routeReason ?? 'memory_compaction',
      estimatedInputTokens: Math.max(1, Math.trunc(prompt.length / 3)),
    })
  }
  return response.content ?? ''
}

function activeMemoryBinding(opts: {
  mode: 'chat' | 'build'
  projectId: string | null
  root: string
  memoryDir: string
  userFile: string
}): ActiveMemoryBinding {
  const date = todayUtc8()
  return {
    profile: {
      scope: { kind: 'user_profile' },
      readable: true,
      writable: true,
      path: opts.userFile,
    },
    longTerm: opts.mode === 'build' && opts.projectId
      ? {
        scope: { kind: 'project', projectId: opts.projectId },
        readable: true,
        writable: true,
        path: join(opts.root, 'projects', opts.projectId, 'AGENTS.local.md'),
      }
      : {
        scope: { kind: 'global' },
        readable: true,
        writable: true,
        path: join(opts.memoryDir, 'MEMORY.local.md'),
      },
    episode: {
      scope: { kind: 'episode', date },
      readable: false,
      writable: true,
      path: join(opts.memoryDir, `${date}.md`),
    },
  }
}

function draftToBundle(opts: {
  draft: CompactionDraft
  compactionId: string
  sessionId: string
  mode: 'chat' | 'build'
  projectId: string | null
  range: { fromSeq: number; toSeq: number }
  snapshots: { userProfile: string; globalMemory?: string | null; projectMemory?: string | null; episode: string }
  memory: ScopedCompactionMemory
}): CompactionPatchBundle {
  const routing = routeDraftDecisions(opts.draft, opts.mode, opts.projectId, opts.snapshots)
  const episodeScope: MemoryScope = { kind: 'episode', date: todayUtc8() }
  const userProfileScope: MemoryScope = { kind: 'user_profile' }
  const globalScope: MemoryScope = { kind: 'global' }
  const projectScope: MemoryScope | null = opts.projectId ? { kind: 'project', projectId: opts.projectId } : null
  const episodePatch = targetPatch(episodeScope, opts.memory, opts.snapshots.episode, opts.draft.episode, 'episode compaction')
  const userProfilePatch = targetPatch(userProfileScope, opts.memory, opts.snapshots.userProfile, opts.draft.userProfile, 'user profile compaction')
  const globalMemoryPatch = opts.mode !== 'build'
    ? targetPatch(globalScope, opts.memory, opts.snapshots.globalMemory ?? '', opts.draft.globalMemory ?? undefined, 'global memory compaction')
    : undefined
  const projectMemoryPatch = projectScope
    ? targetPatch(projectScope, opts.memory, opts.snapshots.projectMemory ?? '', opts.draft.projectMemory ?? undefined, 'project memory compaction')
    : undefined
  const patches = mergeRoutedPatches({
    episodePatch,
    userProfilePatch,
    globalMemoryPatch,
    projectMemoryPatch,
  }, routing.patches.map((patch) => withActualBaseVersion(patch, opts.memory)))
  return {
    compactionId: opts.compactionId,
    sessionId: opts.sessionId,
    mode: opts.mode,
    projectId: opts.projectId ?? undefined,
    range: opts.range,
    patches,
    decisions: opts.draft.decisions ?? [],
    discarded: [...(opts.draft.discarded ?? []), ...routing.discarded],
  }
}

function routeDraftDecisions(
  draft: CompactionDraft,
  mode: 'chat' | 'build',
  projectId: string | null,
  snapshots: { userProfile: string; globalMemory?: string | null; projectMemory?: string | null; episode: string },
): { patches: MemoryPatch[]; discarded: CompactionDraft['discarded'] } {
  const patches: MemoryPatch[] = []
  const discarded: CompactionDraft['discarded'] = []
  for (const decision of draft.decisions ?? []) {
    if (decision.destination !== 'global_memory' && decision.destination !== 'project_memory') continue
    const routingDecision = compactionRoutingDecision(decision, draft)
    const routed = mode === 'build'
      ? routeBuildDecision(routingDecision, {
        projectId: String(projectId ?? ''),
        projectMemory: snapshots.projectMemory ?? '',
        globalMemory: snapshots.globalMemory ?? '',
        userProfile: snapshots.userProfile,
      })
      : routeChatDecision(routingDecision, {
        projectId,
        projectMemory: snapshots.projectMemory ?? null,
        globalMemory: snapshots.globalMemory ?? '',
        userProfile: snapshots.userProfile,
      })
    for (const item of routed.discarded) {
      discarded.push({
        sourceSeqs: decision.sourceSeqs,
        summary: `Rejected ${decision.destination} write via scoped routing: ${decision.content} (${item.reason})`,
        reason: decision.confidence === 'low' ? 'low_confidence' : 'already_captured',
      })
    }
    for (const patch of routed.patches) {
      const routedDestination = scopeDestination(patch.target)
      if (routedDestination === decision.destination) {
        // Same-destination routing is normally already represented by the model's
        // target block. Build-mode global writes are the exception: the base bundle
        // omits globalMemory by default, so a vetted cross-project decision must be
        // added here without also recording a rejection.
        if (mode === 'build' && decision.destination === 'global_memory') patches.push(patch)
        continue
      }
      patches.push(patch)
      discarded.push({
        sourceSeqs: decision.sourceSeqs,
        summary: `Rejected ${decision.destination} write via scoped routing: ${decision.content} (routed_to_${routedDestination})`,
        reason: 'already_captured',
      })
    }
  }
  return { patches, discarded }
}

function mergeRoutedPatches(
  base: CompactionPatchBundle['patches'],
  routed: MemoryPatch[],
): CompactionPatchBundle['patches'] {
  let next = { ...base }
  for (const patch of routed) {
    if (patch.target.kind === 'episode') next = { ...next, episodePatch: mergePatch(next.episodePatch, patch) }
    else if (patch.target.kind === 'user_profile') next = { ...next, userProfilePatch: mergePatch(next.userProfilePatch, patch) }
    else if (patch.target.kind === 'global') next = { ...next, globalMemoryPatch: mergePatch(next.globalMemoryPatch, patch) }
    else if (patch.target.kind === 'project') next = { ...next, projectMemoryPatch: mergePatch(next.projectMemoryPatch, patch) }
  }
  return next
}

function mergePatch(existing: MemoryPatch | undefined, incoming: MemoryPatch): MemoryPatch {
  if (!existing) return incoming
  if (JSON.stringify(existing.target) !== JSON.stringify(incoming.target)) return existing
  return {
    ...existing,
    operations: [...existing.operations, ...incoming.operations],
    rationale: `${existing.rationale}; ${incoming.rationale}`,
  }
}

function compactionRoutingDecision(decision: CompactionDraft['decisions'][number], draft: CompactionDraft): CompactionMemoryDecision {
  return {
    kind: routingKind(decision),
    section: decisionSection(decision, draft),
    content: decision.content,
    confidence: decision.confidence,
    rationale: decision.reason,
    crossProjectLearning: decision.classification === 'cross_project_learning',
  }
}

function routingKind(decision: CompactionDraft['decisions'][number]): CompactionMemoryDecision['kind'] {
  if (decision.destination === 'user_profile') return 'user_preference'
  if (decision.destination === 'project_memory' || decision.classification.startsWith('project_')) return 'project_fact'
  if (decision.destination === 'global_memory') return 'global_fact'
  return 'episode_note'
}

function decisionSection(decision: CompactionDraft['decisions'][number], draft: CompactionDraft): string {
  if (decision.classification === 'project_command') return 'Build Commands'
  if (decision.classification === 'project_decision') return 'Design Decisions'
  if (decision.classification === 'project_open_task') return 'Open Tasks'
  if (decision.classification === 'project_fact') return 'Architecture Notes'
  const target = decision.destination === 'global_memory'
    ? draft.globalMemory
    : decision.destination === 'project_memory'
      ? draft.projectMemory
      : decision.destination === 'user_profile'
        ? draft.userProfile
        : draft.episode
  const op = target?.operations?.find((candidate) => overlaps(candidate.sourceSeqs, decision.sourceSeqs))
  if (op?.section) return op.section
  if (decision.destination === 'global_memory') return 'Cross-Project Decisions'
  if (decision.destination === 'project_memory') return 'Architecture Notes'
  if (decision.destination === 'user_profile') return 'Stable Preferences'
  return 'Summary'
}

function overlaps(a: number[], b: number[]): boolean {
  const seen = new Set(a.map((item) => Number(item)))
  return b.some((item) => seen.has(Number(item)))
}

function scopeDestination(scope: MemoryScope): CompactionDraft['decisions'][number]['destination'] {
  if (scope.kind === 'user_profile') return 'user_profile'
  if (scope.kind === 'global') return 'global_memory'
  if (scope.kind === 'project') return 'project_memory'
  if (scope.kind === 'episode') return 'episode'
  return 'discarded'
}

function needsScopeRepair(draft: CompactionDraft, mode: 'chat' | 'build'): boolean {
  if (mode !== 'build') return false
  const hasGlobalWrites = Boolean(draft.globalMemory?.operations?.length)
  if (!hasGlobalWrites) return false
  const globalDecisions = draft.decisions.filter((decision) => decision.destination === 'global_memory')
  if (!globalDecisions.length) return true
  return globalDecisions.some((decision) => decision.classification !== 'cross_project_learning' || decision.confidence === 'low')
}

function targetPatch(target: MemoryScope, memory: ScopedCompactionMemory, current: string, draftTarget: DraftTarget | null | undefined, rationale: string): MemoryPatch | undefined {
  const operations = (draftTarget?.operations ?? []).map(draftOperationToPatchOperation).filter((op): op is MemoryPatchOperation => Boolean(op))
  if (!operations.length) return undefined
  return {
    target,
    baseVersion: baseVersionForScope(target, memory),
    baseHash: memoryContentHash(current),
    operations,
    rationale,
  }
}

function withActualBaseVersion(patch: MemoryPatch, memory: ScopedCompactionMemory): MemoryPatch {
  return { ...patch, baseVersion: baseVersionForScope(patch.target, memory) }
}

function baseVersionForScope(scope: MemoryScope, memory: ScopedCompactionMemory): number {
  if (scope.kind === 'user_profile') return memory.versions.nextVersionForPath(memory.userFile, { target: 'user' })
  if (scope.kind === 'global') return memory.versions.nextVersionForPath(join(memory.memoryDir, 'MEMORY.local.md'), { target: 'memory' })
  if (scope.kind === 'episode') return memory.versions.nextVersionForPath(join(memory.memoryDir, `${scope.date}.md`), { target: 'episode' })
  if (scope.kind === 'project') return memory.versions.nextVersionForPath(join(memory.root, 'projects', scope.projectId, 'AGENTS.local.md'), { target: 'project' })
  return 1
}

function draftOperationToPatchOperation(op: DraftOperation): MemoryPatchOperation | null {
  if (op.op === 'append_section_item') {
    return { op: 'append_section_item', section: op.section, item: String(op.content ?? '').trimEnd() }
  }
  if (op.op === 'replace_section') {
    return { op: 'replace_section', section: op.section, content: String(op.content ?? '').trimEnd() }
  }
  if (op.op === 'mark_deprecated') {
    return { op: 'mark_deprecated', itemId: String(op.itemId ?? ''), reason: op.reason }
  }
  if (op.op === 'update_item') {
    return { op: 'update_item', itemId: String(op.itemId ?? ''), content: String(op.content ?? '').trimEnd() }
  }
  return null
}

function degraded(count: number, exc: unknown): ScopedCompactionResult {
  return {
    status: 'degraded',
    count,
    message: '记忆压缩失败，已保留当前会话历史。',
    error: String(exc instanceof Error ? exc.message : exc).slice(0, 500),
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}
