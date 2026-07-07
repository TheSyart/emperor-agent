import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentLoop } from '../../agent/loop'
import type { ModelRoute, ProviderSnapshot } from '../../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../../providers/base'
import { CompactionCursorStore, CompactionLedger } from '../../memory/compaction-ledger'
import { writePromptSnapshot } from '../../prompts/manifest'
import { WatchlistDecision } from '../../watchlist/models'
import { WatchlistService } from '../../watchlist/service'
import { CoreMemoryService } from './memory-service'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'templates')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function appendCompletedTurns(loop: AgentLoop, turns: number): void {
  for (let index = 1; index <= turns; index += 1) {
    loop.activeMemoryStore.appendHistory('user', `request ${index}`, { extra: { turn_id: `turn_${index}` } })
    loop.activeMemoryStore.appendHistory('assistant', `reply ${index}`, { extra: { turn_id: `turn_${index}` } })
  }
}

describe('CoreMemoryService (MIG-IPC-007)', () => {
  it('returns the Python-compatible memory payload with context, token, runtime, watchlist, and version summaries', async () => {
    const { root, loop, service } = await makeService()
    loop.sharedMemory.writeMemory('# Long\n\nKeep this fact.')
    writeFileSync(join(root, 'memory', '2026-05-01.md'), '# 2026-05-01\n\nEpisode.', 'utf8')
    loop.activeMemoryStore.appendHistory('user', 'hello', { extra: { turn_id: 'turn_1' } })
    loop.runtimeStore.append({ event: 'message_delta', turn_id: 'turn_1', content: 'hi' })
    loop.tokenTracker.record('gpt-4.1', { input: 10, output: 5, cache_read: 2 }, { provider: 'openai', usageType: 'main_agent' })
    service.saveWatchlist('- [ ] check later')

    const payload = service.getMemory()

    expect(payload.long_term).toContain('Keep this fact')
    expect(payload.episodes).toContain('memory/2026-05-01.md')
    expect(payload.context).toMatchObject({
      mode: 'chat',
      sources: expect.arrayContaining(['memory/MEMORY.local.md', 'projects/index.json']),
    })
    expect(payload.tokensByModel['openai/gpt-4.1']).toMatchObject({ provider: 'openai', model: 'gpt-4.1', total: 17 })
    expect(payload.tokensByUsageType.main_agent).toMatchObject({ total: 17 })
    expect(payload.tokenTotals).toMatchObject({ total: 17, calls: 1 })
    expect(payload.history.active_lines).toBeGreaterThan(0)
    expect(payload.runtime.activeTurns).toBe(1)
    expect(payload.compaction).toMatchObject({
      cursor: { compactedUntilSeq: 0, archivedUntilSeq: 0, status: 'active' },
      archive: { compactedUntilSeq: 0, archivedUntilSeq: 0 },
    })
    expect(payload.watchlist.content).toBe('- [ ] check later\n')
    expect(payload.versions).toHaveProperty('versions')

    await loop.close()
  })

  it('reports memory source domains for build project private state', async () => {
    const { root, loop, service } = await makeService()
    const projectDir = tmp('emperor-memory-service-project-')
    const project = loop.projectStore.resolve(projectDir)
    const session = loop.sessionStore.create('Build Project', { mode: 'build', project: project as unknown as Record<string, unknown> })
    loop.activateSession(session.id)
    loop.activeMemoryStore.writeMemory('## Architecture Notes\n\n- Build context belongs to this project.')

    const payload = service.getMemory()

    expect(payload.context).toMatchObject({
      mode: 'build',
      projectMemory: expect.stringContaining('Build context belongs to this project'),
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
          statePath: join(root, '.emperor', 'projects', project.project_id),
          path: join(root, '.emperor', 'projects', project.project_id, 'AGENTS.local.md'),
        }),
      ]),
    })
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)

    await loop.close()
  })

  it('versions and restores project private memory through the shared memory version API', async () => {
    const { loop, service } = await makeService()
    const projectDir = tmp('emperor-memory-service-project-versions-')
    const project = loop.projectStore.resolve(projectDir)
    const session = loop.sessionStore.create('Build Project', { mode: 'build', project: project as unknown as Record<string, unknown> })
    loop.activateSession(session.id)

    loop.activeMemoryStore.writeMemory('## Architecture Notes\n\n- first version')
    loop.activeMemoryStore.writeMemory('## Build Commands\n\n- second version')

    const versions = service.listVersions({ target: 'project', limit: 10 }).versions
    expect(versions[0]).toMatchObject({
      target: 'project',
      relPath: `projects/${project.project_id}/AGENTS.local.md`,
    })

    service.restoreVersion(String(versions[0]!.id))

    expect(loop.projectStore.readManagedMemory(project.project_id)).toContain('first version')

    await loop.close()
  })

  it('saves global memory through section patches, restores versions, returns full watchlist check payloads, and refreshes runtime context', async () => {
    const { root, loop, service, refreshes } = await makeService()
    loop.sharedMemory.writeMemory('# Global Long-Term Memory\n\n## Cross-Project Decisions\n- keep this\n\n## Open Questions\n- old question\n')
    const initial = loop.sharedMemory.readMemory()

    const savedMemory = service.saveMemory('## Open Questions\n\n- new question\n')
    expect(savedMemory.path).toBe('memory/MEMORY.local.md')
    expect(savedMemory.content).toContain('## Cross-Project Decisions\n- keep this')
    expect(savedMemory.content).toContain('- new question')
    expect(loop.sharedMemory.readMemory()).toContain('## Cross-Project Decisions\n- keep this')
    expect(loop.sharedMemory.readMemory()).toContain('- new question')
    expect(readFileSync(join(root, 'memory', 'patch-ledger.jsonl'), 'utf8')).toContain('save_global_memory')
    expect(refreshes()).toBe(1)

    expect(() => service.saveMemory('plain memory text')).toThrow('save_memory requires at least one ## section')
    expect(refreshes()).toBe(1)

    expect(() => service.getEpisode('bad-date')).toThrow('episode date must be YYYY-MM-DD')
    expect(() => service.getEpisode('2026-05-02')).toThrow('Episode not found: 2026-05-02')
    expect(service.saveEpisode('Episode body\n\n', '2026-05-02')).toEqual({
      date: '2026-05-02',
      content: 'Episode body\n',
    })
    expect(existsSync(join(root, 'memory', '2026-05-02.md'))).toBe(true)

    const versions = service.listVersions({ target: 'memory', limit: 10 }).versions
    expect(versions.length).toBeGreaterThanOrEqual(1)
    const restored = service.restoreVersion(String(versions[0]!.id))
    expect(restored).toMatchObject({
      restored: { path: 'memory/MEMORY.local.md', content: initial },
      memory: { long_term: initial },
    })
    expect(refreshes()).toBe(2)

    service.saveWatchlist('- [ ] active item')
    const checked = await service.checkWatchlist()
    expect(checked).toMatchObject({
      decision: { action: 'skip', reason: 'manual check' },
      watchlist: { content: '- [ ] active item\n' },
    })

    await loop.close()
  })

  it('returns the full token analytics payload used by the Tokens view', async () => {
    const { loop, service } = await makeService()
    loop.tokenTracker.record('gpt-4.1', { input: 10, output: 2 }, { provider: 'openai', usageType: 'main_agent' })
    loop.tokenTracker.record('gpt-4.1', { input: 5, output: 1, cache_read: 3 }, { provider: 'openai', usageType: 'main_agent' })

    const payload = service.tokens()

    expect(payload.byDateModel[Object.keys(payload.byDateModel)[0]!]!['openai/gpt-4.1']).toMatchObject({ total: 21 })
    expect(payload.byHour).toHaveProperty(new Date().getHours().toString().padStart(2, '0'))
    expect(payload.streak).toHaveProperty('active_days')
    expect(payload.sessions).toBeGreaterThanOrEqual(1)
    expect(payload.messages).toBe(0)
    expect(payload.recentCalls?.[0]).toMatchObject({ model: 'gpt-4.1', total: 9 })
    expect(payload.recentCacheCalls?.[0]).toMatchObject({ cache_read: 3 })
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    await loop.close()
  })

  it('manual compact keeps the latest completed turns by default', async () => {
    const provider = new FakeProvider()
    provider.reply = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      episode: {
        operations: [{
          op: 'append_section_item',
          section: 'Summary',
          content: '- Summarized stable old chat turns while keeping recent tail.',
          reason: 'manual compact summarized stable tail-safe range',
          sourceSeqs: [1, 2, 3, 4],
          confidence: 'high',
        }],
      },
      globalMemory: {
        operations: [{
          op: 'append_section_item',
          section: 'Cross-Project Decisions',
          content: '- Manual compact keeps recent conversation tail unless force is requested.',
          reason: 'durable compaction behavior',
          sourceSeqs: [1, 2],
          confidence: 'high',
        }],
      },
      decisions: [{
        sourceSeqs: [1, 2],
        content: 'Manual compact keeps recent conversation tail unless force is requested.',
        destination: 'global_memory',
        classification: 'cross_session_fact',
        reason: 'manual compaction default',
        confidence: 'high',
      }],
      discarded: [],
    })
    const { loop, service } = await makeService(provider)
    appendCompletedTurns(loop, 6)

    const payload = await service.compact()

    expect(payload.error).toBeUndefined()
    expect(payload).toMatchObject({
      status: 'compacted',
      count: 12,
      message: '已压缩 4 条稳定历史消息，保留最近未压缩上下文。',
      compaction: {
        range: { fromSeq: 1, toSeq: 4 },
        cursor: { compactedUntilSeq: 4, archivedUntilSeq: 4 },
        applied: expect.arrayContaining([
          expect.objectContaining({ scope: { kind: 'episode', date: expect.any(String) }, operationCount: 1 }),
          expect.objectContaining({ scope: { kind: 'global' }, operationCount: 1 }),
        ]),
        discarded: [],
      },
    })
    expect(payload.unarchivedHistory).toHaveLength(8)
    expect(loop.activeMemoryStore.loadUnarchivedHistory().map((row) => row.turn_id)).toEqual([
      'turn_3',
      'turn_3',
      'turn_4',
      'turn_4',
      'turn_5',
      'turn_5',
      'turn_6',
      'turn_6',
    ])

    await loop.close()
  })

  it('force-compacts chat history through the scoped JSON compactor and archives compacted session history', async () => {
    const provider = new FakeProvider()
    provider.reply = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      episode: {
        operations: [{
          op: 'append_section_item',
          section: 'Summary',
          content: '- Summarized old chat messages.',
          reason: 'manual compact summarized completed turn',
          sourceSeqs: [1, 2],
          confidence: 'high',
        }],
      },
      userProfile: {
        operations: [{
          op: 'append_section_item',
          section: 'Stable Preferences',
          content: '- Prefers scoped memory compaction.',
          reason: 'explicit stable preference in chat',
          sourceSeqs: [1],
          confidence: 'high',
        }],
      },
      globalMemory: {
        operations: [{
          op: 'append_section_item',
          section: 'Cross-Project Decisions',
          content: '- Emperor uses scoped JSON memory compaction.',
          reason: 'durable cross-session fact',
          sourceSeqs: [2],
          confidence: 'high',
        }],
      },
      decisions: [{
        sourceSeqs: [1],
        content: 'Prefers scoped memory compaction',
        destination: 'user_profile',
        classification: 'stable_user_preference',
        reason: 'stable user preference',
        confidence: 'high',
      }],
      discarded: [],
    })
    const { loop, service } = await makeService(provider)
    loop.activeMemoryStore.appendHistory('user', 'first', { extra: { turn_id: 'turn_1' } })
    loop.activeMemoryStore.appendHistory('assistant', 'reply', { extra: { turn_id: 'turn_1' } })
    loop.runtimeStore.append({ event: 'message_delta', turn_id: 'turn_1', content: 'reply' })

    const payload = await service.compact({ force: true })

    expect(payload.error).toBeUndefined()
    expect(payload).toMatchObject({
      status: 'compacted',
      count: 2,
      message: '已压缩 2 条稳定历史消息。',
    })
    expect(payload.unarchivedHistory).toHaveLength(0)
    expect(payload.compaction).toMatchObject({
      compactionId: expect.any(String),
      range: { fromSeq: 1, toSeq: 2 },
      cursor: { compactedUntilSeq: 2, archivedUntilSeq: 2 },
      applied: expect.arrayContaining([
        expect.objectContaining({ scope: { kind: 'episode', date: expect.any(String) } }),
        expect.objectContaining({ scope: { kind: 'user_profile' } }),
        expect.objectContaining({ scope: { kind: 'global' } }),
      ]),
    })
    expect(payload.memory.long_term).toContain('Emperor uses scoped JSON memory compaction')
    expect(loop.sharedMemory.readUser()).toContain('Prefers scoped memory compaction')
    expect(loop.sharedMemory.readTodayEpisode()).toContain('Summarized old chat messages')
    expect(loop.activeMemoryStore.loadUnarchivedHistory()).toHaveLength(0)
    expect(loop.runtimeStore.eventsForTurns(['turn_1'])).toHaveLength(0)
    expect(provider.calls.at(-1)?.model).toBe('fake-mini')

    const second = await service.compact({ force: true })
    expect(second).toMatchObject({ status: 'skipped' })

    await loop.close()
  })

  it('compacts build history into project memory while still writing profile and episode through scoped targets', async () => {
    const provider = new FakeProvider()
    provider.reply = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      episode: {
        operations: [{
          op: 'append_section_item',
          section: 'Summary',
          content: '- Build compaction captured completed project turn.',
          reason: 'manual compact summarized build turn',
          sourceSeqs: [1, 2],
          confidence: 'high',
        }],
      },
      userProfile: {
        operations: [{
          op: 'append_section_item',
          section: 'Working Style',
          content: '- Wants project facts kept out of global memory.',
          reason: 'stable working style',
          sourceSeqs: [1],
          confidence: 'high',
        }],
      },
      projectMemory: {
        operations: [{
          op: 'append_section_item',
          section: 'Build Commands',
          content: '- npm test --workspace @emperor/core',
          reason: 'verified build command belongs to project',
          sourceSeqs: [2],
          confidence: 'high',
        }],
      },
      decisions: [{
        sourceSeqs: [2],
        content: 'npm test --workspace @emperor/core',
        destination: 'project_memory',
        classification: 'project_command',
        reason: 'project command',
        confidence: 'high',
      }],
      discarded: [],
    })
    const { loop, service } = await makeService(provider)
    const projectDir = tmp('emperor-memory-service-build-compact-project-')
    const project = loop.projectStore.resolve(projectDir)
    const session = loop.sessionStore.create('Build Project', { mode: 'build', project: project as unknown as Record<string, unknown> })
    loop.activateSession(session.id)
    loop.activeMemoryStore.appendHistory('user', 'build first', { extra: { turn_id: 'turn_build_1' } })
    loop.activeMemoryStore.appendHistory('assistant', 'build reply', { extra: { turn_id: 'turn_build_1' } })

    const payload = await service.compact({ force: true })

    expect(payload.error).toBeUndefined()
    expect(payload).toMatchObject({
      status: 'compacted',
      count: 2,
      compaction: {
        mode: 'build',
        projectId: project.project_id,
        range: { fromSeq: 1, toSeq: 2 },
      },
    })
    expect(loop.projectStore.readManagedMemory(project.project_id)).toContain('npm test --workspace @emperor/core')
    expect(loop.sharedMemory.readUser()).toContain('project facts kept out of global memory')
    expect(loop.sharedMemory.readTodayEpisode()).toContain('Build compaction captured completed project turn')
    expect(loop.sharedMemory.readMemory()).not.toContain('npm test --workspace @emperor/core')
    expect(loop.activeMemoryStore.loadUnarchivedHistory()).toHaveLength(0)

    await loop.close()
  })

  it('does not clear session history when memory compaction fails', async () => {
    const provider = new FakeProvider()
    provider.reply = 'not xml'
    const { loop, service } = await makeService(provider)
    loop.activeMemoryStore.appendHistory('user', 'first', { extra: { turn_id: 'turn_1' } })
    loop.activeMemoryStore.appendHistory('assistant', 'reply', { extra: { turn_id: 'turn_1' } })

    const payload = await service.compact({ force: true })

    expect(payload).toMatchObject({
      status: 'degraded',
      count: 2,
    })
    expect(payload.message).toContain('压缩失败')
    expect(loop.activeMemoryStore.loadUnarchivedHistory()).toHaveLength(2)

    await loop.close()
  })

  it('explains the exact context plan, checkpoint, and compaction cursor for a model turn', async () => {
    const { root, loop, service } = await makeService()
    const sessionId = String(loop.activeSessionId)
    const snapshotDir = join(loop.sessionStore.sessionDir(sessionId), 'prompt-snapshots')
    writePromptSnapshot({
      dir: snapshotDir,
      sessionId,
      turnId: 'turn_explain_1',
      model: 'fake-main',
      provider: 'fake',
      modelRole: 'main',
      estimatedInputTokens: 123,
      sections: [{
        name: 'long_term_memory',
        content: '# Long-term Memory\n\n- User prefers explicit audits.',
        source: join(root, '.emperor', 'memory', 'MEMORY.local.md'),
        priority: 80,
        budgetChars: 12000,
        version: null,
        scope: 'global',
      }],
      contextPlan: {
        version: 1,
        mode: 'chat',
        activeMemoryBinding: {
          profile: { scope: { kind: 'user_profile' }, readable: true, writable: true, path: join(root, '.emperor', 'memory', 'profile', 'USER.local.md') },
          longTerm: { scope: { kind: 'global' }, readable: true, writable: true, path: join(root, '.emperor', 'memory', 'MEMORY.local.md') },
          episode: { scope: { kind: 'episode', date: '2026-07-06' }, readable: false, writable: true, path: join(root, '.emperor', 'memory', '2026-07-06.md') },
        },
        items: [],
        omitted: [{
          kind: 'project_memory',
          source: 'projects/<project-id>/AGENTS.local.md',
          reason: 'chat mode has no active bound project memory',
        }],
      },
    })
    loop.activeMemoryStore.writeCheckpoint([{ role: 'user', content: 'checkpoint draft' }])
    const cursorStore = new CompactionCursorStore(loop.paths.stateRoot)
    cursorStore.markCompacting(sessionId, {
      lastHistorySeq: 2,
      compactionId: 'compact_applied',
    })
    cursorStore.advance(sessionId, {
      compactedUntilSeq: 2,
      compactionId: 'compact_applied',
      lastHistorySeq: 2,
    })
    cursorStore.markCompacting(sessionId, {
      lastHistorySeq: 4,
      compactionId: 'compact_failed',
    })
    cursorStore.markActive(sessionId)
    const ledger = new CompactionLedger(loop.paths.stateRoot)
    ledger.recordApplied({
      compactionId: 'compact_applied',
      sessionId,
      mode: 'chat',
      trigger: { kind: 'manual', force: true },
      range: { fromSeq: 1, toSeq: 2 },
      status: 'applied',
      activeMemoryBinding: {
        profile: { scope: { kind: 'user_profile' }, readable: true, writable: true, path: join(root, '.emperor', 'memory', 'profile', 'USER.local.md') },
        longTerm: { scope: { kind: 'global' }, readable: true, writable: true, path: join(root, '.emperor', 'memory', 'MEMORY.local.md') },
        episode: { scope: { kind: 'episode', date: '2026-07-06' }, readable: false, writable: true, path: join(root, '.emperor', 'memory', '2026-07-06.md') },
      },
      input: {
        historyHash: 'history_hash',
        historyCount: 2,
        userProfileHash: 'user_hash',
        globalMemoryHash: 'global_hash',
        episodeHash: 'episode_hash',
      },
      output: {
        decisions: [{
          sourceSeqs: [1],
          content: 'explicit audits',
          destination: 'global_memory',
          classification: 'cross_session_fact',
          reason: 'durable preference',
          confidence: 'high',
        }],
        discarded: [{
          sourceSeqs: [2],
          summary: 'temporary tool output',
          reason: 'temporary_tool_output',
        }],
        targetVersions: [{
          scope: { kind: 'global' },
          beforeVersion: 1,
          beforeHash: 'before_hash',
          afterVersion: 2,
          afterHash: 'after_hash',
          operationCount: 1,
        }],
      },
    })
    ledger.recordFailed({
      compactionId: 'compact_failed',
      sessionId,
      mode: 'chat',
      trigger: { kind: 'manual', force: true },
      range: { fromSeq: 3, toSeq: 4 },
      status: 'started',
      activeMemoryBinding: {
        profile: { scope: { kind: 'user_profile' }, readable: true, writable: true, path: join(root, '.emperor', 'memory', 'profile', 'USER.local.md') },
        longTerm: { scope: { kind: 'global' }, readable: true, writable: true, path: join(root, '.emperor', 'memory', 'MEMORY.local.md') },
        episode: { scope: { kind: 'episode', date: '2026-07-06' }, readable: false, writable: true, path: join(root, '.emperor', 'memory', '2026-07-06.md') },
      },
      input: {
        historyHash: 'failed_history_hash',
        historyCount: 2,
        userProfileHash: 'user_hash',
        globalMemoryHash: 'global_hash',
        episodeHash: 'episode_hash',
      },
    }, {
      code: 'apply_failed',
      message: 'simulated failed compaction after applied baseline',
    })

    const payload = (service as any).explainContext({ sessionId, turnId: 'turn_explain_1' })

    expect(payload).toMatchObject({
      status: 'ok',
      sessionId,
      turnId: 'turn_explain_1',
      mode: 'chat',
      activeMemoryBinding: {
        profile: {
          scope: { kind: 'user_profile' },
          readable: true,
          writable: true,
        },
        longTerm: {
          scope: { kind: 'global' },
          readable: true,
          writable: true,
        },
      },
      injected: [{
        id: 'section:long_term_memory',
        kind: 'long_term_memory',
        source: join(root, '.emperor', 'memory', 'MEMORY.local.md'),
        reason: 'included_by_context_builder',
      }],
      omitted: [{
        kind: 'project_memory',
        source: 'projects/<project-id>/AGENTS.local.md',
        reason: 'chat mode has no active bound project memory',
      }],
      checkpoint: {
        exists: true,
        recoverable: true,
        historyRows: 1,
        schemaVersion: 'emperor.turn-checkpoint.v1',
        phase: 'tool_calls_pending',
        legacy: false,
      },
      compaction: {
        cursor: {
          sessionId,
          status: 'active',
          lastHistorySeq: 4,
          compactedUntilSeq: 2,
          lastCompactionId: 'compact_failed',
        },
        omittedRanges: [{
          fromSeq: 1,
          toSeq: 2,
          compactionId: 'compact_applied',
          reason: 'semantic_compaction_applied',
        }],
        latest: {
          compactionId: 'compact_applied',
          status: 'applied',
          range: { fromSeq: 1, toSeq: 2 },
          patchTargets: [{
            scope: { kind: 'global' },
            operationCount: 1,
          }],
          discardedCount: 1,
        },
      },
      microcompact: {
        records: [],
        omittedChars: 0,
      },
    })
    expect(payload.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user_profile',
        visibility: 'always_injected',
        mutability: 'managed_patch',
        injectedIn: ['chat', 'build'],
        path: join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
      }),
      expect.objectContaining({
        kind: 'global_memory',
        visibility: 'chat_only',
        injectedIn: ['chat'],
        path: join(root, '.emperor', 'memory', 'MEMORY.local.md'),
      }),
      expect.objectContaining({
        kind: 'runtime_event_log',
        visibility: 'runtime_only',
        injectedIn: [],
        path: loop.runtimeStore.eventsFile,
      }),
      expect.objectContaining({
        kind: 'prompt_snapshot',
        visibility: 'debug_only',
        injectedIn: [],
        path: snapshotDir,
      }),
    ]))

    await loop.close()
  })
})

async function makeService(provider: FakeProvider = new FakeProvider()): Promise<{
  root: string
  loop: AgentLoop
  service: CoreMemoryService
  refreshes: () => number
}> {
  const root = tmp('emperor-memory-service-')
  let refreshCount = 0
  const loop = await AgentLoop.create({
    root,
    stateRoot: join(root, '.emperor'),
    templatesDir: TEMPLATES_DIR,
    modelRouter: fakeRouter(provider),
    initializeMcp: false,
  })
  const watchlist = new WatchlistService(root, {
    decider: () => WatchlistDecision.skip('manual check'),
    tokenTracker: loop.tokenTracker,
  })
  const service = new CoreMemoryService(root, {
    loop,
    watchlist,
    refreshRuntimeContext: () => { refreshCount += 1 },
  })
  return { root, loop, service, refreshes: () => refreshCount }
}

class FakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  reply = 'pong'

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return {
      content: this.reply,
      toolCalls: [],
      finishReason: 'stop',
      usage: { input: 1, output: 1 },
      reasoningContent: null,
      thinkingBlocks: null,
    }
  }
}

function fakeRouter(provider: FakeProvider): { route: (useCase: string) => ModelRoute; payload: () => Record<string, unknown> } {
  return {
    route: (useCase: string) => ({
      snapshot: snapshot(provider, useCase === 'main_agent' ? 'main' : 'secondary'),
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({ mainModel: 'fake-main', secondaryModel: 'fake-mini' }),
  }
}

function snapshot(provider: FakeProvider, role: 'main' | 'secondary'): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: role === 'main' ? 'fake-main' : 'fake-mini',
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100000,
    config: {},
    supportsVision: false,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: role,
    routeReason: `${role}_model`,
  }
}
