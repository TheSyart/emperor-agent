import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import {
  SCHEDULER_TARGET_SESSION_METADATA_KEY,
  SchedulerPayload,
  SchedulerSchedule,
} from '../scheduler/models'
import { CoreApi } from './core-api'
import { MainlineTurnService } from './chat-service'
import { LEGACY_SKILL_STATE_FILE } from '../runtime/resources'
import { CancelledTaskError } from '../runtime/active'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

function skillDocument(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

describe('MainlineTurnService (MIG-IPC-005)', () => {
  it('submits chat turns through AgentLoop and returns durable turn metadata', async () => {
    const root = tmp('emperor-mainline-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const events: Array<Record<string, unknown>> = []
    const session = api.sessions.create({ title: 'Mainline' })

    const result = await api.mainline.submit({
      content: 'ping',
      displayContent: 'Ping display',
      clientMessageId: 'client-1',
      turnId: 'turn_main_1',
      source: 'chat',
      sessionId: String(session.id),
      emit: async (event) => {
        events.push(event)
      },
    })

    expect(result).toMatchObject({
      turnId: 'turn_main_1',
      content: 'pong',
      activeSessionId: api.loop.activeSessionId,
    })
    expect(events.map((event) => event.event)).toContain('user_message')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(
      api.loop.activeMemoryStore.loadUnarchivedHistory().map((row) => row.role),
    ).toEqual(['user', 'assistant'])
    expect(
      JSON.stringify(api.loop.activeMemoryStore.loadUnarchivedHistory()),
    ).toContain('Ping display')
    expect(
      existsSync(
        join(
          root,
          '.emperor',
          'sessions',
          api.loop.activeSessionId!,
          'history.jsonl',
        ),
      ),
    ).toBe(true)

    await api.close()
  })

  it('backs CoreApi chat.submit with the same mainline service', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-'),
      stateRoot: tmp('emperor-mainline-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = api.sessions.create({ title: 'Chat' })

    expect(api.mainline).toBeInstanceOf(MainlineTurnService)
    await expect(
      api.chat.submit({
        content: 'hello',
        turnId: 'turn_chat_1',
        sessionId: String(session.id),
      }),
    ).resolves.toMatchObject({ turnId: 'turn_chat_1', content: 'pong' })

    await api.close()
  })

  it('delivers attachment content and requested skill metadata through the turn', async () => {
    const root = tmp('emperor-mainline-attachments-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Attachments' })
    const skillDir = join(root, '.emperor', 'skills', 'reviewer')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      skillDocument(
        'reviewer',
        'Review supplied evidence.',
        '# Reviewer Skill\n\nGeneral review helper.\n\nREQUESTED_SKILL_CONTEXT_MARKER',
      ),
      'utf8',
    )
    const attachment = api.attachments.save({
      raw: Buffer.from('attachment evidence', 'utf8'),
      name: 'evidence.txt',
      mime: 'text/plain',
    })
    const events: Array<Record<string, unknown>> = []

    await api.chat.submit({
      content: 'inspect',
      displayContent: 'inspect @skill(reviewer)',
      attachments: [attachment.id],
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
      turnId: 'turn_attachment_1',
      sessionId: String(session.id),
      emit: async (event) => {
        events.push(event)
      },
    })

    const userMessage = provider.calls[0]?.messages.find(
      (message) => message.role === 'user',
    )
    expect(String(userMessage?.content)).toContain('attachment evidence')
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain(
      'REQUESTED_SKILL_CONTEXT_MARKER',
    )
    const history = api.loop.activeMemoryStore.loadUnarchivedHistory()
    expect(history.find((row) => row.role === 'user')).toMatchObject({
      attachments: [expect.objectContaining({ id: attachment.id })],
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
    })
    expect(
      events.find((event) => event.event === 'user_message'),
    ).toMatchObject({
      attachments: [expect.objectContaining({ id: attachment.id })],
      requested_skills: [{ name: 'reviewer', source: 'slash' }],
    })

    await api.close()
  })

  it('rejects an unavailable explicitly requested skill before model execution', async () => {
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-missing-skill-'),
      stateRoot: tmp('emperor-mainline-missing-skill-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Missing Skill' })

    await expect(
      api.chat.submit({
        content: 'review',
        requestedSkills: [{ name: 'missing-skill', source: 'slash' }],
        sessionId: String(session.id),
      }),
    ).rejects.toMatchObject({
      code: 'requested_skill_unavailable',
      skillName: 'missing-skill',
    })
    expect(provider.calls).toHaveLength(0)

    await api.close()
  })

  it('does not activate a legacy Skill marked blocked pending review', async () => {
    const root = tmp('emperor-mainline-blocked-skill-')
    const stateRoot = join(root, '.emperor')
    const skillRoot = join(stateRoot, 'skills', 'legacy-review')
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      '# Legacy Review\n\nBLOCKED_LEGACY_SKILL_MARKER',
      'utf8',
    )
    writeFileSync(
      join(skillRoot, LEGACY_SKILL_STATE_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        status: 'blocked_pending_review',
        source: 'legacy_runtime',
      })}\n`,
      'utf8',
    )
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Blocked Skill' })

    await expect(
      api.chat.submit({
        content: 'review',
        requestedSkills: [{ name: 'legacy-review', source: 'slash' }],
        sessionId: String(session.id),
      }),
    ).rejects.toMatchObject({ code: 'requested_skill_unavailable' })
    expect(provider.calls).toHaveLength(0)

    await api.close()
  })

  it('uses stateRoot Skill content ahead of signed built-in content', async () => {
    const root = tmp('emperor-mainline-skill-precedence-')
    const stateRoot = join(root, '.emperor')
    const builtinRoot = join(root, 'skills', 'reviewer')
    const userRoot = join(stateRoot, 'skills', 'reviewer')
    mkdirSync(builtinRoot, { recursive: true })
    mkdirSync(userRoot, { recursive: true })
    writeFileSync(
      join(builtinRoot, 'SKILL.md'),
      skillDocument(
        'reviewer',
        'Review code from the signed runtime.',
        '# Reviewer\n\nGeneral reviewer.\n\nSIGNED_BUILTIN_MARKER',
      ),
      'utf8',
    )
    writeFileSync(
      join(userRoot, 'SKILL.md'),
      skillDocument(
        'reviewer',
        'Review code from user state.',
        '# Reviewer\n\nGeneral reviewer.\n\nUSER_STATE_OVERRIDE_MARKER',
      ),
      'utf8',
    )
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Skill Precedence' })

    await api.chat.submit({
      content: 'review',
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
      sessionId: String(session.id),
    })

    const messages = JSON.stringify(provider.calls[0]?.messages)
    expect(messages).toContain('USER_STATE_OVERRIDE_MARKER')
    expect(messages).not.toContain('SIGNED_BUILTIN_MARKER')

    await api.close()
  })

  it('keeps flat user Skills visible in the runtime Skill summary', async () => {
    const root = tmp('emperor-mainline-flat-skill-')
    const stateRoot = join(root, '.emperor')
    mkdirSync(join(stateRoot, 'skills'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'flat-review.md'),
      '# Flat Review\n\nGeneral flat reviewer.\n',
      'utf8',
    )
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Flat Skill' })

    await api.chat.submit({ content: 'hello', sessionId: String(session.id) })

    expect(JSON.stringify(provider.calls[0]?.messages)).toContain(
      '- flat-review: General flat reviewer.',
    )
    await api.close()
  })

  it('rejects chat submits without a real known session id before writing history', async () => {
    const root = tmp('emperor-mainline-session-boundary-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const activeSessionId = String(api.loop.activeSessionId)

    await expect(
      api.chat.submit({ content: 'missing session' }),
    ).rejects.toThrow(/session/i)
    await expect(
      api.chat.submit({ content: 'unknown session', sessionId: 'not-real' }),
    ).rejects.toThrow(/unknown|session/i)
    // P1-6 起 draft 提交不再被拒，而是晋升为真实 session（见 core-api.test 的 draft submit 用例）

    const historyPath = join(
      root,
      '.emperor',
      'sessions',
      activeSessionId,
      'history.jsonl',
    )
    expect(
      existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim() : '',
    ).toBe('')

    await api.close()
  })

  it('writes the first build-session chat turn to the build session history only', async () => {
    const root = tmp('emperor-mainline-build-session-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const defaultSessionId = String(api.loop.activeSessionId)
    const projectPath = join(root, 'project')
    mkdirSync(projectPath, { recursive: true })
    const build = api.sessions.create({
      title: 'Build Project',
      mode: 'build',
      project_path: projectPath,
    })
    api.control.setMode('auto')

    await api.chat.submit({
      content: 'ping',
      turnId: 'turn_build_1',
      sessionId: String(build.id),
    })

    const buildHistory = readFileSync(
      join(root, '.emperor', 'sessions', String(build.id), 'history.jsonl'),
      'utf8',
    )
    expect(buildHistory).toContain('ping')
    const defaultHistory = join(
      root,
      '.emperor',
      'sessions',
      defaultSessionId,
      'history.jsonl',
    )
    expect(
      existsSync(defaultHistory)
        ? readFileSync(defaultHistory, 'utf8').trim()
        : '',
    ).toBe('')
    expect(api.loop.sessionStore.get(String(build.id))).toMatchObject({
      mode: 'build',
      project_path: projectPath,
      project_name: 'project',
    })

    await api.close()
  })

  it('runs different session actors concurrently without crossing history or runtime ownership', async () => {
    const root = tmp('emperor-mainline-concurrent-turn-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const first = api.sessions.create({ title: 'First' })
    const second = api.sessions.create({ title: 'Second' })

    const running = api.chat.submit({
      content: 'first',
      turnId: 'turn_busy_1',
      sessionId: String(first.id),
    })
    await provider.waitForCalls(1)
    const runningSecond = api.chat.submit({
      content: 'second',
      turnId: 'turn_busy_2',
      sessionId: String(second.id),
    })
    await provider.waitForCalls(2)
    expect(
      api.loop.activeTasks
        .list()
        .map((task) => task.session_id)
        .sort(),
    ).toEqual([String(first.id), String(second.id)].sort())

    provider.finish(1, response('second done'))
    await expect(runningSecond).resolves.toMatchObject({
      content: 'second done',
      activeSessionId: String(second.id),
    })
    const secondBootstrap = await api.bootstrap({
      sessionId: String(second.id),
    })
    expect(secondBootstrap.runtime).toMatchObject({
      busy: false,
      active_tasks: [expect.objectContaining({ session_id: String(first.id) })],
    })
    provider.finish(0, response('first done'))
    await expect(running).resolves.toMatchObject({
      content: 'first done',
      activeSessionId: String(first.id),
    })

    const firstHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      String(first.id),
      'history.jsonl',
    )
    const secondHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      String(second.id),
      'history.jsonl',
    )
    const firstHistory = readFileSync(firstHistoryPath, 'utf8')
    const secondHistory = readFileSync(secondHistoryPath, 'utf8')
    expect(firstHistory).toContain('first done')
    expect(firstHistory).not.toContain('second done')
    expect(secondHistory).toContain('second done')
    expect(secondHistory).not.toContain('first done')

    const firstReplay = api.runtime.replay({ sessionId: String(first.id) })
    const secondReplay = api.runtime.replay({ sessionId: String(second.id) })
    expect(firstReplay.events.map((event) => event.turn_id)).not.toContain(
      'turn_busy_2',
    )
    expect(secondReplay.events.map((event) => event.turn_id)).not.toContain(
      'turn_busy_1',
    )

    await api.close()
  })

  it('serializes two submits to the same session mailbox by command id', async () => {
    const root = tmp('emperor-mainline-session-mailbox-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Mailbox' })

    const first = api.chat.submit({
      content: 'first queued',
      turnId: 'turn_queue_1',
      sessionId: String(session.id),
    })
    await provider.waitForCalls(1)
    const second = api.chat.submit({
      content: 'second queued',
      turnId: 'turn_queue_2',
      clientMessageId: 'client_queue_2',
      sessionId: String(session.id),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(provider.calls).toHaveLength(1)
    expect(
      api.runtime
        .replay({ sessionId: String(session.id) })
        .events.find((event) => event.event === 'prompt_queued'),
    ).toMatchObject({
      turn_id: 'turn_queue_2',
      prompt_id: 'client_queue_2',
      delivery: 'queue',
    })

    provider.finish(0, response('first complete'))
    await expect(first).resolves.toMatchObject({ content: 'first complete' })
    await provider.waitForCalls(2)
    provider.finish(1, response('second complete'))
    await expect(second).resolves.toMatchObject({ content: 'second complete' })
    expect(
      provider.calls[1]!.messages.filter(
        (message) => message.role === 'assistant',
      ).map((message) => message.content),
    ).toContain('first complete')
    expect(
      api.runtime
        .replay({ sessionId: String(session.id) })
        .events.map((event) => event.event),
    ).toContain('prompt_dequeued')
    expect(
      api.loop.sessionRuntimes
        .get(String(session.id))!
        .bindings.conversationStore.messageGraph.snapshot().prompts,
    ).toContainEqual(
      expect.objectContaining({
        id: 'client_queue_2',
        state: 'completed',
        delivery: 'queue',
      }),
    )

    await api.close()
  })

  it('admits only one queued chat prompt per session and rejects the second without durable side effects', async () => {
    const root = tmp('emperor-mainline-single-queue-slot-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Single queue slot' })
    const sessionId = String(session.id)
    const running = api.chat.submit({
      content: 'owner turn',
      turnId: 'turn_single_slot_owner',
      sessionId,
    })
    await provider.waitForCalls(1)

    const firstQueued = api.chat.submit({
      content: 'first queued prompt',
      turnId: 'turn_single_slot_first',
      clientMessageId: 'prompt_single_slot_first',
      sessionId,
    })
    const rejectedEvents: Array<Record<string, unknown>> = []
    const secondOutcome = api.chat
      .submit({
        content: 'second queued prompt',
        turnId: 'turn_single_slot_second',
        clientMessageId: 'prompt_single_slot_second',
        sessionId,
        emit: async (event) => {
          rejectedEvents.push(event)
        },
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )

    provider.finish(0, response('owner complete'))
    await running
    await provider.waitForCalls(2)
    provider.finish(1, response('first queue complete'))
    await firstQueued

    const earlyOutcome = await Promise.race([
      secondOutcome,
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), 30),
      ),
    ])
    if (earlyOutcome === 'pending') {
      await provider.waitForCalls(3)
      provider.finish(2, response('unexpected second queue result'))
    }
    const outcome = await secondOutcome

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'prompt_queue_full',
        capacity: 1,
        sessionId,
      },
    })
    expect(
      rejectedEvents.filter((event) => event.event === 'prompt_queued'),
    ).toEqual([])
    expect(
      api.runtime
        .replay({ sessionId })
        .events.filter(
          (event) => event.prompt_id === 'prompt_single_slot_second',
        ),
    ).toEqual([])
    expect(
      api.loop.sessionRuntimes
        .actor(sessionId)
        .bindings.conversationStore.messageGraph.snapshot().prompts,
    ).not.toContainEqual(
      expect.objectContaining({ id: 'prompt_single_slot_second' }),
    )

    await api.close()
  })

  it('keeps one independent visible queue slot for each session', async () => {
    const root = tmp('emperor-mainline-single-queue-per-session-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const firstSession = api.sessions.create({ title: 'First session' })
    const secondSession = api.sessions.create({ title: 'Second session' })
    const firstId = String(firstSession.id)
    const secondId = String(secondSession.id)

    const firstOwner = api.chat.submit({
      content: 'first owner',
      turnId: 'turn_first_owner',
      sessionId: firstId,
    })
    const secondOwner = api.chat.submit({
      content: 'second owner',
      turnId: 'turn_second_owner',
      sessionId: secondId,
    })
    await provider.waitForCalls(2)
    const firstQueued = api.chat.submit({
      content: 'first session queued',
      turnId: 'turn_first_session_queued',
      clientMessageId: 'prompt_first_session_queued',
      sessionId: firstId,
    })
    const secondQueued = api.chat.submit({
      content: 'second session queued',
      turnId: 'turn_second_session_queued',
      clientMessageId: 'prompt_second_session_queued',
      sessionId: secondId,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(api.chat.listQueuedPrompts({ sessionId: firstId })).toHaveLength(1)
    expect(api.chat.listQueuedPrompts({ sessionId: secondId })).toHaveLength(1)

    provider.finish(0, response('first owner complete'))
    provider.finish(1, response('second owner complete'))
    await Promise.all([firstOwner, secondOwner])
    await provider.waitForCalls(4)
    provider.finish(2, response('first queue complete'))
    provider.finish(3, response('second queue complete'))
    await Promise.all([firstQueued, secondQueued])
    await api.close()
  })

  it('preserves and drains multiple legacy queued prompts in FIFO order', async () => {
    const root = tmp('emperor-mainline-legacy-multi-queue-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Legacy multi queue' })
    const sessionId = String(session.id)
    const graph =
      api.loop.sessionRuntimes.actor(sessionId).bindings.conversationStore
        .messageGraph
    for (const [id, content] of [
      ['prompt_legacy_first', 'legacy first'],
      ['prompt_legacy_second', 'legacy second'],
    ] as const) {
      graph.recordPrompt({
        id,
        turnId: `turn_${id}`,
        clientMessageId: id,
        delivery: 'queue',
        content,
        displayContent: content,
        supportsInterjection: true,
      })
    }

    expect(
      api.chat.listQueuedPrompts({ sessionId }).map((prompt) => prompt.id),
    ).toEqual(['prompt_legacy_first', 'prompt_legacy_second'])
    await provider.waitForCalls(1)
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain(
      'legacy first',
    )
    provider.finish(0, response('legacy first complete'))
    await provider.waitForCalls(2)
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      'legacy second',
    )
    provider.finish(1, response('legacy second complete'))
    await vi.waitFor(() => {
      expect(graph.snapshot().prompts.map((prompt) => prompt.state)).toEqual([
        'completed',
        'completed',
      ])
    })
    await api.close()
  })

  it('does not reconcile a live running queued prompt as a crash orphan during list refresh', async () => {
    const root = tmp('emperor-mainline-live-queue-refresh-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Live queue refresh' })
    const sessionId = String(session.id)
    const owner = api.chat.submit({
      content: 'owner request',
      turnId: 'turn_live_refresh_owner',
      sessionId,
    })
    await provider.waitForCalls(1)
    const queued = api.chat.submit({
      content: 'live queued request',
      turnId: 'turn_live_refresh_queued',
      clientMessageId: 'prompt_live_refresh_queued',
      sessionId,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(api.chat.listQueuedPrompts({ sessionId })).toHaveLength(1)

    provider.finish(0, response('owner complete'))
    await owner
    await provider.waitForCalls(2)
    await new Promise((resolve) => setTimeout(resolve, 80))
    provider.finish(1, response('queued complete'))

    await expect(queued).resolves.toMatchObject({ content: 'queued complete' })
    expect(
      api.loop.sessionRuntimes
        .actor(sessionId)
        .bindings.conversationStore.messageGraph.snapshot().prompts,
    ).toContainEqual(
      expect.objectContaining({
        id: 'prompt_live_refresh_queued',
        state: 'completed',
      }),
    )
    await api.close()
  })

  it('does not enqueue a second command for a live pending interjection during list refresh', async () => {
    const root = tmp('emperor-mainline-live-interjection-refresh-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Live interjection refresh' })
    const sessionId = String(session.id)
    const owner = api.chat.submit({
      content: 'owner request',
      turnId: 'turn_live_interjection_owner',
      sessionId,
    })
    await provider.waitForCalls(1)
    await expect(
      api.chat.submit({
        content: 'live interjection',
        turnId: 'turn_live_interjection',
        clientMessageId: 'prompt_live_interjection',
        sessionId,
        delivery: 'interject',
      }),
    ).resolves.toMatchObject({ delivery: 'interjected' })
    expect(api.chat.listQueuedPrompts({ sessionId })).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(
      api.loop.sessionRuntimes
        .actor(sessionId)
        .commandState('turn:turn_live_interjection'),
    ).toBeNull()

    provider.finish(0, response('obsolete owner response'))
    await provider.waitForCalls(2)
    provider.finish(1, response('interjection complete'))
    await owner
    await api.close()
  })

  it('lists and cancels a queued prompt exactly once', async () => {
    const root = tmp('emperor-mainline-manage-queue-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Managed queue' })
    const running = api.chat.submit({
      content: 'keep running',
      turnId: 'turn_manage_owner',
      sessionId: String(session.id),
    })
    await provider.waitForCalls(1)
    const queued = api.chat.submit({
      content: 'cancel queued',
      displayContent: 'Cancel queued',
      turnId: 'turn_manage_queued',
      clientMessageId: 'prompt_manage_queued',
      sessionId: String(session.id),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      api.chat.listQueuedPrompts({ sessionId: String(session.id) }),
    ).toEqual([
      expect.objectContaining({
        id: 'prompt_manage_queued',
        displayContent: 'Cancel queued',
        state: 'queued',
        supportsInterjection: true,
      }),
    ])
    await expect(
      api.chat.manageQueuedPrompt({
        sessionId: String(session.id),
        promptId: 'prompt_manage_queued',
        action: 'cancel',
      }),
    ).resolves.toMatchObject({ ok: true, replacementPromptId: null })
    expect(
      api.chat.listQueuedPrompts({ sessionId: String(session.id) }),
    ).toEqual([])
    expect(
      api.runtime
        .replay({ sessionId: String(session.id) })
        .events.filter(
          (event) =>
            event.event === 'prompt_cancelled' &&
            event.prompt_id === 'prompt_manage_queued',
        ),
    ).toHaveLength(1)

    const replacement = api.chat.submit({
      content: 'replacement queued after cancel',
      displayContent: 'Replacement queued after cancel',
      turnId: 'turn_manage_replacement',
      clientMessageId: 'prompt_manage_replacement',
      sessionId: String(session.id),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      api.chat.listQueuedPrompts({ sessionId: String(session.id) }),
    ).toEqual([
      expect.objectContaining({
        id: 'prompt_manage_replacement',
        state: 'queued',
      }),
    ])

    provider.finish(0, response('owner complete'))
    await running
    await expect(queued).rejects.toMatchObject({
      code: 'session_runtime_command_cancelled',
    })
    await provider.waitForCalls(2)
    provider.finish(1, response('replacement complete'))
    await expect(replacement).resolves.toMatchObject({
      content: 'replacement complete',
    })
    await api.close()
  })

  it('restores a crash-orphaned durable queue item and keeps it cancellable', async () => {
    const root = tmp('emperor-mainline-recover-cancel-')
    const stateRoot = join(root, '.emperor')
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = first.sessions.create({ title: 'Recover cancel' })
    first.loop.sessionRuntimes
      .actor(String(session.id))
      .bindings.conversationStore.messageGraph.recordPrompt({
        id: 'prompt_recover_cancel',
        turnId: 'turn_recover_cancel',
        clientMessageId: 'prompt_recover_cancel',
        delivery: 'queue',
        content: 'cancel after restart',
        displayContent: 'Cancel after restart',
        supportsInterjection: true,
      })
    await first.close()

    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    expect(
      second.chat.listQueuedPrompts({ sessionId: String(session.id) }),
    ).toEqual([
      expect.objectContaining({
        id: 'prompt_recover_cancel',
        content: 'cancel after restart',
        state: 'queued',
      }),
    ])
    await expect(
      second.chat.manageQueuedPrompt({
        sessionId: String(session.id),
        promptId: 'prompt_recover_cancel',
        action: 'cancel',
      }),
    ).resolves.toMatchObject({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(
      second.runtime
        .replay({ sessionId: String(session.id) })
        .events.filter(
          (event) =>
            event.event === 'prompt_cancelled' &&
            event.prompt_id === 'prompt_recover_cancel',
        ),
    ).toHaveLength(1)
    await second.close()
  })

  it('rehydrates and executes a crash-orphaned durable queue item exactly once', async () => {
    const root = tmp('emperor-mainline-recover-execute-')
    const stateRoot = join(root, '.emperor')
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = first.sessions.create({ title: 'Recover execute' })
    first.loop.sessionRuntimes
      .actor(String(session.id))
      .bindings.conversationStore.messageGraph.recordPrompt({
        id: 'prompt_recover_execute',
        turnId: 'turn_recover_execute',
        clientMessageId: 'prompt_recover_execute',
        delivery: 'queue',
        content: 'execute after restart',
        displayContent: 'Execute after restart',
        supportsInterjection: true,
      })
    await first.close()

    const provider = new ConcurrentBlockingProvider()
    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    expect(
      second.chat.listQueuedPrompts({ sessionId: String(session.id) }),
    ).toHaveLength(1)
    await provider.waitForCalls(1)
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain(
      'execute after restart',
    )
    provider.finish(0, response('recovered result'))
    await vi.waitFor(() => {
      const prompt = second.loop.sessionRuntimes
        .actor(String(session.id))
        .bindings.conversationStore.messageGraph.snapshot()
        .prompts.find((item) => item.id === 'prompt_recover_execute')
      expect(prompt?.state).toBe('completed')
    })
    expect(provider.calls).toHaveLength(1)
    await second.close()
  })

  it('requeues a crash-orphaned running prompt that never reached user history', async () => {
    const root = tmp('emperor-mainline-recover-running-before-start-')
    const stateRoot = join(root, '.emperor')
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = first.sessions.create({ title: 'Recover running prompt' })
    const firstGraph = first.loop.sessionRuntimes.actor(String(session.id))
      .bindings.conversationStore.messageGraph
    firstGraph.recordPrompt({
      id: 'prompt_running_orphan',
      turnId: 'turn_running_orphan',
      clientMessageId: 'prompt_running_orphan',
      delivery: 'queue',
      content: 'run after crash',
      displayContent: 'Run after crash',
      supportsInterjection: true,
    })
    firstGraph.transitionPrompt('prompt_running_orphan', 'running')
    await first.close()

    const provider = new ConcurrentBlockingProvider()
    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    expect(
      second.chat.listQueuedPrompts({ sessionId: String(session.id) }),
    ).toEqual([])
    await provider.waitForCalls(1)
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain(
      'run after crash',
    )
    provider.finish(0, response('running prompt recovered'))
    await vi.waitFor(() => {
      const prompts = second.loop.sessionRuntimes
        .actor(String(session.id))
        .bindings.conversationStore.messageGraph.snapshot().prompts
      expect(prompts).toContainEqual(
        expect.objectContaining({
          id: 'prompt_running_orphan',
          state: 'cancelled',
        }),
      )
      expect(prompts).toContainEqual(
        expect.objectContaining({
          state: 'completed',
          content: 'run after crash',
        }),
      )
    })
    expect(provider.calls).toHaveLength(1)
    await second.close()
  })

  it('does not replay a crash-orphaned running prompt already committed to user history', async () => {
    const root = tmp('emperor-mainline-recover-running-after-start-')
    const stateRoot = join(root, '.emperor')
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = first.sessions.create({ title: 'Reconcile started prompt' })
    const bindings = first.loop.sessionRuntimes.actor(
      String(session.id),
    ).bindings
    bindings.conversationStore.messageGraph.recordPrompt({
      id: 'prompt_started_orphan',
      turnId: 'turn_started_orphan',
      clientMessageId: 'prompt_started_orphan',
      delivery: 'queue',
      content: 'must not run twice',
      displayContent: 'Must not run twice',
      supportsInterjection: true,
    })
    bindings.conversationStore.messageGraph.transitionPrompt(
      'prompt_started_orphan',
      'running',
    )
    bindings.memoryStore.appendHistory('user', 'must not run twice', {
      extra: { turn_id: 'turn_started_orphan' },
    })
    await first.close()

    const provider = new ConcurrentBlockingProvider()
    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    second.chat.listQueuedPrompts({ sessionId: String(session.id) })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(provider.calls).toHaveLength(0)
    expect(
      second.loop.sessionRuntimes
        .actor(String(session.id))
        .bindings.conversationStore.messageGraph.snapshot().prompts,
    ).toContainEqual(
      expect.objectContaining({
        id: 'prompt_started_orphan',
        state: 'cancelled',
      }),
    )
    await second.close()
  })

  it('atomically replaces a queued prompt with an interjection', async () => {
    const root = tmp('emperor-mainline-promote-queue-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Promote queue' })
    const running = api.chat.submit({
      content: 'original request',
      turnId: 'turn_promote_owner',
      sessionId: String(session.id),
    })
    await provider.waitForCalls(1)
    const queued = api.chat.submit({
      content: 'urgent correction',
      turnId: 'turn_promote_queued',
      clientMessageId: 'prompt_promote_queued',
      sessionId: String(session.id),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const promoted = await api.chat.manageQueuedPrompt({
      sessionId: String(session.id),
      promptId: 'prompt_promote_queued',
      action: 'interject',
    })
    expect(promoted).toMatchObject({
      ok: true,
      promptId: 'prompt_promote_queued',
    })
    expect(promoted.replacementPromptId).toContain(
      'prompt_promote_queued:interject:',
    )
    provider.finish(0, response('obsolete answer'))
    await provider.waitForCalls(2)
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      'urgent correction',
    )
    provider.finish(1, response('corrected answer'))
    await expect(running).resolves.toMatchObject({
      content: 'corrected answer',
    })
    await expect(queued).rejects.toMatchObject({
      code: 'session_runtime_command_cancelled',
    })
    const events = api.runtime.replay({ sessionId: String(session.id) }).events
    expect(
      events.filter(
        (event) =>
          event.event === 'prompt_cancelled' &&
          event.prompt_id === 'prompt_promote_queued',
      ),
    ).toHaveLength(1)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'prompt_queued',
          prompt_id: promoted.replacementPromptId,
          delivery: 'interject',
        }),
        expect.objectContaining({
          event: 'prompt_interjected',
          prompt_id: promoted.replacementPromptId,
        }),
      ]),
    )

    await api.close()
  })

  it('cancels a direct queued interjection without interrupting its owner turn', async () => {
    const root = tmp('emperor-mainline-cancel-direct-interjection-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Cancel interjection' })
    const owner = api.chat.submit({
      content: 'owner prompt',
      turnId: 'turn_cancel_interjection_owner',
      sessionId: String(session.id),
    })
    await provider.waitForCalls(1)
    await expect(
      api.chat.submit({
        content: 'cancel this interjection',
        turnId: 'turn_cancel_direct_interjection',
        clientMessageId: 'prompt_cancel_direct_interjection',
        sessionId: String(session.id),
        delivery: 'interject',
      }),
    ).resolves.toMatchObject({ delivery: 'interjected' })

    await expect(
      api.chat.manageQueuedPrompt({
        sessionId: String(session.id),
        promptId: 'prompt_cancel_direct_interjection',
        action: 'cancel',
      }),
    ).resolves.toMatchObject({ ok: true })
    provider.finish(0, response('owner completed'))
    await expect(owner).resolves.toMatchObject({ content: 'owner completed' })

    expect(provider.calls).toHaveLength(1)
    expect(JSON.stringify(provider.calls[0]!.messages)).not.toContain(
      'cancel this interjection',
    )
    expect(
      api.runtime
        .replay({ sessionId: String(session.id) })
        .events.filter(
          (event) =>
            event.event === 'prompt_cancelled' &&
            event.prompt_id === 'prompt_cancel_direct_interjection',
        ),
    ).toHaveLength(1)
    await api.close()
  })

  it('preserves a queued prompt when cancellation races the running turn', async () => {
    const root = tmp('emperor-mainline-cancel-queue-race-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Cancel queue race' })
    const first = api.chat.submit({
      content: 'cancel this turn',
      turnId: 'turn_cancel_owner',
      sessionId: String(session.id),
    })
    await provider.waitForCalls(1)
    const second = api.chat.submit({
      content: 'keep queued prompt',
      turnId: 'turn_keep_queued',
      clientMessageId: 'client_keep_queued',
      sessionId: String(session.id),
    })

    expect(
      api.loop.activeTasks.cancel({ taskId: 'turn:turn_cancel_owner' }),
    ).toHaveLength(1)
    await expect(first).rejects.toBeInstanceOf(CancelledTaskError)
    await provider.waitForCalls(2)
    provider.finish(1, response('queued prompt survived'))
    await expect(second).resolves.toMatchObject({
      content: 'queued prompt survived',
    })
    provider.finish(0, response('late cancelled response'))
    expect(
      api.loop.sessionRuntimes
        .get(String(session.id))!
        .bindings.conversationStore.messageGraph.snapshot().prompts,
    ).toContainEqual(
      expect.objectContaining({
        id: 'client_keep_queued',
        state: 'completed',
      }),
    )

    await api.close()
  })

  it('interjects a busy turn at the next model boundary and tombstones the superseded partial', async () => {
    const root = tmp('emperor-mainline-session-interject-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Interjection' })

    const running = api.chat.submit({
      content: 'original prompt',
      turnId: 'turn_interject_owner',
      sessionId: String(session.id),
    })
    await provider.waitForCalls(1)
    const interjected = await api.chat.submit({
      content: 'new instruction',
      displayContent: 'New instruction',
      clientMessageId: 'client_interjection',
      turnId: 'turn_interjection_prompt',
      sessionId: String(session.id),
      delivery: 'interject',
    })

    expect(interjected).toMatchObject({
      turnId: 'turn_interjection_prompt',
      content: '',
      delivery: 'interjected',
      targetTurnId: 'turn_interject_owner',
    })
    provider.finish(0, response('obsolete partial answer'))
    await provider.waitForCalls(2)
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      'new instruction',
    )
    provider.finish(1, response('final answer'))
    await expect(running).resolves.toMatchObject({ content: 'final answer' })

    const history = readFileSync(
      join(root, '.emperor', 'sessions', String(session.id), 'history.jsonl'),
      'utf8',
    )
    expect(history).toContain('original prompt')
    expect(history).toContain('new instruction')
    expect(history).toContain('final answer')
    expect(history).not.toContain('obsolete partial answer')
    const graph = api.loop.sessionRuntimes
      .get(String(session.id))!
      .bindings.conversationStore.messageGraph.snapshot()
    expect(graph.prompts).toContainEqual(
      expect.objectContaining({
        id: 'client_interjection',
        state: 'completed',
      }),
    )
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'obsolete partial answer',
          status: 'tombstoned',
          tombstoneReason: 'interjected',
        }),
      ]),
    )
    const replay = api.runtime.replay({ sessionId: String(session.id) })
    expect(replay.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'prompt_queued',
        'prompt_interjected',
        'message_tombstoned',
      ]),
    )

    await api.close()
  })

  it('does not deliver a completed interjection twice when its client id is retried after restart', async () => {
    const root = tmp('emperor-mainline-interjection-idempotency-')
    const stateRoot = join(root, '.emperor')
    const firstProvider = new ConcurrentBlockingProvider()
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(firstProvider),
    })
    const session = first.sessions.create({ title: 'Interjection idempotency' })
    const firstTurn = first.chat.submit({
      content: 'first owner',
      turnId: 'turn_idempotent_owner_1',
      sessionId: String(session.id),
    })
    await firstProvider.waitForCalls(1)
    await expect(
      first.chat.submit({
        content: 'durable interjection',
        turnId: 'turn_idempotent_interjection',
        clientMessageId: 'client_idempotent_interjection',
        sessionId: String(session.id),
        delivery: 'interject',
      }),
    ).resolves.toMatchObject({ delivery: 'interjected' })
    firstProvider.finish(0, response('obsolete'))
    await firstProvider.waitForCalls(2)
    firstProvider.finish(1, response('first final'))
    await firstTurn
    await first.close()

    const secondProvider = new ConcurrentBlockingProvider()
    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(secondProvider),
    })
    const secondTurn = second.chat.submit({
      content: 'second owner',
      turnId: 'turn_idempotent_owner_2',
      sessionId: String(session.id),
    })
    await secondProvider.waitForCalls(1)
    await expect(
      second.chat.submit({
        content: 'durable interjection',
        turnId: 'turn_idempotent_interjection_retry',
        clientMessageId: 'client_idempotent_interjection',
        sessionId: String(session.id),
        delivery: 'interject',
      }),
    ).resolves.toMatchObject({ delivery: 'interjected' })
    secondProvider.finish(0, response('second final'))
    await secondTurn

    expect(secondProvider.calls).toHaveLength(1)
    const history = readFileSync(
      join(root, '.emperor', 'sessions', String(session.id), 'history.jsonl'),
      'utf8',
    )
    expect(
      history
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(
          (row) =>
            row.role === 'user' &&
            String(row.content || '').includes('durable interjection'),
        ),
    ).toHaveLength(1)
    await second.close()
  })

  it('requeues an interjection orphaned before durable user history on restart', async () => {
    const root = tmp('emperor-mainline-recover-interjection-before-history-')
    const stateRoot = join(root, '.emperor')
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = first.sessions.create({ title: 'Recover interjection' })
    const firstGraph = first.loop.sessionRuntimes.actor(String(session.id))
      .bindings.conversationStore.messageGraph
    firstGraph.recordPrompt({
      id: 'prompt_interjection_orphan',
      turnId: 'turn_interjection_orphan',
      clientMessageId: 'prompt_interjection_orphan',
      delivery: 'interject',
      targetCommandId: 'turn:missing_owner',
      content: 'preserve orphaned interjection',
      displayContent: 'Preserve orphaned interjection',
      supportsInterjection: true,
    })
    firstGraph.transitionPrompt('prompt_interjection_orphan', 'interjected')
    await first.close()

    const provider = new ConcurrentBlockingProvider()
    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    second.chat.listQueuedPrompts({ sessionId: String(session.id) })
    await provider.waitForCalls(1)
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain(
      'preserve orphaned interjection',
    )
    provider.finish(0, response('interjection recovered'))
    await vi.waitFor(() => {
      const prompts = second.loop.sessionRuntimes
        .actor(String(session.id))
        .bindings.conversationStore.messageGraph.snapshot().prompts
      expect(prompts).toContainEqual(
        expect.objectContaining({
          id: 'prompt_interjection_orphan',
          state: 'cancelled',
        }),
      )
      expect(prompts).toContainEqual(
        expect.objectContaining({
          content: 'preserve orphaned interjection',
          state: 'completed',
        }),
      )
    })
    expect(provider.calls).toHaveLength(1)
    await second.close()
  })

  it('completes an interjection already committed to user history without replaying it', async () => {
    const root = tmp('emperor-mainline-reconcile-interjection-history-')
    const stateRoot = join(root, '.emperor')
    const first = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = first.sessions.create({ title: 'Committed interjection' })
    const bindings = first.loop.sessionRuntimes.actor(
      String(session.id),
    ).bindings
    bindings.conversationStore.messageGraph.recordPrompt({
      id: 'prompt_interjection_committed',
      turnId: 'turn_interjection_committed',
      clientMessageId: 'client_interjection_committed',
      delivery: 'interject',
      targetCommandId: 'turn:former_owner',
      content: 'already delivered interjection',
      displayContent: 'Already delivered interjection',
      supportsInterjection: true,
    })
    bindings.conversationStore.messageGraph.transitionPrompt(
      'prompt_interjection_committed',
      'interjected',
    )
    bindings.memoryStore.appendHistory(
      'user',
      'already delivered interjection',
      {
        extra: { turn_id: 'turn_interjection_committed' },
      },
    )
    await first.close()

    const provider = new ConcurrentBlockingProvider()
    const second = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    second.chat.listQueuedPrompts({ sessionId: String(session.id) })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(provider.calls).toHaveLength(0)
    expect(
      second.loop.sessionRuntimes
        .actor(String(session.id))
        .bindings.conversationStore.messageGraph.snapshot().prompts,
    ).toContainEqual(
      expect.objectContaining({
        id: 'prompt_interjection_committed',
        state: 'completed',
      }),
    )
    await second.close()
  })

  it('cancels session A without cancelling a concurrent turn in session B', async () => {
    const root = tmp('emperor-mainline-session-cancel-')
    const provider = new ConcurrentBlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const sessionA = api.sessions.create({ title: 'A' })
    const sessionB = api.sessions.create({ title: 'B' })
    const turnA = api.chat.submit({
      content: 'cancel A',
      turnId: 'turn_cancel_a',
      sessionId: String(sessionA.id),
    })
    await provider.waitForCalls(1)
    const turnB = api.chat.submit({
      content: 'keep B',
      turnId: 'turn_keep_b',
      sessionId: String(sessionB.id),
    })
    await provider.waitForCalls(2)

    expect(
      api.loop.activeTasks.cancel({ taskId: 'turn:turn_cancel_a' }),
    ).toHaveLength(1)
    await expect(turnA).rejects.toBeInstanceOf(CancelledTaskError)
    expect(api.loop.activeTasks.list()).toEqual([
      expect.objectContaining({ id: 'turn:turn_keep_b', cancelled: false }),
    ])
    provider.finish(1, response('B survived'))
    await expect(turnB).resolves.toMatchObject({ content: 'B survived' })
    provider.finish(0, response('A late result'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      readFileSync(
        join(
          root,
          '.emperor',
          'sessions',
          String(sessionA.id),
          'history.jsonl',
        ),
        'utf8',
      ),
    ).not.toContain('A late result')

    await api.close()
  })

  it('reopens a session actor from existing stores after process restart', async () => {
    const root = tmp('emperor-mainline-session-restart-')
    const stateRoot = join(root, '.emperor')
    const firstProvider = new FakeProvider()
    const firstApi = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(firstProvider),
    })
    const session = firstApi.sessions.create({ title: 'Durable actor' })
    await firstApi.chat.submit({
      content: 'before restart',
      turnId: 'turn_before_restart',
      sessionId: String(session.id),
    })
    await firstApi.close()

    const secondProvider = new FakeProvider()
    const secondApi = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(secondProvider),
    })
    await secondApi.chat.submit({
      content: 'after restart',
      turnId: 'turn_after_restart',
      sessionId: String(session.id),
    })
    expect(JSON.stringify(secondProvider.calls[0]?.messages)).toContain(
      'before restart',
    )
    expect(
      secondApi.runtime
        .replay({ sessionId: String(session.id) })
        .events.map((event) => event.turn_id),
    ).toEqual(
      expect.arrayContaining(['turn_before_restart', 'turn_after_restart']),
    )
    await secondApi.close()
  })

  it('executes distinct turn commands that share one long-lived task owner', async () => {
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-long-lived-task-'),
      stateRoot: tmp('emperor-mainline-long-lived-task-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const sessionId = api.loop.activeSessionId!
    const runActorCommand = vi.spyOn(api.loop.sessionRuntimes, 'run')

    await api.mainline.submit({
      content: 'cycle one',
      turnId: 'turn_goal_cycle_1',
      taskId: 'goal:stable-owner',
      useActiveTask: false,
      source: 'goal',
      sessionId,
    })
    expect(provider.calls).toHaveLength(1)
    const actor = api.loop.sessionRuntimes.get(sessionId)
    expect(actor?.snapshot().commandReceipts).toBe(1)
    await api.mainline.submit({
      content: 'cycle two',
      turnId: 'turn_goal_cycle_2',
      taskId: 'goal:stable-owner',
      useActiveTask: false,
      source: 'goal',
      sessionId,
    })

    expect(api.loop.sessionRuntimes.get(sessionId)).toBe(actor)
    expect(runActorCommand.mock.calls.map((call) => call[1])).toEqual([
      'turn:turn_goal_cycle_1',
      'turn:turn_goal_cycle_2',
    ])
    expect(provider.calls).toHaveLength(2)
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain('cycle one')
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain('cycle two')
    await api.close()
  })

  it('persists every sampling attempt as a correlated diagnostic V2 envelope', async () => {
    const root = tmp('emperor-mainline-sampling-envelope-')
    const stateRoot = join(root, '.emperor')
    const provider = new RetryOnceProvider()
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const sessionId = api.loop.activeSessionId!

    await api.mainline.submit({
      content: 'retry once',
      turnId: 'turn_sampling_envelope',
      sessionId,
    })

    const rows = readFileSync(
      join(stateRoot, 'sessions', sessionId, 'runtime', 'events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const attempts = rows.filter((row) =>
      String(row.type ?? '').startsWith('model_attempt_'),
    )
    expect(attempts.map((row) => row.type)).toEqual([
      'model_attempt_started',
      'model_attempt_failed',
      'model_attempt_started',
      'model_attempt_succeeded',
    ])
    expect(attempts.every((row) => row.schemaVersion === 2)).toBe(true)
    expect(attempts.every((row) => row.visibility === 'diagnostic')).toBe(true)
    expect(new Set(attempts.map((row) => row.requestId)).size).toBe(1)
    expect(new Set(attempts.map((row) => row.attemptId)).size).toBe(2)
    expect(new Set(attempts.map((row) => row.idempotencyKey)).size).toBe(4)
    await api.close()
  })

  it('rejects ordinary mutation turns while a Goal owns the global turn slot', async () => {
    const root = tmp('emperor-mainline-goal-busy-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = api.sessions.create({ title: 'Goal owner' })
    let release!: () => void
    const owner = api.loop.activeTasks.run({
      taskId: 'goal:busy',
      kind: 'goal',
      label: 'Goal owner',
      sessionId: String(session.id),
      execute: async () =>
        await new Promise<void>((resolve) => {
          release = resolve
        }),
    })

    await expect(
      api.chat.submit({
        content: 'must not run',
        sessionId: String(session.id),
      }),
    ).rejects.toMatchObject({ name: 'TurnBusyError' })
    expect(api.loop.activeTasks.list()).toHaveLength(1)
    release()
    await owner
    await api.close()
  })

  it('routes scheduler agent_turn jobs through MainlineTurnService', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-'),
      stateRoot: tmp('emperor-mainline-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const submitSchedulerTurn = vi.spyOn(api.mainline, 'submitSchedulerTurn')
    const originalSessionId = api.loop.activeSessionId!
    const target = api.sessions.create({ title: 'Scheduler target' })
    const job = api.loop.schedulerService.addJob({
      name: 'daily summary',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({
        kind: 'agent_turn',
        message: 'summarize today',
        deliver: false,
        meta: { [SCHEDULER_TARGET_SESSION_METADATA_KEY]: String(target.id) },
      }),
    })

    await expect(
      api.loop.schedulerService.runJob(job.id, { force: true }),
    ).resolves.toBe(true)

    expect(submitSchedulerTurn).toHaveBeenCalledOnce()
    expect(api.loop.activeSessionId).toBe(originalSessionId)
    api.loop.activateSession(String(target.id))
    const history = JSON.stringify(
      api.loop.activeMemoryStore.loadUnarchivedHistory(),
    )
    expect(history).toContain('[SCHEDULER_TRIGGER]')
    expect(history).toContain('定时任务触发 · daily summary')

    await api.close()
  })
})

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor() {
    super({ defaultModel: 'fake-main' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return response('pong')
  }
}

class ConcurrentBlockingProvider extends LLMProvider {
  calls: ChatArgs[] = []
  private readonly finishes: Array<(response: LLMResponse) => void> = []

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return await new Promise<LLMResponse>((resolve) => {
      this.finishes.push(resolve)
    })
  }

  finish(index: number, result: LLMResponse): void {
    const resolve = this.finishes[index]
    if (!resolve) throw new Error(`provider call ${index} is not waiting`)
    resolve(result)
  }

  async waitForCalls(count: number): Promise<void> {
    const deadline = Date.now() + 2_000
    while (this.calls.length < count) {
      if (Date.now() > deadline)
        throw new Error(`provider did not receive ${count} calls`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

class RetryOnceProvider extends LLMProvider {
  private calls = 0

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(): Promise<LLMResponse> {
    this.calls += 1
    if (this.calls === 1)
      throw Object.assign(new Error('upstream unavailable'), { status: 503 })
    return response('recovered')
  }
}

function fakeRouter(provider: LLMProvider): {
  route: (
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ) => ModelRoute
  payload: () => Record<string, unknown>
} {
  return {
    route: (
      useCase: string,
      _agentType?: string | null,
      _task?: string | null,
    ) => ({
      snapshot: snapshot(
        provider,
        useCase === 'main_agent' ? 'main' : 'secondary',
      ),
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({
      mainModel: 'fake-main',
      secondaryModel: 'fake-secondary',
    }),
  }
}

function snapshot(
  provider: LLMProvider,
  role: 'main' | 'secondary',
): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: role === 'main' ? 'fake-main' : 'fake-secondary',
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: true,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: role,
    routeReason: `${role}_model`,
  }
}

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}
