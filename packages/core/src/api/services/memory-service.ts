/**
 * CoreMemoryService: the CoreApi `memory.*` namespace on top of the harness
 * kernel. Durable memory (global MEMORY, episodes, project private memory,
 * versions), token analytics and the watchlist are file-backed stores kept
 * from the Emperor runtime; everything per-session (context explanation,
 * compaction state, message counts) is derived from the session log, the
 * single durable trajectory of a harness session.
 *
 * Retired with the old kernel: history.jsonl archives, runtime events.jsonl,
 * turn checkpoints, prompt snapshots, and history → memory consolidation
 * during `/compact` (compaction now only summarizes the session log).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import '../../harness/compaction/events'
import type { ContentBlock } from '../../llm/types'
import { buildMemoryArtifacts } from '../../memory/artifacts'
import {
  applyMemoryPatchToFile,
  memoryContentHash,
  type MemoryPatchOperation,
} from '../../memory/patch'
import type { MemoryStore } from '../../memory/store'
import type { TokenTracker } from '../../memory/token-tracker'
import {
  memoryVersionToDict,
  type MemoryVersionTarget,
} from '../../memory/versions'
import type { ProjectStore } from '../../projects/store'
import type { SchedulerService } from '../../scheduler/service'
import type { Session } from '../../session-log/session'
import { LOG_FILE } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { SessionStore } from '../../sessions/store'
import { relativePortableOrAbsolute } from '../../util/paths'
import type { WatchlistService } from '../../watchlist/service'

type Dict = Record<string, any>

export interface CoreContextMeasurement {
  totalTokens: number
  contextWindow?: number
}

export interface CoreMemoryServiceDeps {
  /** Emperor Home (`stateRoot`); relative paths in payloads resolve against it. */
  stateRoot: string
  sharedMemory: MemoryStore
  projectStore: ProjectStore
  tokenTracker: TokenTracker
  watchlist: WatchlistService
  sessionStore: SessionStore
  activeSessionId(): string | null
  /** The session's log (open or lazily restored); undefined when it has none. */
  sessionLog(sessionId: string): Session | undefined
  /** Manual compaction of one session's log (`HarnessHost.compactNow`). */
  compactNow(
    sessionId: string,
  ): Promise<{ compacted: boolean; shadowedTokenCount?: number }>
  /** Current request pressure of one session (`CompactionEngine.measure` + context window). */
  measureContext(sessionId: string): CoreContextMeasurement | null
  refreshRuntimeContext(): void
  /** Optional: protected-job summary in the memory payload. */
  schedulerService?: Pick<SchedulerService, 'listJobs'> | null
}

export type CoreMemoryPayload = ReturnType<CoreMemoryService['getMemory']>

export interface CoreHistoryAttachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'document' | 'text'
  hasText: boolean
  hasImage: boolean
  path: string
  textPath?: string | null
}

export interface CoreHistoryItem {
  role: 'user' | 'assistant'
  content: string
  attachments?: CoreHistoryAttachment[]
  turn_id?: string
  source?: string
  ui_hidden?: boolean
  requestedSkills?: Array<{ name: string; source?: string }>
}

/** Session-log stats in the legacy `RuntimeStats` shape (archive keys neutral). */
export interface CoreSessionLogStats {
  path: string
  bytes: number
  events: number
  latestSeq: number
  latestTs: number | null
  activeTurnEvents: number
  activeTurns: number
  archiveFiles: number
  archiveBytes: number
  archives: Array<{ path: string; bytes: number; updatedAt?: number }>
  lastArchiveAt: number | null
  needsRotation: boolean
}

export interface CoreCompactionCursor {
  sessionId: string
  compactedUntilSeq: number
  archivedUntilSeq: number
  status: 'active'
  lastCompactionId: string | null
}

export interface CoreCompactionSummary {
  compactionId: string
  range: { fromSeq: number | null; toSeq: number | null }
  shadowedTokenCount: number
  provider: string | null
  model: string | null
  cursor: CoreCompactionCursor
  applied: Dict[]
  discarded: Dict[]
}

export interface CoreCompactPayload {
  status: 'compacted' | 'skipped' | 'degraded'
  count: number
  message: string
  memory: CoreMemoryPayload
  unarchivedHistory: CoreHistoryItem[]
  runtime?: CoreSessionLogStats
  compaction?: CoreCompactionSummary
  error?: string
}

const CONSOLIDATION_RETIRED =
  '记忆整理（从会话历史写入 MEMORY / episode）已随旧内核退役，请通过 memory 工具或记忆面板维护长期记忆。'

export class CoreMemoryService {
  readonly root: string
  private readonly deps: CoreMemoryServiceDeps

  constructor(deps: CoreMemoryServiceDeps) {
    this.root = resolve(deps.stateRoot)
    this.deps = deps
  }

  private get memory(): MemoryStore {
    return this.deps.sharedMemory
  }

  getMemory() {
    const memoryDir = this.memory.memoryDir
    const episodes = existsSync(memoryDir)
      ? readdirSync(memoryDir)
          .filter((name) => isEpisodeFilename(name))
          .sort()
          .map((name) => this.rel(join(memoryDir, name)))
      : []
    const sessionId = this.deps.activeSessionId()
    const session = sessionId ? this.deps.sessionLog(sessionId) : undefined
    const tracker = this.deps.tokenTracker
    return {
      long_term: this.memory.readMemory(),
      today_episode: this.memory.readTodayEpisode(),
      episodes,
      context: this.contextPayload(sessionId),
      projects: this.deps.projectStore.list(),
      tokens: tracker.statsByDate(),
      tokensByModel: tracker.statsByProviderModel(),
      tokensByUsageType: tracker.statsByUsageType(),
      tokenTotals: tracker.totals(),
      history: this.historyStats(sessionId, session),
      runtime: this.sessionLogStats(sessionId, session),
      compaction: sessionId
        ? this.compactionExplanation(sessionId, session)
        : null,
      schedulerMaintenance: this.schedulerMaintenance(),
      watchlist: this.deps.watchlist.payload(),
      versions: this.memory.versions.payload({ limit: 30 }),
    }
  }

  /**
   * Bootstrap `unarchivedHistory`. The UI restores the transcript from the
   * session log replay now, so there is no history to hand over.
   */
  historyPayload(): CoreHistoryItem[] {
    return []
  }

  saveMemory(content: string) {
    const normalized = `${String(content || '').trimEnd()}\n`
    const operations = markdownSectionReplacementOps(normalized)
    if (!operations.length)
      throw new Error('save_memory requires at least one ## section')
    const current = this.memory.readMemory()
    const result = applyMemoryPatchToFile(
      {
        target: { kind: 'global' },
        baseVersion: this.memory.versions.nextVersionForPath(
          this.memory.memoryFile,
          { target: 'memory' },
        ),
        baseHash: memoryContentHash(current),
        operations,
        rationale: 'save_global_memory',
      },
      {
        targetPath: this.memory.memoryFile,
        versions: this.memory.versions,
        versionTarget: 'memory',
        ledgerPath: join(this.memory.memoryDir, 'patch-ledger.jsonl'),
        explicitReplace: true,
      },
    )
    if (!result.ok)
      throw new Error(`save_memory rejected: ${result.errors.join(', ')}`)
    this.deps.refreshRuntimeContext()
    return {
      path: this.rel(this.memory.memoryFile),
      content: this.memory.readMemory(),
    }
  }

  getEpisode(date: string) {
    const safe = validateEpisodeDate(date)
    const path = join(this.memory.memoryDir, `${safe}.md`)
    if (!existsSync(path)) throw new Error(`Episode not found: ${safe}`)
    return { date: safe, content: readFileSync(path, 'utf8') }
  }

  saveEpisode(content: string, date: string) {
    const safe = validateEpisodeDate(date)
    const path = join(this.memory.memoryDir, `${safe}.md`)
    mkdirSync(this.memory.memoryDir, { recursive: true })
    if (existsSync(path))
      this.memory.versions.snapshotPath(path, {
        target: 'episode',
        reason: 'webui_save_episode',
      })
    writeFileSync(path, `${String(content || '').trimEnd()}\n`, 'utf8')
    return this.getEpisode(safe)
  }

  listVersions(opts: { limit?: number; target?: string | null } = {}) {
    const target = normalizeVersionTarget(opts.target ?? null)
    const versions = this.memory.versions.list({
      limit: opts.limit ?? 80,
      target,
    })
    return {
      versions: versions.map(memoryVersionToDict),
      count: this.memory.versions.list({ limit: 10000 }).length,
    }
  }

  getVersion(versionId: string) {
    return this.memory.versions.detail(versionId)
  }

  restoreVersion(versionId: string) {
    const restored = this.memory.versions.restore(versionId)
    this.deps.refreshRuntimeContext()
    return { restored, memory: this.getMemory() }
  }

  getWatchlist(): Dict {
    return this.deps.watchlist.payload()
  }

  saveWatchlist(content: string): Dict {
    return this.deps.watchlist.write(content)
  }

  async checkWatchlist() {
    const watchlist = this.deps.watchlist
    const decision = await watchlist.check()
    return { decision: decision.toDict(), watchlist: watchlist.payload() }
  }

  tokens() {
    const tracker = this.deps.tokenTracker
    return {
      totals: tracker.totals(),
      byDate: tracker.statsByDate(),
      byModel: tracker.statsByProviderModel(),
      byUsageType: tracker.statsByUsageType(),
      byDateModel: tracker.statsByDateModel(),
      byHour: tracker.statsByHour(),
      streak: tracker.streakMetrics(),
      sessions: tracker.sessionCount(),
      messages: this.countActiveMessages(),
      recentCalls: tracker.recentCalls(),
      recentCacheCalls: tracker.recentCacheCalls(),
      generatedAt: localIsoSeconds(),
    }
  }

  /**
   * Manual compaction of the session log. `force` and `instructions` are
   * accepted for API compatibility; the harness compacts the head-anchored
   * range on demand and has no instruction channel.
   */
  async compact(
    opts: {
      force?: boolean
      sessionId?: string | null
      instructions?: string | null
    } = {},
  ): Promise<CoreCompactPayload> {
    const sessionId = String(
      opts.sessionId ?? this.deps.activeSessionId() ?? '',
    ).trim()
    const entry = sessionId ? this.deps.sessionStore.get(sessionId) : null
    if (!entry) throw new Error('session is required for compaction')
    const before = this.deps.sessionLog(sessionId)
    const count = before ? surfaceCounts(before).messages : 0
    if (count < 2) {
      return {
        status: 'skipped',
        count,
        message: `会话上下文不足 2 条消息，无需压缩。${CONSOLIDATION_RETIRED}`,
        memory: this.getMemory(),
        unarchivedHistory: [],
      }
    }
    let result: { compacted: boolean; shadowedTokenCount?: number }
    try {
      result = await this.deps.compactNow(sessionId)
    } catch (exc) {
      return {
        status: 'degraded',
        count,
        message: '会话压缩失败，已保留当前会话上下文。',
        memory: this.getMemory(),
        unarchivedHistory: [],
        error: String(exc instanceof Error ? exc.message : exc).slice(0, 500),
      }
    }
    this.deps.refreshRuntimeContext()
    const session = this.deps.sessionLog(sessionId)
    const runtime = this.sessionLogStats(sessionId, session)
    if (!result.compacted) {
      return {
        status: 'skipped',
        count,
        message: `当前上下文没有可压缩的范围。${CONSOLIDATION_RETIRED}`,
        memory: this.getMemory(),
        unarchivedHistory: [],
        runtime,
      }
    }
    const latest = session ? latestCompaction(session) : null
    const tokens = result.shadowedTokenCount ?? latest?.shadowedTokenCount ?? 0
    return {
      status: 'compacted',
      count,
      message: `已将较早的会话上下文压缩为摘要（约 ${tokens} tokens）。${CONSOLIDATION_RETIRED}`,
      memory: this.getMemory(),
      unarchivedHistory: [],
      runtime,
      compaction: {
        compactionId: latest?.compactionId ?? '',
        range: latest?.range ?? { fromSeq: null, toSeq: null },
        shadowedTokenCount: tokens,
        provider: latest?.provider ?? null,
        model: latest?.model ?? null,
        cursor: compactionCursor(sessionId, session),
        applied: [],
        discarded: [],
      },
    }
  }

  explainContext(
    opts: { sessionId?: string | null; turnId?: string | null } = {},
  ) {
    const sessionId = String(
      opts.sessionId ?? this.deps.activeSessionId() ?? '',
    ).trim()
    if (!sessionId) {
      return {
        status: 'missing_session',
        sessionId: null,
        turnId: opts.turnId ?? null,
        reason: 'no active or requested session',
      }
    }
    const session = this.deps.sessionLog(sessionId)
    const checkpoint = retiredCheckpoint()
    const compaction = this.compactionExplanation(sessionId, session)
    const artifacts = this.memoryArtifacts(sessionId)
    const microcompact = session
      ? pruneSummary(session)
      : { records: [], omittedChars: 0, omittedTokens: 0 }
    if (!session) {
      return {
        status: 'missing_snapshot',
        sessionId,
        turnId: opts.turnId ?? null,
        reason: 'session log not found',
        checkpoint,
        compaction,
        artifacts,
        microcompact,
      }
    }
    const entry = this.deps.sessionStore.get(sessionId)
    const requestContext = session.requestContext()
    const header = session.requestHeader()
    const measurement = this.deps.measureContext(sessionId)
    const counts = surfaceCounts(session)
    const lastContext = session.lastOf('request/context')
    return {
      status: 'ok',
      sessionId,
      turnId: String(opts.turnId ?? lastTurn(session) ?? ''),
      mode: entry?.mode === 'build' ? 'build' : 'chat',
      model: requestContext?.model ?? header?.config.model ?? null,
      provider: requestContext?.provider ?? header?.config.provider ?? null,
      modelEntryId: null,
      estimatedInputTokens: measurement?.totalTokens ?? null,
      contextWindow:
        measurement?.contextWindow ?? requestContext?.contextWindow ?? null,
      activeMemoryBinding: entry?.project_id
        ? { kind: 'project', projectId: String(entry.project_id) }
        : { kind: 'global' },
      injected: contextInjections(session),
      omitted: [],
      sections: headerSections(header),
      surface: counts,
      checkpoint,
      compaction,
      artifacts,
      microcompact,
      snapshot: {
        createdAt: lastContext?.time ?? null,
        totals: {
          events: session.seq,
          surfaceNodes: counts.nodes,
          estimatedTokens: measurement?.totalTokens ?? null,
        },
      },
    }
  }

  private logPath(sessionId: string): string {
    return join(this.deps.sessionStore.sessionDir(sessionId), LOG_FILE)
  }

  private historyStats(
    sessionId: string | null,
    session: Session | undefined,
  ): Dict {
    const bytes = sessionId ? fileBytes(this.logPath(sessionId)) : 0
    return {
      version: 2,
      latest_seq: session ? Math.max(0, session.seq - 1) : 0,
      active_lines: session ? surfaceCounts(session).nodes : 0,
      active_bytes: bytes,
      archive_files: 0,
      archive_bytes: 0,
      archives: [],
      last_archive_at: null,
      migrated_at: null,
      hot_limit_lines: 0,
      hot_limit_bytes: 0,
      needs_rotation: false,
    }
  }

  private sessionLogStats(
    sessionId: string | null,
    session: Session | undefined,
  ): CoreSessionLogStats {
    const path = sessionId ? this.logPath(sessionId) : ''
    const last = session?.events.at(-1)
    return {
      path: path ? this.rel(path) : '',
      bytes: path ? fileBytes(path) : 0,
      events: session?.seq ?? 0,
      latestSeq: session ? Math.max(0, session.seq - 1) : 0,
      latestTs: last?.time ?? null,
      activeTurnEvents: session ? openTurnEvents(session) : 0,
      activeTurns: session?.hasOpenTurn() ? 1 : 0,
      archiveFiles: 0,
      archiveBytes: 0,
      archives: [],
      lastArchiveAt: null,
      needsRotation: false,
    }
  }

  private compactionExplanation(
    sessionId: string,
    session: Session | undefined,
  ): Dict {
    const cursor = compactionCursor(sessionId, session)
    const latest = session ? latestCompaction(session) : null
    return {
      cursor,
      archive: {
        compactedUntilSeq: cursor.compactedUntilSeq,
        archivedUntilSeq: cursor.archivedUntilSeq,
        archiveBlockedUntilCompacted: false,
      },
      omittedRanges:
        latest && latest.status === 'applied'
          ? [
              {
                fromSeq: latest.range.fromSeq,
                toSeq: latest.range.toSeq,
                compactionId: latest.compactionId,
                reason: 'session_log_compaction',
              },
            ]
          : [],
      latest,
      count: session ? countCompactions(session) : 0,
    }
  }

  private memoryArtifacts(sessionId: string): Dict[] {
    const entry = this.deps.sessionStore.get(sessionId)
    const projectId = String(entry?.project_id ?? '').trim()
    const project = projectId ? this.deps.projectStore.get(projectId) : null
    return buildMemoryArtifacts({
      stateRoot: this.root,
      memoryDir: this.memory.memoryDir,
      userFile: this.memory.userFile,
      sessionId,
      historyFile: this.logPath(sessionId),
      projectId: project?.project_id ?? null,
      projectMemoryPath: project?.agents_path ?? null,
      episodeDate: new Date(Date.now() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    }) as unknown as Dict[]
  }

  private contextPayload(sessionId: string | null): Dict {
    const session = sessionId ? this.deps.sessionStore.get(sessionId) : null
    const mode = String(session?.mode || 'chat')
    const projectId = String(session?.project_id || '')
    const projects = this.deps.projectStore
    const project = projectId ? projects.get(projectId) : null
    const sources = [
      'templates/agent/persona.md',
      'memory/profile/USER.local.md',
    ]
    const sourceMap: Dict[] = [
      {
        domain: 'prompt',
        kind: 'persona',
        path: 'templates/agent/persona.md',
        scope: 'global',
      },
      {
        domain: 'memory',
        kind: 'user_profile',
        path: this.memory.userFile,
        scope: 'global',
      },
    ]
    if (sessionId) {
      sourceMap.push({
        domain: 'session',
        kind: 'session_log',
        path: this.logPath(sessionId),
        sessionId,
      })
    }
    if (mode === 'build') {
      sources.push(
        '全局私有项目记忆 (AGENTS.local.md)',
        'Workspace AGENTS.md/.emperor rules (只读协作上下文)',
      )
      if (project) {
        sources.push(project.agents_path)
        sourceMap.push({
          domain: 'project',
          kind: 'private_memory',
          projectId: project.project_id,
          path: project.agents_path,
          statePath: project.state_path,
          workspacePath: project.workspace_path || project.project_path,
          legacyAgentsPath: project.legacy_agents_path,
          legacyImportedAt: project.legacy_imported_at,
        })
      }
    } else {
      sources.push('memory/MEMORY.local.md', 'projects/index.json')
      sourceMap.push(
        {
          domain: 'memory',
          kind: 'global_memory',
          path: this.memory.memoryFile,
          scope: 'global',
        },
        {
          domain: 'project',
          kind: 'index_summary',
          path: projects.indexPath,
          scope: 'chat',
        },
      )
    }
    return {
      mode,
      session,
      sources,
      sourceMap,
      project,
      projectIndexSummary: projects.summaryForChat(),
      projectMemory: projectId ? projects.readManagedMemory(projectId) : '',
    }
  }

  private schedulerMaintenance(): Dict {
    const jobs = (
      this.deps.schedulerService?.listJobs({ includeDisabled: true }) ?? []
    ).filter((job) => job.protected)
    const nextRuns = jobs
      .filter((job) => job.enabled && job.state.next_run_at_ms)
      .map((job) => job.state.next_run_at_ms!)
    return {
      jobs: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
      nextRunAtMs: nextRuns.length ? Math.min(...nextRuns) : null,
      lastError:
        jobs.find(
          (job) => job.state.last_status === 'error' && job.state.last_error,
        )?.state.last_error ?? null,
    }
  }

  /** User prompts + assistant replies in the active session's log. */
  private countActiveMessages(): number {
    const sessionId = this.deps.activeSessionId()
    const session = sessionId ? this.deps.sessionLog(sessionId) : undefined
    if (!session) return 0
    let count = 0
    for (const event of session.events) {
      if (event.type === 'assistant/message') count += 1
      else if (
        event.type === 'user/message' &&
        event.data.source.kind === 'user'
      )
        count += 1
    }
    return count
  }

  private rel(path: string): string {
    return relativePortableOrAbsolute(this.root, path)
  }
}

interface LatestCompaction {
  compactionId: string
  status: 'applied' | 'failed' | 'running'
  mode: 'session_log'
  projectId: null
  trigger: { kind: 'manual' | 'turn'; turn: number | null } | null
  range: { fromSeq: number | null; toSeq: number | null }
  shadowedTokenCount: number
  provider: string | null
  model: string | null
  patchTargets: Dict[]
  discardedCount: number
  discarded: Dict[]
  decisions: Dict[]
  error: { message: string } | null
}

function latestCompaction(session: Session): LatestCompaction | null {
  const start = session.lastOf('compaction/start')
  if (!start) return null
  const id = start.data.compactionId
  let summary: SessionEvent<'compaction/summary'> | undefined
  let end: SessionEvent<'compaction/end'> | undefined
  for (const event of session.events.slice(start.seq)) {
    if (event.type === 'compaction/summary' && event.data.compactionId === id)
      summary = event
    else if (event.type === 'compaction/end' && event.data.compactionId === id)
      end = event
  }
  const seqs = summary?.data.shadowedSeqs ?? []
  const error = end?.data.error
  return {
    compactionId: id,
    status: !end ? 'running' : error ? 'failed' : 'applied',
    mode: 'session_log',
    projectId: null,
    trigger: {
      kind: start.data.turn === null ? 'manual' : 'turn',
      turn: start.data.turn,
    },
    range: {
      fromSeq: seqs.length ? Math.min(...seqs) : null,
      toSeq: seqs.length ? Math.max(...seqs) : null,
    },
    shadowedTokenCount: summary?.data.shadowedTokenCount ?? 0,
    provider: summary?.data.provider ?? null,
    model: summary?.data.model ?? null,
    patchTargets: [],
    discardedCount: 0,
    discarded: [],
    decisions: [],
    error: error ? { message: error } : null,
  }
}

function countCompactions(session: Session): number {
  let count = 0
  for (const event of session.events) {
    if (event.type === 'compaction/end' && !event.data.error) count += 1
  }
  return count
}

/** Legacy cursor shape: `compactedUntilSeq` = last event seq shadowed by an applied compaction. */
function compactionCursor(
  sessionId: string,
  session: Session | undefined,
): CoreCompactionCursor {
  let compactedUntilSeq = 0
  let lastCompactionId: string | null = null
  const applied = new Set<string>()
  if (session) {
    for (const event of session.events) {
      if (event.type === 'compaction/end' && !event.data.error)
        applied.add(event.data.compactionId)
    }
    for (const event of session.events) {
      if (
        event.type !== 'compaction/summary' ||
        !applied.has(event.data.compactionId)
      )
        continue
      lastCompactionId = event.data.compactionId
      for (const seq of event.data.shadowedSeqs)
        compactedUntilSeq = Math.max(compactedUntilSeq, seq)
    }
  }
  return {
    sessionId,
    compactedUntilSeq,
    archivedUntilSeq: 0,
    status: 'active',
    lastCompactionId,
  }
}

function surfaceCounts(session: Session): {
  nodes: number
  messages: number
  user: number
  assistant: number
  toolResults: number
  context: number
} {
  const counts = {
    nodes: 0,
    messages: 0,
    user: 0,
    assistant: 0,
    toolResults: 0,
    context: 0,
  }
  const events = session.events
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (!event) continue
    counts.nodes += 1
    if (event.type === 'assistant/message') {
      counts.assistant += 1
      counts.messages += 1
    } else if (event.type === 'tool/result') {
      counts.toolResults += 1
    } else if (event.type === 'user/message') {
      if (event.data.source.kind === 'context') counts.context += 1
      else {
        counts.user += 1
        counts.messages += 1
      }
    }
  }
  return counts
}

/** Harness context messages currently on the surface, in the legacy `injected` item shape. */
function contextInjections(session: Session): Dict[] {
  const events = session.events
  const out: Dict[] = []
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'context') continue
    const charCount = contentChars(event.data.content)
    out.push({
      id: event.data.id,
      kind: source.form ?? 'context',
      source: source.producer,
      action: 'include',
      reason: source.summary ?? '',
      priority: null,
      hash: null,
      charCount,
      tokenEstimate: Math.ceil(charCount / 4),
      seq,
    })
  }
  return out
}

function headerSections(header: ReturnType<Session['requestHeader']>): Dict[] {
  if (!header) return []
  const sections: Dict[] = []
  if (header.system !== undefined) {
    sections.push({
      id: 'system',
      charCount: header.system.length,
      tokenEstimate: Math.ceil(header.system.length / 4),
    })
  }
  if (header.tools?.length) {
    const chars = JSON.stringify(header.tools).length
    sections.push({
      id: 'tools',
      count: header.tools.length,
      charCount: chars,
      tokenEstimate: Math.ceil(chars / 4),
    })
  }
  return sections
}

function pruneSummary(session: Session): {
  records: Dict[]
  omittedChars: number
  omittedTokens: number
} {
  const records: Dict[] = []
  let omittedTokens = 0
  for (const event of session.events) {
    if (event.type !== 'compaction/prune') continue
    records.push({
      seq: event.seq,
      shadowedSeqs: [...event.data.shadowedSeqs],
      shadowedTokenCount: event.data.shadowedTokenCount,
    })
    omittedTokens += event.data.shadowedTokenCount
  }
  return { records, omittedChars: 0, omittedTokens }
}

function retiredCheckpoint(): Dict {
  return {
    exists: false,
    recoverable: false,
    historyRows: 0,
    status: 'retired',
    reason:
      'turn checkpoints are retired; the session log is the durable trajectory',
  }
}

function lastTurn(session: Session): number | null {
  return session.lastOf('turn/start')?.data.turn ?? null
}

function openTurnEvents(session: Session): number {
  if (!session.hasOpenTurn()) return 0
  const start = session.lastOf('turn/start')
  return start ? session.seq - start.seq : 0
}

function contentChars(content: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of content) {
    chars +=
      block.type === 'text' ? block.text.length : JSON.stringify(block).length
  }
  return chars
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function validateEpisodeDate(date: string): string {
  const safe = String(date || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(safe)
  if (!match) throw new Error('episode date must be YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('episode date must be YYYY-MM-DD')
  }
  return safe
}

function isEpisodeFilename(name: string): boolean {
  if (basename(name) !== name || !name.endsWith('.md')) return false
  try {
    validateEpisodeDate(name.slice(0, -3))
    return true
  } catch {
    return false
  }
}

function normalizeVersionTarget(
  target: string | null,
): MemoryVersionTarget | null {
  if (!target) return null
  if (
    target === 'memory' ||
    target === 'user' ||
    target === 'episode' ||
    target === 'project'
  )
    return target
  throw new Error('Invalid version target')
}

function markdownSectionReplacementOps(
  markdown: string,
): MemoryPatchOperation[] {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const ops: MemoryPatchOperation[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (!match) continue
    const section = match[1]!.trim()
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+\S/.test(lines[cursor] ?? '')) {
        end = cursor
        break
      }
    }
    ops.push({
      op: 'replace_section',
      section,
      content: lines
        .slice(index + 1, end)
        .join('\n')
        .trimEnd(),
    })
  }
  return ops
}

function localIsoSeconds(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
