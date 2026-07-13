import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AgentLoop } from '../../agent/loop'
import {
  CompactionCursorStore,
  CompactionLedger,
  latestAppliedCompactionRun,
} from '../../memory/compaction-ledger'
import {
  compactSession,
  type ScopedCompactionResult,
} from '../../memory/compaction-service'
import {
  memoryVersionToDict,
  type MemoryVersionTarget,
} from '../../memory/versions'
import { buildMemoryArtifacts } from '../../memory/artifacts'
import {
  applyMemoryPatchToFile,
  memoryContentHash,
  type MemoryPatchOperation,
} from '../../memory/patch'
import { readTurnCheckpoint } from '../../sessions/checkpoint'
import type { WatchlistService } from '../../watchlist/service'
import type { RuntimeStats } from '../../runtime/store'
import { relativePortableOrAbsolute } from '../../util/paths'

type Dict = Record<string, any>

export interface CoreMemoryServiceDeps {
  loop: AgentLoop
  watchlist: WatchlistService
  refreshRuntimeContext?: () => void
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

export interface CoreCompactPayload {
  status: 'compacted' | 'skipped' | 'degraded'
  count: number
  message: string
  memory: CoreMemoryPayload
  unarchivedHistory: CoreHistoryItem[]
  runtime?: RuntimeStats
  compaction?: ScopedCompactionResult['compaction']
  error?: string
}

export class CoreMemoryService {
  readonly root: string
  private readonly loop: AgentLoop
  private readonly watchlist: WatchlistService
  private readonly refreshRuntimeContext?: () => void

  constructor(root: string, deps: CoreMemoryServiceDeps) {
    this.root = resolve(root)
    this.loop = deps.loop
    this.watchlist = deps.watchlist
    this.refreshRuntimeContext = deps.refreshRuntimeContext
  }

  getMemory() {
    const memoryDir = join(this.root, 'memory')
    const episodes = existsSync(memoryDir)
      ? readdirSync(memoryDir)
          .filter((name) => isEpisodeFilename(name))
          .sort()
          .map((name) => this.rel(join(memoryDir, name)))
      : []
    const turnIds = this.loop.activeMemoryStore.loadUnarchivedTurnIds()
    return {
      long_term: this.loop.sharedMemory.readMemory(),
      today_episode: this.loop.sharedMemory.readTodayEpisode(),
      episodes,
      context: this.contextPayload(),
      projects: this.loop.projectStore.list(),
      tokens: this.loop.tokenTracker.statsByDate(),
      tokensByModel: this.loop.tokenTracker.statsByProviderModel(),
      tokensByUsageType: this.loop.tokenTracker.statsByUsageType(),
      tokenTotals: this.loop.tokenTracker.totals(),
      history: this.loop.activeMemoryStore.historyStats(),
      runtime: this.loop.runtimeStore.stats({ activeTurnIds: turnIds }),
      compaction: this.loop.activeSessionId
        ? this.compactionExplanation(this.loop.activeSessionId)
        : null,
      schedulerMaintenance: this.schedulerMaintenance(),
      watchlist: this.watchlist.payload(),
      versions: this.loop.sharedMemory.versions.payload({ limit: 30 }),
    }
  }

  historyPayload(): CoreHistoryItem[] {
    return this.loop.activeMemoryStore
      .loadUnarchivedHistory()
      .map(historyItemFromRow)
      .filter((item): item is CoreHistoryItem => item !== null)
  }

  saveMemory(content: string) {
    const normalized = `${String(content || '').trimEnd()}\n`
    const operations = markdownSectionReplacementOps(normalized)
    if (!operations.length)
      throw new Error('save_memory requires at least one ## section')
    const current = this.loop.sharedMemory.readMemory()
    const result = applyMemoryPatchToFile(
      {
        target: { kind: 'global' },
        baseVersion: this.loop.sharedMemory.versions.nextVersionForPath(
          this.loop.sharedMemory.memoryFile,
          { target: 'memory' },
        ),
        baseHash: memoryContentHash(current),
        operations,
        rationale: 'save_global_memory',
      },
      {
        targetPath: this.loop.sharedMemory.memoryFile,
        versions: this.loop.sharedMemory.versions,
        versionTarget: 'memory',
        ledgerPath: join(this.root, 'memory', 'patch-ledger.jsonl'),
        explicitReplace: true,
      },
    )
    if (!result.ok)
      throw new Error(`save_memory rejected: ${result.errors.join(', ')}`)
    this.refreshRuntimeContext?.()
    return {
      path: 'memory/MEMORY.local.md',
      content: this.loop.sharedMemory.readMemory(),
    }
  }

  getEpisode(date: string) {
    const safe = validateEpisodeDate(date)
    const path = join(this.root, 'memory', `${safe}.md`)
    if (!existsSync(path)) throw new Error(`Episode not found: ${safe}`)
    return { date: safe, content: readFileSync(path, 'utf8') }
  }

  saveEpisode(content: string, date: string) {
    const safe = validateEpisodeDate(date)
    const path = join(this.root, 'memory', `${safe}.md`)
    mkdirSync(join(this.root, 'memory'), { recursive: true })
    if (existsSync(path))
      this.loop.sharedMemory.versions.snapshotPath(path, {
        target: 'episode',
        reason: 'webui_save_episode',
      })
    writeFileSync(path, `${String(content || '').trimEnd()}\n`, 'utf8')
    return this.getEpisode(safe)
  }

  listVersions(opts: { limit?: number; target?: string | null } = {}) {
    const target = normalizeVersionTarget(opts.target ?? null)
    const versions = this.loop.sharedMemory.versions.list({
      limit: opts.limit ?? 80,
      target,
    })
    return {
      versions: versions.map(memoryVersionToDict),
      count: this.loop.sharedMemory.versions.list({ limit: 10000 }).length,
    }
  }

  getVersion(versionId: string) {
    return this.loop.sharedMemory.versions.detail(versionId)
  }

  restoreVersion(versionId: string) {
    const restored = this.loop.sharedMemory.versions.restore(versionId)
    this.refreshRuntimeContext?.()
    return { restored, memory: this.getMemory() }
  }

  getWatchlist(): Dict {
    return this.watchlist.payload()
  }

  saveWatchlist(content: string): Dict {
    return this.watchlist.write(content)
  }

  async checkWatchlist() {
    ;(this.watchlist as unknown as { modelRouter: unknown }).modelRouter =
      this.loop.modelRouter
    const decision = await this.loop.activeTasks.run({
      taskId: 'watchlist:manual-check',
      kind: 'watchlist',
      label: 'Watchlist manual check',
      awaitable: this.watchlist.check(),
    })
    return { decision: decision.toDict(), watchlist: this.watchlist.payload() }
  }

  tokens() {
    const tracker = this.loop.tokenTracker
    return {
      totals: tracker.totals(),
      byDate: tracker.statsByDate(),
      byModel: tracker.statsByProviderModel(),
      byUsageType: tracker.statsByUsageType(),
      byDateModel: tracker.statsByDateModel(),
      byHour: tracker.statsByHour(),
      streak: tracker.streakMetrics(),
      sessions: tracker.sessionCount(),
      messages: this.countHistoryMessages(),
      recentCalls: tracker.recentCalls(),
      recentCacheCalls: tracker.recentCacheCalls(),
      generatedAt: localIsoSeconds(),
    }
  }

  async compact(opts: { force?: boolean } = {}): Promise<CoreCompactPayload> {
    const rawUnarchivedHistory =
      this.loop.activeMemoryStore.loadUnarchivedHistory()
    const unarchivedHistory = rawUnarchivedHistory
      .map(historyItemFromRow)
      .filter((item): item is CoreHistoryItem => item !== null)
    const count = rawUnarchivedHistory.length
    if (count < 2) {
      return {
        status: 'skipped',
        count,
        message: '未归档消息不足 2 条，无需压缩。',
        memory: this.getMemory(),
        unarchivedHistory,
      }
    }

    const hookScope = await this.loop.beginCompactionHooks('manual')
    if (!hookScope.allowed) {
      return {
        status: 'skipped',
        count,
        message: `Compaction deferred by hook: ${hookScope.reason}`,
        memory: this.getMemory(),
        unarchivedHistory,
      }
    }

    const route = this.loop.modelRouter.route('memory_compaction')
    const snapshot = route.snapshot
    const sessionId = this.loop.activeSessionId || 'default'
    const mode = this.loop.activeSession?.mode === 'build' ? 'build' : 'chat'
    const projectId =
      mode === 'build'
        ? String(this.loop.activeSession?.project_id || '')
        : null
    let result: Awaited<ReturnType<typeof compactSession>>
    try {
      result = await compactSession({
        sessionId,
        mode,
        projectId,
        historyFile: this.loop.activeMemoryStore.historyFile,
        trigger: opts.force
          ? { kind: 'manual', force: true }
          : { kind: 'manual' },
        memory: {
          root: this.loop.paths.stateRoot,
          memoryDir: this.loop.sharedMemory.memoryDir,
          userFile: this.loop.sharedMemory.userFile,
          versions: this.loop.sharedMemory.versions,
          readUser: () => this.loop.sharedMemory.readUser(),
          readGlobalMemory: () => this.loop.sharedMemory.readMemory(),
          readEpisode: () => this.loop.sharedMemory.readTodayEpisode(),
          readProjectMemory: (id: string) =>
            this.loop.projectStore.readManagedMemory(id),
        },
        model: {
          provider: snapshot.provider,
          model: snapshot.model,
          providerName: snapshot.providerName,
          modelRole: snapshot.modelRole,
          maxTokens: snapshot.generation.maxTokens,
          temperature: snapshot.generation.temperature,
          reasoningEffort: snapshot.generation.reasoningEffort,
          routeReason: snapshot.routeReason,
        },
        tokenTracker: this.loop.tokenTracker,
        instructions: hookScope.instructions,
      })
    } catch (exc) {
      await this.loop.finishCompactionHooks(hookScope, {
        status: 'failed',
        error: String(exc instanceof Error ? exc.message : exc),
      })
      return this.compactionFailed(count, unarchivedHistory, exc)
    }
    if (result.status === 'compacted' && result.compaction) {
      try {
        const cursorStore = new CompactionCursorStore(this.loop.paths.stateRoot)
        const activeHistory = activeHistoryAfterSeq(
          this.loop.activeMemoryStore,
          result.compaction.range.toSeq,
        )
        this.loop.activeMemoryStore.appendCompactMarker(
          activeHistory,
          cursorStore.archiveGate(sessionId),
        )
        result.compaction.cursor = cursorStore.readOrInit(sessionId)
      } catch (exc) {
        await this.loop.finishCompactionHooks(hookScope, {
          status: 'failed',
          error: String(exc instanceof Error ? exc.message : exc),
        })
        return this.compactionFailed(count, unarchivedHistory, exc)
      }
    }
    await this.loop.finishCompactionHooks(hookScope, {
      status: result.status,
      message: result.message,
      error: result.error ?? null,
      compaction: result.compaction ?? null,
    })
    const runtime = this.loop.runtimeStore.compact(
      this.loop.activeMemoryStore.loadUnarchivedTurnIds(),
    )
    this.refreshRuntimeContext?.()
    if (result.status !== 'compacted') {
      return {
        status: result.status,
        count,
        message: result.message,
        memory: this.getMemory(),
        unarchivedHistory: this.historyPayload(),
        runtime,
        error: result.error,
      }
    }
    return {
      status: 'compacted',
      count,
      message: result.message,
      memory: this.getMemory(),
      unarchivedHistory: this.historyPayload(),
      runtime,
      compaction: result.compaction,
    }
  }

  explainContext(
    opts: { sessionId?: string | null; turnId?: string | null } = {},
  ) {
    const sessionId = String(
      opts.sessionId ?? this.loop.activeSessionId ?? '',
    ).trim()
    if (!sessionId) {
      return {
        status: 'missing_session',
        sessionId: null,
        turnId: opts.turnId ?? null,
        reason: 'no active or requested session',
      }
    }
    const sessionRoot = this.loop.sessionStore.sessionDir(sessionId)
    const snapshot = this.readPromptSnapshot(sessionRoot, opts.turnId ?? null)
    const checkpoint = this.checkpointSummary(
      join(sessionRoot, '_checkpoint.json'),
    )
    const compaction = this.compactionExplanation(sessionId)
    const artifacts = this.memoryArtifacts(sessionId, sessionRoot)
    if (!snapshot) {
      return {
        status: 'missing_snapshot',
        sessionId,
        turnId: opts.turnId ?? null,
        reason: 'prompt snapshot not found',
        checkpoint,
        compaction,
        artifacts,
        microcompact: { records: [], omittedChars: 0 },
      }
    }
    const contextPlan = recordValue(snapshot.contextPlan)
    const items = Array.isArray(contextPlan.items)
      ? contextPlan.items.filter(isRecord)
      : []
    const omitted = Array.isArray(contextPlan.omitted)
      ? contextPlan.omitted.filter(isRecord)
      : []
    const microcompact = microcompactSummary(contextPlan, snapshot)
    return {
      status: 'ok',
      sessionId,
      turnId: String(snapshot.turnId ?? opts.turnId ?? ''),
      mode: contextPlan.mode ?? null,
      model: snapshot.model ?? null,
      provider: snapshot.provider ?? null,
      modelRole: snapshot.modelRole ?? null,
      estimatedInputTokens: snapshot.estimatedInputTokens ?? null,
      activeMemoryBinding: contextPlan.activeMemoryBinding ?? null,
      injected: items.map((item) => ({
        id: String(item.id ?? ''),
        kind: String(item.kind ?? ''),
        source: String(item.source ?? ''),
        action: String(item.action ?? 'include'),
        reason: String(item.reason ?? ''),
        priority: numberOrNull(item.priority),
        hash: typeof item.hash === 'string' ? item.hash : null,
        charCount: numberOrNull(item.charCount),
        tokenEstimate: numberOrNull(item.tokenEstimate),
      })),
      omitted: omitted.map((item) => ({
        kind: String(item.kind ?? ''),
        source: String(item.source ?? ''),
        reason: String(item.reason ?? ''),
      })),
      sections: Array.isArray(snapshot.sections) ? snapshot.sections : [],
      checkpoint,
      compaction,
      artifacts,
      microcompact,
      snapshot: {
        createdAt: snapshot.createdAt ?? null,
        totals: snapshot.totals ?? null,
      },
    }
  }

  private compactionExplanation(sessionId: string): Dict {
    const cursor = new CompactionCursorStore(
      this.loop.paths.stateRoot,
    ).readOrInit(sessionId)
    const latest = this.latestCompactionRun(
      sessionId,
      cursor.lastCompactionId ?? null,
    )
    return {
      cursor,
      archive: {
        compactedUntilSeq: cursor.compactedUntilSeq,
        archivedUntilSeq: cursor.archivedUntilSeq,
        archiveBlockedUntilCompacted:
          cursor.archivedUntilSeq < cursor.compactedUntilSeq,
      },
      omittedRanges:
        latest && latest.status === 'applied'
          ? [
              {
                fromSeq: numberOrNull(recordValue(latest.range).fromSeq),
                toSeq: numberOrNull(recordValue(latest.range).toSeq),
                compactionId: String(latest.compactionId ?? ''),
                reason: 'semantic_compaction_applied',
              },
            ]
          : [],
      latest: latest ? compactionRunExplanation(latest) : null,
    }
  }

  private memoryArtifacts(sessionId: string, sessionRoot: string): Dict[] {
    const session = this.loop.sessionStore.get(sessionId)
    const projectId = String(session?.project_id ?? '').trim()
    const project = projectId ? this.loop.projectStore.get(projectId) : null
    return buildMemoryArtifacts({
      stateRoot: this.loop.paths.stateRoot,
      memoryDir: this.loop.sharedMemory.memoryDir,
      userFile: this.loop.sharedMemory.userFile,
      sessionId,
      sessionRoot,
      historyFile: join(sessionRoot, 'history.jsonl'),
      runtimeEventsFile: join(sessionRoot, 'runtime', 'events.jsonl'),
      projectId: project?.project_id ?? null,
      projectMemoryPath: project?.agents_path ?? null,
      episodeDate: new Date(Date.now() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    }) as unknown as Dict[]
  }

  private latestCompactionRun(
    sessionId: string,
    preferredId: string | null,
  ): Dict | null {
    const index = new CompactionLedger(this.loop.paths.stateRoot).readIndex()
    const cursor = new CompactionCursorStore(
      this.loop.paths.stateRoot,
    ).readOrInit(sessionId)
    return latestAppliedCompactionRun(
      index,
      sessionId,
      preferredId,
      cursor.compactedUntilSeq,
    ) as Dict | null
  }

  private contextPayload(): Dict {
    const sessionId = this.loop.activeSessionId || ''
    const session = sessionId ? this.loop.sessionStore.get(sessionId) : null
    const mode = String(session?.mode || 'chat')
    const projectId = String(session?.project_id || '')
    const project = projectId ? this.loop.projectStore.get(projectId) : null
    const sources = [
      'templates/SOUL.md',
      'templates/TOOL.md',
      'memory/profile/USER.local.md',
    ]
    const sourceMap: Dict[] = [
      {
        domain: 'prompt',
        kind: 'bootstrap',
        path: 'templates/SOUL.md',
        scope: 'global',
      },
      {
        domain: 'prompt',
        kind: 'tool_contract',
        path: 'templates/TOOL.md',
        scope: 'global',
      },
      {
        domain: 'memory',
        kind: 'user_profile',
        path: this.loop.sharedMemory.userFile,
        scope: 'global',
      },
      {
        domain: 'session',
        kind: 'history',
        path: this.loop.activeMemoryStore.historyFile,
        sessionId,
      },
      {
        domain: 'runtime',
        kind: 'events',
        path: this.loop.runtimeStore.eventsFile,
        sessionId,
      },
    ]
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
          path: this.loop.sharedMemory.memoryFile,
          scope: 'global',
        },
        {
          domain: 'project',
          kind: 'index_summary',
          path: this.loop.projectStore.indexPath,
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
      projectIndexSummary: this.loop.projectStore.summaryForChat(),
      projectMemory: projectId
        ? this.loop.projectStore.readManagedMemory(projectId)
        : '',
    }
  }

  private schedulerMaintenance(): Dict {
    const jobs = this.loop.schedulerService
      .listJobs({ includeDisabled: true })
      .filter((job) => job.protected)
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

  private compactionFailed(
    count: number,
    unarchivedHistory: CoreHistoryItem[],
    exc?: unknown,
  ): CoreCompactPayload {
    return {
      status: 'degraded',
      count,
      message: '记忆压缩失败，已保留当前会话历史。',
      memory: this.getMemory(),
      unarchivedHistory,
      error: exc
        ? String(exc instanceof Error ? exc.message : exc).slice(0, 500)
        : 'compaction_failed',
    }
  }

  private countHistoryMessages(): number {
    const historyFile = this.loop.activeMemoryStore.historyFile
    if (!existsSync(historyFile)) return 0
    let count = 0
    for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed)
        if (row?.role === 'user' || row?.role === 'assistant') count += 1
      } catch {
        // Ignore corrupt history rows in diagnostics-style summaries.
      }
    }
    return count
  }

  private rel(path: string): string {
    return relativePortableOrAbsolute(this.root, path)
  }

  private readPromptSnapshot(
    sessionRoot: string,
    turnId: string | null,
  ): Dict | null {
    const snapshotDir = join(sessionRoot, 'prompt-snapshots')
    if (!existsSync(snapshotDir)) return null
    const file = turnId
      ? join(snapshotDir, `${safeSnapshotName(turnId)}.json`)
      : latestPromptSnapshot(snapshotDir)
    if (!file || !existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8') || '{}')
      return isRecord(parsed) && Array.isArray(parsed.sections) ? parsed : null
    } catch {
      return null
    }
  }

  private checkpointSummary(path: string): Dict {
    const result = readTurnCheckpoint(path, {
      lastHistorySeq: latestHistorySeqForCheckpoint(path),
    })
    if (!result.exists)
      return { exists: false, recoverable: false, historyRows: 0 }
    if (!result.checkpoint) {
      return {
        exists: true,
        recoverable: false,
        historyRows: 0,
        reason: result.reason,
      }
    }
    return {
      exists: true,
      recoverable: result.recoverable,
      historyRows: result.checkpoint.partialMessages.length,
      updatedAt: result.checkpoint.updatedAt || null,
      schemaVersion: result.checkpoint.schemaVersion,
      phase: result.checkpoint.phase,
      turnId: result.checkpoint.turnId || null,
      legacy: result.legacy,
      reason: result.reason,
    }
  }
}

function latestHistorySeqForCheckpoint(checkpointPath: string): number {
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(dirname(checkpointPath), 'history_index.json'),
        'utf8',
      ) || '{}',
    )
    return Number(isRecord(parsed) ? parsed.latest_seq : 0) || 0
  } catch {
    return 0
  }
}

function latestPromptSnapshot(snapshotDir: string): string | null {
  const entries: Array<{ path: string; mtimeMs: number }> = []
  for (const name of readdirSync(snapshotDir)) {
    if (!name.endsWith('.json')) continue
    const path = join(snapshotDir, name)
    try {
      entries.push({ path, mtimeMs: statSync(path).mtimeMs })
    } catch {
      // Ignore files that disappear during diagnostics.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
  return entries[0]?.path ?? null
}

function safeSnapshotName(value: string): string {
  return (
    String(value || 'turn')
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 120) || 'turn'
  )
}

function recordValue(value: unknown): Dict {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Dict {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function microcompactSummary(contextPlan: Dict, snapshot: Dict): Dict {
  const raw = Array.isArray(contextPlan.microcompact)
    ? contextPlan.microcompact
    : Array.isArray(snapshot.microcompact)
      ? snapshot.microcompact
      : Array.isArray(contextPlan.microcompactRecords)
        ? contextPlan.microcompactRecords
        : []
  const records = raw.filter(isRecord)
  const omittedChars = records.reduce((sum, record) => {
    const original =
      Number(record.original_chars ?? record.originalChars ?? 0) || 0
    const head =
      Number(record.kept_head_chars ?? record.keptHeadChars ?? 0) || 0
    const tail =
      Number(record.kept_tail_chars ?? record.keptTailChars ?? 0) || 0
    return sum + Math.max(0, original - head - tail)
  }, 0)
  return { records, omittedChars }
}

function compactionRunExplanation(record: Dict): Dict {
  const output = recordValue(record.output)
  const range = recordValue(record.range)
  const targetVersions = Array.isArray(output.targetVersions)
    ? output.targetVersions.filter(isRecord)
    : []
  const discarded = Array.isArray(output.discarded)
    ? output.discarded.filter(isRecord)
    : []
  const decisions = Array.isArray(output.decisions)
    ? output.decisions.filter(isRecord)
    : []
  return {
    compactionId: String(record.compactionId ?? ''),
    status: String(record.status ?? ''),
    mode: String(record.mode ?? ''),
    projectId: record.projectId ?? null,
    trigger: isRecord(record.trigger) ? record.trigger : null,
    range: {
      fromSeq: numberOrNull(range.fromSeq),
      toSeq: numberOrNull(range.toSeq),
    },
    patchTargets: targetVersions.map((target) => ({
      scope: isRecord(target.scope) ? target.scope : (target.scope ?? null),
      beforeVersion: numberOrNull(target.beforeVersion),
      afterVersion: numberOrNull(target.afterVersion),
      beforeHash:
        typeof target.beforeHash === 'string' ? target.beforeHash : null,
      afterHash: typeof target.afterHash === 'string' ? target.afterHash : null,
      operationCount: numberOrNull(target.operationCount),
    })),
    discardedCount: discarded.length,
    discarded,
    decisions,
    error: isRecord(record.error) ? record.error : null,
  }
}

function activeHistoryAfterSeq(
  store: {
    conversation?: { historyLog?: { loadActiveRows(): Dict[] } }
    loadUnarchivedHistory(): Dict[]
  },
  seq: number,
): Dict[] {
  const cutoff = Math.trunc(Number(seq) || 0)
  const rows = store.conversation?.historyLog?.loadActiveRows?.()
  if (!rows) return store.loadUnarchivedHistory()
  const hiddenTurns = new Set<string>()
  for (const row of rows) {
    if (
      typeof row.turn_id === 'string' &&
      (row.hidden === true || row.schedulerHidden === true)
    )
      hiddenTurns.add(row.turn_id)
  }
  return rows
    .filter((row) => {
      if ((Number(row.seq) || 0) <= cutoff) return false
      if (!('role' in row) || !('content' in row)) return false
      if (row.type === 'model_call' || row.type === 'compact_event')
        return false
      if (hiddenTurns.has(String(row.turn_id ?? ''))) return false
      return true
    })
    .map((row) => {
      const item: Dict = { role: row.role, content: row.content }
      if (Number.isFinite(Number(row.seq)) && Number(row.seq) > 0)
        item.seq = Math.trunc(Number(row.seq))
      if (typeof row.turn_id === 'string') item.turn_id = row.turn_id
      if (Array.isArray(row.attachments)) item.attachments = row.attachments
      if (Array.isArray(row.requestedSkills))
        item.requestedSkills = row.requestedSkills
      if (typeof row.displayContent === 'string')
        item.displayContent = row.displayContent
      return item
    })
}

function historyItemFromRow(row: Dict): CoreHistoryItem | null {
  const role = row.role === 'user' || row.role === 'assistant' ? row.role : null
  if (!role || typeof row.content !== 'string') return null
  const item: CoreHistoryItem = { role, content: row.content }
  if (typeof row.turn_id === 'string') item.turn_id = row.turn_id
  if (typeof row.source === 'string') item.source = row.source
  if (row.ui_hidden === true) item.ui_hidden = true
  if (Array.isArray(row.attachments)) {
    const attachments = row.attachments
      .map(historyAttachmentFromValue)
      .filter((value): value is CoreHistoryAttachment => value !== null)
    if (attachments.length) item.attachments = attachments
  }
  if (Array.isArray(row.requestedSkills)) {
    const requestedSkills = row.requestedSkills
      .map(requestedSkillFromValue)
      .filter(
        (value): value is { name: string; source?: string } => value !== null,
      )
    if (requestedSkills.length) item.requestedSkills = requestedSkills
  }
  return item
}

function requestedSkillFromValue(
  value: unknown,
): { name: string; source?: string } | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) return null
  return {
    name,
    ...(typeof value.source === 'string' && value.source
      ? { source: value.source }
      : {}),
  }
}

function historyAttachmentFromValue(
  value: unknown,
): CoreHistoryAttachment | null {
  if (!isRecord(value)) return null
  const kind = String(value.kind ?? '')
  if (kind !== 'image' && kind !== 'document' && kind !== 'text') return null
  const id = String(value.id ?? '')
  const name = String(value.name ?? '')
  const mime = String(value.mime ?? '')
  const path = String(value.path ?? value.rel_path ?? '')
  const size = Number(value.size)
  if (!id || !name || !mime || !path || !Number.isFinite(size)) return null
  const textPath = value.textPath ?? value.text_rel_path
  return {
    id,
    name,
    mime,
    size,
    kind,
    hasText: Boolean(value.hasText ?? value.has_text),
    hasImage: Boolean(value.hasImage ?? value.has_image),
    path,
    ...(textPath === null || typeof textPath === 'string' ? { textPath } : {}),
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
