import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../../harness/compaction/events'
import {
  contextMessage,
  createAssistantMessage,
  userText,
} from '../../llm/message'
import { MemoryStore } from '../../memory/store'
import { TokenTracker } from '../../memory/token-tracker'
import { ProjectStore } from '../../projects/store'
import { Session } from '../../session-log/session'
import { SessionStore } from '../../sessions/store'
import { WatchlistDecision } from '../../watchlist/models'
import { WatchlistService } from '../../watchlist/service'
import {
  CoreMemoryService,
  type CoreContextMeasurement,
  type CoreMemoryServiceDeps,
} from './memory-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function runTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', userText(text), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `reply ${turn}` }],
        source: { provider: 'openai', model: 'gpt-4.1' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function appendCompaction(
  session: Session,
  id: string,
  seqs: number[],
  error?: string,
): void {
  session.append('compaction/start', { compactionId: id, turn: null })
  if (!error) {
    session.append('compaction/summary', {
      compactionId: id,
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 0, end: seqs.length },
      shadowedSeqs: seqs,
      shadowedTokenCount: 120,
      provider: 'openai',
      model: 'gpt-4.1-mini',
    })
  }
  session.append('compaction/end', {
    compactionId: id,
    turn: null,
    ...(error ? { error } : {}),
  })
}

interface Harness {
  root: string
  deps: CoreMemoryServiceDeps
  service: CoreMemoryService
  logs: Map<string, Session>
  refreshes: () => number
  setActive: (id: string | null) => void
  compactCalls: string[]
  setCompact: (fn: CoreMemoryServiceDeps['compactNow']) => void
  setMeasure: (value: CoreContextMeasurement | null) => void
}

function makeService(): Harness {
  const root = tmp('emperor-memory-service-')
  const memoryDir = join(root, 'memory')
  mkdirSync(join(memoryDir, 'profile'), { recursive: true })
  const userFile = join(memoryDir, 'profile', 'USER.local.md')
  writeFileSync(userFile, '# User\n', 'utf8')
  const sharedMemory = new MemoryStore(memoryDir, userFile)
  const projectStore = new ProjectStore(root, {
    versions: sharedMemory.versions,
  })
  const tokenTracker = new TokenTracker(join(root, 'tokens', 'tokens.jsonl'))
  const sessionStore = new SessionStore(root)
  const watchlist = new WatchlistService(root, {
    decider: () => WatchlistDecision.skip('manual check'),
    tokenTracker,
  })
  const logs = new Map<string, Session>()
  let active: string | null = null
  let refreshCount = 0
  const compactCalls: string[] = []
  let compactImpl: CoreMemoryServiceDeps['compactNow'] = async () => ({
    compacted: false,
  })
  let measurement: CoreContextMeasurement | null = null
  const deps: CoreMemoryServiceDeps = {
    stateRoot: root,
    sharedMemory,
    projectStore,
    tokenTracker,
    watchlist,
    sessionStore,
    activeSessionId: () => active,
    sessionLog: (id) => logs.get(id),
    compactNow: async (id) => {
      compactCalls.push(id)
      return await compactImpl(id)
    },
    measureContext: () => measurement,
    refreshRuntimeContext: () => {
      refreshCount += 1
    },
  }
  return {
    root,
    deps,
    service: new CoreMemoryService(deps),
    logs,
    refreshes: () => refreshCount,
    setActive: (id) => {
      active = id
    },
    compactCalls,
    setCompact: (fn) => {
      compactImpl = fn
    },
    setMeasure: (value) => {
      measurement = value
    },
  }
}

function chatSession(h: Harness, turns = 0): Session {
  const entry = h.deps.sessionStore.create('Chat', { mode: 'chat' })
  const session = new Session({ version: 0, id: entry.id, createdAt: 0 })
  for (let turn = 1; turn <= turns; turn += 1)
    runTurn(session, turn, `request ${turn}`)
  h.logs.set(entry.id, session)
  h.setActive(entry.id)
  return session
}

describe('CoreMemoryService (harness kernel)', () => {
  it('returns the memory payload with context, token, session-log, watchlist, and version summaries', () => {
    const h = makeService()
    const { root, deps, service } = h
    deps.sharedMemory.writeMemory('# Long\n\nKeep this fact.')
    writeFileSync(
      join(root, 'memory', '2026-05-01.md'),
      '# 2026-05-01\n\nEpisode.',
      'utf8',
    )
    const session = chatSession(h, 1)
    deps.tokenTracker.record(
      'gpt-4.1',
      { input: 10, output: 5, cache_read: 2 },
      { provider: 'openai', usageType: 'main_agent' },
    )
    service.saveWatchlist('- [ ] check later')

    const payload = service.getMemory()

    expect(payload.long_term).toContain('Keep this fact')
    expect(payload.episodes).toContain('memory/2026-05-01.md')
    expect(payload.context).toMatchObject({
      mode: 'chat',
      sources: expect.arrayContaining([
        'memory/MEMORY.local.md',
        'projects/index.json',
      ]),
      sourceMap: expect.arrayContaining([
        expect.objectContaining({
          domain: 'session',
          kind: 'session_log',
          sessionId: session.id,
        }),
      ]),
    })
    expect(payload.tokensByModel['openai/gpt-4.1']).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      total: 17,
    })
    expect(payload.tokensByUsageType.main_agent).toMatchObject({ total: 17 })
    expect(payload.tokenTotals).toMatchObject({ total: 17, calls: 1 })
    expect(payload.history).toMatchObject({
      active_lines: 2,
      latest_seq: session.seq - 1,
      archive_files: 0,
      needs_rotation: false,
    })
    expect(payload.runtime).toMatchObject({
      events: session.seq,
      activeTurns: 0,
      archiveFiles: 0,
      needsRotation: false,
    })
    expect(payload.compaction).toMatchObject({
      cursor: { compactedUntilSeq: 0, archivedUntilSeq: 0, status: 'active' },
      archive: { compactedUntilSeq: 0, archivedUntilSeq: 0 },
      omittedRanges: [],
      latest: null,
    })
    expect(payload.schedulerMaintenance).toEqual({
      jobs: 0,
      enabled: 0,
      nextRunAtMs: null,
      lastError: null,
    })
    expect(payload.watchlist.content).toBe('- [ ] check later\n')
    expect(payload.versions).toHaveProperty('versions')
    expect(service.historyPayload()).toEqual([])
  })

  it('returns neutral per-session keys when no session is active', () => {
    const { service } = makeService()
    const payload = service.getMemory()
    expect(payload.compaction).toBeNull()
    expect(payload.history).toMatchObject({ active_lines: 0, latest_seq: 0 })
    expect(payload.runtime).toMatchObject({ events: 0, path: '' })
  })

  it('reports memory source domains for build project private state', () => {
    const h = makeService()
    const { root, deps, service } = h
    const projectDir = tmp('emperor-memory-service-project-')
    const project = deps.projectStore.resolve(projectDir)
    const entry = deps.sessionStore.create('Build Project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    h.setActive(entry.id)
    deps.projectStore.updateMemory(
      project.project_id,
      '## Architecture Notes\n\n- Build context belongs to this project.',
    )

    const payload = service.getMemory()

    expect(payload.context).toMatchObject({
      mode: 'build',
      projectMemory: expect.stringContaining(
        'Build context belongs to this project',
      ),
      sources: expect.arrayContaining([
        '全局私有项目记忆 (AGENTS.local.md)',
        'Workspace AGENTS.md/.emperor rules (只读协作上下文)',
      ]),
      sourceMap: expect.arrayContaining([
        expect.objectContaining({
          domain: 'project',
          kind: 'private_memory',
          projectId: project.project_id,
          workspacePath: resolve(projectDir),
          statePath: join(root, 'projects', project.project_id),
          path: join(root, 'projects', project.project_id, 'AGENTS.local.md'),
        }),
      ]),
    })
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)
  })

  it('versions and restores project private memory through the shared memory version API', () => {
    const { deps, service } = makeService()
    const projectDir = tmp('emperor-memory-service-project-versions-')
    const project = deps.projectStore.resolve(projectDir)
    deps.projectStore.updateMemory(
      project.project_id,
      '## Architecture Notes\n\n- first version',
    )
    deps.projectStore.updateMemory(
      project.project_id,
      '## Build Commands\n\n- second version',
    )

    const versions = service.listVersions({
      target: 'project',
      limit: 10,
    }).versions
    expect(versions[0]).toMatchObject({
      target: 'project',
      relPath: `projects/${project.project_id}/AGENTS.local.md`,
    })

    service.restoreVersion(String(versions[0]!.id))

    expect(deps.projectStore.readManagedMemory(project.project_id)).toContain(
      'first version',
    )
  })

  it('saves global memory through section patches, restores versions, checks the watchlist, and refreshes runtime context', async () => {
    const { root, deps, service, refreshes } = makeService()
    deps.sharedMemory.writeMemory(
      '# Global Long-Term Memory\n\n## Cross-Project Decisions\n- keep this\n\n## Open Questions\n- old question\n',
    )
    const initial = deps.sharedMemory.readMemory()

    const savedMemory = service.saveMemory(
      '## Open Questions\n\n- new question\n',
    )
    expect(savedMemory.path).toBe('memory/MEMORY.local.md')
    expect(savedMemory.content).toContain(
      '## Cross-Project Decisions\n- keep this',
    )
    expect(savedMemory.content).toContain('- new question')
    expect(deps.sharedMemory.readMemory()).toContain('- new question')
    expect(
      readFileSync(join(root, 'memory', 'patch-ledger.jsonl'), 'utf8'),
    ).toContain('save_global_memory')
    expect(refreshes()).toBe(1)

    expect(() => service.saveMemory('plain memory text')).toThrow(
      'save_memory requires at least one ## section',
    )
    expect(refreshes()).toBe(1)

    expect(() => service.getEpisode('bad-date')).toThrow(
      'episode date must be YYYY-MM-DD',
    )
    expect(() => service.getEpisode('2026-05-02')).toThrow(
      'Episode not found: 2026-05-02',
    )
    expect(service.saveEpisode('Episode body\n\n', '2026-05-02')).toEqual({
      date: '2026-05-02',
      content: 'Episode body\n',
    })
    expect(existsSync(join(root, 'memory', '2026-05-02.md'))).toBe(true)
    service.saveEpisode('Episode body v2', '2026-05-02')
    expect(
      service.listVersions({ target: 'episode' }).versions.length,
    ).toBeGreaterThanOrEqual(1)
    expect(() => service.listVersions({ target: 'bogus' })).toThrow(
      'Invalid version target',
    )

    const versions = service.listVersions({
      target: 'memory',
      limit: 10,
    }).versions
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(service.getVersion(String(versions[0]!.id))).toBeTruthy()
    const restored = service.restoreVersion(String(versions[0]!.id))
    expect(restored).toMatchObject({
      restored: { path: 'memory/MEMORY.local.md', content: initial },
      memory: { long_term: initial },
    })
    expect(refreshes()).toBe(2)

    service.saveWatchlist('- [ ] active item')
    expect(service.getWatchlist()).toMatchObject({
      content: '- [ ] active item\n',
    })
    const checked = await service.checkWatchlist()
    expect(checked).toMatchObject({
      decision: { action: 'skip', reason: 'manual check' },
      watchlist: { content: '- [ ] active item\n' },
    })
  })

  it('returns the full token analytics payload and counts messages from the active session log', () => {
    const h = makeService()
    const { deps, service } = h
    deps.tokenTracker.record(
      'gpt-4.1',
      { input: 10, output: 2 },
      { provider: 'openai', usageType: 'main_agent' },
    )
    deps.tokenTracker.record(
      'gpt-4.1',
      { input: 5, output: 1, cache_read: 3 },
      { provider: 'openai', usageType: 'main_agent' },
    )

    expect(service.tokens().messages).toBe(0)
    const session = chatSession(h, 2)
    session.append('user/message', contextMessage('runtime-context', 'ctx'), {
      surfaceOp: 'append',
    })

    const payload = service.tokens()

    expect(
      payload.byDateModel[Object.keys(payload.byDateModel)[0]!]![
        'openai/gpt-4.1'
      ],
    ).toMatchObject({
      total: 21,
    })
    expect(payload.byHour).toHaveProperty(
      new Date().getHours().toString().padStart(2, '0'),
    )
    expect(payload.streak).toHaveProperty('active_days')
    expect(payload.sessions).toBeGreaterThanOrEqual(1)
    expect(payload.messages).toBe(4)
    expect(payload.recentCalls?.[0]).toMatchObject({
      model: 'gpt-4.1',
      total: 9,
    })
    expect(payload.recentCacheCalls?.[0]).toMatchObject({ cache_read: 3 })
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('requires a session for manual compaction and skips short sessions', async () => {
    const h = makeService()
    await expect(h.service.compact()).rejects.toThrow(
      'session is required for compaction',
    )

    chatSession(h, 0)
    const skipped = await h.service.compact()
    expect(skipped).toMatchObject({
      status: 'skipped',
      count: 0,
      unarchivedHistory: [],
    })
    expect(skipped.message).toContain('已随旧内核退役')
    expect(h.compactCalls).toEqual([])
  })

  it('manual compact delegates to the harness and reports the session-log compaction', async () => {
    const h = makeService()
    const session = chatSession(h, 3)
    const shadowed = session.surface.nodes.slice(0, 2)
    h.setCompact(async () => {
      appendCompaction(session, 'cmp_1', [...shadowed])
      return { compacted: true, shadowedTokenCount: 120 }
    })

    const payload = await h.service.compact({ force: true })

    expect(h.compactCalls).toEqual([session.id])
    expect(h.refreshes()).toBe(1)
    expect(payload).toMatchObject({
      status: 'compacted',
      count: 6,
      unarchivedHistory: [],
      runtime: { events: session.seq },
      compaction: {
        compactionId: 'cmp_1',
        range: { fromSeq: shadowed[0], toSeq: shadowed[1] },
        shadowedTokenCount: 120,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        cursor: { compactedUntilSeq: shadowed[1], lastCompactionId: 'cmp_1' },
        applied: [],
        discarded: [],
      },
    })
    expect(payload.message).toContain('120 tokens')
    expect(payload.memory.compaction).toMatchObject({
      cursor: { compactedUntilSeq: shadowed[1] },
      omittedRanges: [
        { compactionId: 'cmp_1', fromSeq: shadowed[0], toSeq: shadowed[1] },
      ],
      latest: { compactionId: 'cmp_1', status: 'applied' },
      count: 1,
    })
  })

  it('reports skipped and degraded compaction without touching the session log', async () => {
    const h = makeService()
    const session = chatSession(h, 2)
    const before = session.seq

    const skipped = await h.service.compact()
    expect(skipped).toMatchObject({ status: 'skipped', count: 4 })
    expect(skipped.message).toContain('没有可压缩的范围')

    h.setCompact(async () => {
      throw new Error('summary model unavailable')
    })
    const degraded = await h.service.compact({ sessionId: session.id })
    expect(degraded).toMatchObject({
      status: 'degraded',
      count: 4,
      error: 'summary model unavailable',
      unarchivedHistory: [],
    })
    expect(session.seq).toBe(before)
  })

  it('explains the context of a session from its log', () => {
    const h = makeService()
    expect(h.service.explainContext()).toMatchObject({
      status: 'missing_session',
      sessionId: null,
    })

    const entry = h.deps.sessionStore.create('No log', { mode: 'chat' })
    expect(h.service.explainContext({ sessionId: entry.id })).toMatchObject({
      status: 'missing_snapshot',
      sessionId: entry.id,
      checkpoint: { exists: false, status: 'retired' },
      microcompact: { records: [], omittedChars: 0 },
      compaction: { cursor: { compactedUntilSeq: 0 } },
    })

    const session = chatSession(h, 1)
    session.append('request/header', {
      header: {
        config: { provider: 'openai', model: 'gpt-4.1' },
        system: 'You are Emperor.',
        tools: [
          {
            name: 'read',
            description: 'read a file',
            parameters: { type: 'object' },
          },
        ],
      },
      reason: 'initial',
    } as never)
    session.append('request/context', {
      provider: 'openai',
      model: 'gpt-4.1',
      contextWindow: 128000,
    })
    const ctx = contextMessage('agent-instructions', 'Follow AGENTS.md', {
      form: 'instructions',
    })
    session.append('user/message', ctx, { surfaceOp: 'append' })
    session.append('compaction/prune', {
      shadowedRange: { start: 0, end: 1 },
      shadowedSeqs: [3],
      shadowedTokenCount: 40,
    })
    appendCompaction(session, 'cmp_fail', [], 'not smaller')
    h.setMeasure({ totalTokens: 2048, contextWindow: 128000 })

    const explained = h.service.explainContext()

    expect(explained).toMatchObject({
      status: 'ok',
      sessionId: session.id,
      turnId: '1',
      mode: 'chat',
      model: 'gpt-4.1',
      provider: 'openai',
      estimatedInputTokens: 2048,
      contextWindow: 128000,
      activeMemoryBinding: { kind: 'global' },
      injected: [
        expect.objectContaining({
          id: ctx.id,
          kind: 'instructions',
          source: 'agent-instructions',
          action: 'include',
          charCount: 'Follow AGENTS.md'.length,
        }),
      ],
      omitted: [],
      sections: [
        expect.objectContaining({
          id: 'system',
          charCount: 'You are Emperor.'.length,
        }),
        expect.objectContaining({ id: 'tools', count: 1 }),
      ],
      surface: {
        nodes: 3,
        messages: 2,
        user: 1,
        assistant: 1,
        context: 1,
        toolResults: 0,
      },
      checkpoint: { exists: false, status: 'retired' },
      microcompact: {
        records: [expect.objectContaining({ shadowedTokenCount: 40 })],
        omittedTokens: 40,
      },
      compaction: {
        cursor: { compactedUntilSeq: 0 },
        omittedRanges: [],
        latest: {
          compactionId: 'cmp_fail',
          status: 'failed',
          error: { message: 'not smaller' },
        },
        count: 0,
      },
      snapshot: {
        totals: { events: session.seq, surfaceNodes: 3, estimatedTokens: 2048 },
      },
    })
    const artifacts = (
      explained as unknown as {
        artifacts: Array<{ kind: string; path: string }>
      }
    ).artifacts
    expect(artifacts.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        'user_profile',
        'global_memory',
        'conversation_history',
      ]),
    )
    expect(artifacts.map((item) => item.kind)).not.toContain('checkpoint')
    expect(
      artifacts.find((item) => item.kind === 'conversation_history')?.path,
    ).toBe(join(h.root, 'sessions', session.id, 'log.jsonl'))
  })
})
