// CoreApi on the harness kernel (`HarnessHost`) with a scripted model: the
// operation registry, bootstrap, chat streaming and draft promotion, replay,
// control interactions, mutation guards, tasks, goals, slash commands, and
// the kept non-kernel services (sessions, scheduler, sidebar, diagnostics,
// skills, desktop pet, stateRoot layout, model config, hooks, onboarding).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../llm/types'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import type { CoreApi } from './core-api'
import { CoreMutationGuardError } from './mutation-guard'
import { coreOperationKeys } from './operations'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  tmp,
  waitFor,
  type ApiFixture,
} from './test-helpers'

const EXPECTED_OPERATIONS = [
  'attachments.rawPath',
  'attachments.save',
  'bootstrap',
  'chat.listQueuedPrompts',
  'chat.manageQueuedPrompt',
  'chat.stopRuntime',
  'chat.submit',
  'commands.complete',
  'commands.invoke',
  'commands.list',
  'config.effective',
  'config.get',
  'config.save',
  'control.answerInteraction',
  'control.approvePlan',
  'control.cancelInteraction',
  'control.commentPlan',
  'control.get',
  'control.setMode',
  'control.setPermissionMode',
  'desktopPet.get',
  'desktopPet.setEnabled',
  'diagnostics.get',
  'environment.cancelInstall',
  'environment.createInstallPlan',
  'environment.getInstallLog',
  'environment.getStatus',
  'environment.install',
  'files.list',
  'files.read',
  'files.search',
  'git.branches',
  'git.closePullRequest',
  'git.commit',
  'git.compare',
  'git.createBranch',
  'git.diff',
  'git.discard',
  'git.enterWorktree',
  'git.exitWorktree',
  'git.fetch',
  'git.log',
  'git.mergePullRequest',
  'git.publishPreview',
  'git.publishPullRequest',
  'git.pull',
  'git.pullRequest',
  'git.push',
  'git.readyPullRequest',
  'git.remote',
  'git.repository',
  'git.stage',
  'git.status',
  'git.switchBranch',
  'git.unstage',
  'git.worktrees',
  'goals.cancel',
  'goals.get',
  'goals.list',
  'goals.pause',
  'goals.resume',
  'goals.start',
  'hooks.cancelRun',
  'hooks.getAudit',
  'hooks.getConfig',
  'hooks.getMetadata',
  'hooks.saveConfig',
  'hooks.setProjectTrust',
  'hooks.testMatch',
  'hooks.testRun',
  'hooks.validateConfig',
  'mcp.getConfig',
  'mcp.importServers',
  'mcp.removeServer',
  'mcp.saveConfig',
  'mcp.setServerEnabled',
  'mcp.status',
  'memory.checkWatchlist',
  'memory.compact',
  'memory.explainContext',
  'memory.get',
  'memory.getEpisode',
  'memory.getVersion',
  'memory.getWatchlist',
  'memory.listVersions',
  'memory.restoreVersion',
  'memory.save',
  'memory.saveEpisode',
  'memory.saveWatchlist',
  'memory.tokens',
  'model.activate',
  'model.deleteEntry',
  'model.discoverModels',
  'model.getConfig',
  'model.resolveProfile',
  'model.saveEntry',
  'model.savePolicy',
  'model.setReasoningEffort',
  'model.test',
  'onboarding.getProfileStatus',
  'onboarding.skipProfileInterview',
  'onboarding.startProfileInterview',
  'plugins.inspect',
  'plugins.install',
  'plugins.list',
  'plugins.setEnabled',
  'plugins.uninstall',
  'processes.cancel',
  'processes.list',
  'processes.reparent',
  'projects.list',
  'projects.resolve',
  'pullRequests.diff',
  'pullRequests.list',
  'pullRequests.status',
  'pullRequests.view',
  'references.resolve',
  'runtime.replay',
  'scheduler.createJob',
  'scheduler.deleteJob',
  'scheduler.get',
  'scheduler.pauseJob',
  'scheduler.resumeJob',
  'scheduler.runJob',
  'scheduler.updateJob',
  'sessions.activate',
  'sessions.children',
  'sessions.create',
  'sessions.delete',
  'sessions.event',
  'sessions.history',
  'sessions.lineage',
  'sessions.list',
  'sessions.rename',
  'sessions.watch',
  'sidebar.get',
  'sidebar.patch',
  'skills.copyToUser',
  'skills.create',
  'skills.delete',
  'skills.get',
  'skills.import',
  'skills.list',
  'skills.save',
  'skills.tools',
  'skills.validate',
  'tasks.cancel',
  'tasks.get',
  'tasks.list',
  'tasks.readOutput',
  'tasks.resume',
  'tasks.transcript',
  'tasks.wait',
  'terminals.close',
  'terminals.create',
  'terminals.list',
  'terminals.read',
  'terminals.resize',
  'terminals.write',
  'tools.readResult',
  'workspace.snapshot',
]

const apis: CoreApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

async function setup(
  options: Parameters<typeof makeApi>[0] = {},
): Promise<ApiFixture> {
  const fixture = await makeApi(options)
  apis.push(fixture.api)
  return fixture
}

function session(api: CoreApi, title = 'Chat'): string {
  return String(api.sessions.create({ title }).id)
}

function resolveMethod(api: CoreApi, key: string): unknown {
  let current: unknown = api
  for (const part of key.split('.')) {
    current =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[part]
        : undefined
  }
  return current
}

function validModelEntry(name: string) {
  return {
    provider: 'openai',
    protocol: 'openai' as const,
    modelId: 'gpt-5.2',
    displayName: name,
    apiKey: 'sk-test-entry',
    apiBase: 'https://api.openai.com/v1',
    maxTokens: 8192,
    reasoningEffort: 'high',
    contextWindowTokens: 128000,
  }
}

const askColor: ScriptedReply = {
  tools: [
    {
      id: 'q1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            id: 'color',
            question: 'Which color?',
            options: [{ label: 'red' }, { label: 'blue' }],
          },
        ],
      },
    },
  ],
}

describe('CoreApi operation surface', () => {
  it('exposes a typed in-process method for every registered operation', async () => {
    const { api } = await setup()
    expect(coreOperationKeys()).toEqual(EXPECTED_OPERATIONS)
    for (const key of EXPECTED_OPERATIONS)
      expect(resolveMethod(api, key), key).toBeTypeOf('function')
  })

  it('bootstraps with the kernel control, runtime, and goal shape', async () => {
    const { api } = await setup()
    const id = session(api)
    const payload = await api.bootstrap({ sessionId: id })
    expect(payload.control).toMatchObject({
      version: 3,
      preset: 'workspace-write',
      plan: false,
      pending: null,
    })
    expect(Array.isArray(payload.control.presets)).toBe(true)
    expect(
      (payload.control.presets as Array<{ value: string }>).map(
        (item) => item.value,
      ),
    ).toEqual(
      expect.arrayContaining([
        'read-only',
        'workspace-write',
        'danger-full-access',
      ]),
    )
    expect(Array.isArray(payload.runtime.events)).toBe(true)
    expect(payload.runtime).toMatchObject({
      busy: false,
      latestSeq: expect.any(Number),
    })
    expect(payload.goals).toEqual({ active: null })
    expect(payload.provider).toBe('test')
    expect(api.host.activeSessionId).toBe(id)
  })

  it('rejects draft session ids at bootstrap before activating or replaying', async () => {
    const { api } = await setup()
    const id = session(api)
    api.sessions.activate(id)
    await expect(
      api.bootstrap({ sessionId: 'draft:new-chat' }),
    ).rejects.toThrow(/draft/i)
    expect(api.host.activeSessionId).toBe(id)
  })
})

describe('CoreApi raw session log', () => {
  it('serves history, lineage, children, and the watch set for child sessions', async () => {
    const { api } = await setup({
      replies: [
        {
          tools: [
            {
              id: 'd1',
              name: 'subagent',
              args: {
                description: 'research',
                prompt: 'find x',
                run_in_background: false,
              },
            },
          ],
        },
        { text: 'child found x' },
        { text: 'parent done' },
      ],
    })
    const id = session(api)
    await api.chat.submit({ content: 'delegate', sessionId: id })
    const [child] = api.sessions.children({ sessionId: id })
    expect(child).toMatchObject({ description: 'research', status: 'settled' })
    const childId = child!.subagentId
    // Child sessions are not in the sidebar list but are readable by lineage.
    expect(
      api.sessions
        .list()
        .some((entry) => (entry as { id?: unknown }).id === childId),
    ).toBe(false)
    const page = api.sessions.history({ sessionId: childId })
    expect(page.header.id).toBe(childId)
    expect(page.events.length).toBeGreaterThan(0)
    expect(api.sessions.lineage({ sessionId: childId }).chain).toEqual([
      { sessionId: id },
      { sessionId: childId, description: 'research', parentCallId: 'd1' },
    ])
    // sessions.event returns one raw event by seq (unsanitized).
    const first = page.events[0]!
    expect(api.sessions.event({ sessionId: childId, seq: first.seq })).toEqual(
      first,
    )
    expect(() =>
      api.sessions.event({ sessionId: childId, seq: 1_000_000 }),
    ).toThrow(/no event/)
    const tail = api.sessions.history({ sessionId: id, maxMessages: 1 })
    expect(tail.hasMore).toBe(true)
    const older = api.sessions.history({
      sessionId: id,
      beforeSeq: tail.events[0]!.seq,
    })
    expect(older.events.at(-1)!.seq).toBeLessThan(tail.events[0]!.seq)

    expect(
      api.sessions.watch({ sessionIds: [id, childId, 'missing'] }),
    ).toEqual({ watching: [id, childId] })
    expect(api.isSessionWatched(childId)).toBe(true)
    expect(api.isSessionWatched('missing')).toBe(false)
    api.sessions.watch({ sessionIds: [] })
    expect(api.isSessionWatched(id)).toBe(false)

    expect(() => api.sessions.history({ sessionId: 'missing' })).toThrow(
      /unknown session/,
    )
    expect(() => api.sessions.lineage({ sessionId: 'draft:x' })).toThrow()
  })
})

describe('CoreApi chat', () => {
  it('streams a real-session turn to the event sink', async () => {
    const { api, events } = await setup({
      replies: [{ text: 'Hello from Emperor' }],
    })
    const id = session(api)
    const result = await api.chat.submit({
      content: 'hi',
      displayContent: 'hi!',
      clientMessageId: 'c1',
      sessionId: id,
    })
    expect(result).toMatchObject({
      content: 'Hello from Emperor',
      activeSessionId: id,
      delivery: 'completed',
    })
    const names = events.map((event) => event.event)
    expect(names).toEqual(
      expect.arrayContaining([
        'user_message',
        'message_delta',
        'assistant_done',
      ]),
    )
    expect(eventOf(events, 'user_message')).toMatchObject({
      content: 'hi!',
      client_message_id: 'c1',
      session_id: id,
    })
    expect(names).not.toContain('session_created')
  })

  it('promotes a draft session before the turn and generates its title once', async () => {
    const { api, adapter, events } = await setup({
      replies: [{ text: 'pong' }, { text: 'second' }],
    })
    const draftId = 'draft:local-abc'
    const result = await api.chat.submit({
      content: '搭一个终端动画项目',
      sessionId: draftId,
      clientDraftId: draftId,
      draftSession: {
        mode: 'build',
        project: {
          project_id: 'proj_1',
          project_path: '/tmp/proj',
          project_name: 'Proj',
        },
      },
    })
    const created = eventOf(events, 'session_created') as {
      client_draft_id: string
      session: Record<string, unknown>
    }
    expect(created.client_draft_id).toBe(draftId)
    expect(created.session).toMatchObject({
      title: '新会话',
      mode: 'build',
      project_id: 'proj_1',
      title_status: 'pending',
    })
    const newId = String(created.session.id)
    expect(result.activeSessionId).toBe(newId)
    const createdIndex = events.findIndex(
      (event) => event.event === 'session_created',
    )
    const userIndex = events.findIndex(
      (event) => event.event === 'user_message',
    )
    expect(userIndex).toBeGreaterThan(createdIndex)
    const titleEvents = events.filter(
      (event) => event.event === 'session_title_updated',
    )
    expect(titleEvents).toHaveLength(1)
    expect((titleEvents[0]!.session as { id: string }).id).toBe(newId)
    expect(api.host.kept.sessionStore.get(newId)).toMatchObject({
      title: 'Generated',
      title_status: 'generated',
    })
    expect(adapter.titleRequests).toHaveLength(1)

    events.length = 0
    await api.chat.submit({ content: '继续', sessionId: newId })
    expect(eventOf(events, 'session_created')).toBeUndefined()
    expect(eventOf(events, 'session_title_updated')).toBeUndefined()
    expect(adapter.titleRequests).toHaveLength(1)
  })

  it('defers title material for a short first message to the reply', async () => {
    const { api, adapter } = await setup({ replies: [{ text: 'pong reply' }] })
    const result = await api.chat.submit({
      content: 'hi',
      sessionId: 'draft:short',
      draftSession: { mode: 'chat' },
    })
    expect(adapter.titleRequests).toHaveLength(1)
    const titlePrompt = JSON.stringify(adapter.titleRequests[0]!.messages)
    expect(titlePrompt).toContain('pong reply')
    expect(
      api.host.kept.sessionStore.get(String(result.activeSessionId)),
    ).toMatchObject({ title_status: 'generated' })
  })

  it('turns requested skills into a /name gesture while keeping display content', async () => {
    const root = tmp('emperor-core-api-skill-')
    const stateRoot = join(root, 'home')
    mkdirSync(join(stateRoot, 'skills', 'reviewer'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'reviewer', 'SKILL.md'),
      '---\nname: reviewer\ndescription: Review code\n---\n\nREVIEWER-SKILL-BODY\n',
    )
    const { api, adapter, events } = await setup({
      root,
      stateRoot,
      replies: [{ text: 'reviewed' }],
    })
    const id = session(api)
    await api.chat.submit({
      content: 'check this',
      sessionId: id,
      requestedSkills: [
        { name: 'reviewer', source: 'slash' },
        { name: 'bad name!' },
      ],
    })
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('/reviewer\\ncheck this')
    expect(request).not.toContain('/bad name!')
    expect(request).toContain('REVIEWER-SKILL-BODY')
    expect(eventOf(events, 'user_message')).toMatchObject({
      content: 'check this',
    })
  })

  it('runs context: fork skill commands as a scoped forked subagent', async () => {
    const root = tmp('emperor-core-api-fork-skill-')
    const stateRoot = join(root, 'home')
    mkdirSync(join(stateRoot, 'skills', 'reviewer'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'reviewer', 'SKILL.md'),
      [
        '---',
        'name: reviewer',
        'description: Review code',
        'metadata:',
        '  emperor:',
        '    command:',
        '      context: fork',
        '      agent: code-reviewer',
        '      allowed_tools: [read, grep]',
        '      effort: high',
        '---',
        '',
        'FORK-SKILL-BODY',
        '',
      ].join('\n'),
    )
    const { api, adapter } = await setup({
      root,
      stateRoot,
      replies: [{ text: 'child review' }, { text: 'parent ack' }],
    })
    const id = session(api)
    const result = await api.commands.invoke({
      sessionId: id,
      commandId: 'skill.user.reviewer',
      rawInput: '/reviewer the diff',
      invocationId: 'fork-1',
      invocationSource: 'desktop',
    })
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { code: 'skill_forked' },
    })
    const childId = String(
      (result as unknown as { receipt: { data: { subagentId: string } } })
        .receipt.data.subagentId,
    )
    await api.host.subagents.get(childId)?.whenIdle()
    await api.host.agentFor(id).whenIdle()
    const childRequest = adapter.requests[0]!
    expect(childRequest.sessionId).toBe(childId)
    expect((childRequest.tools ?? []).map((tool) => tool.name).sort()).toEqual([
      'grep',
      'read',
    ])
    const prompt = JSON.stringify(childRequest.messages)
    expect(prompt).toContain('FORK-SKILL-BODY')
    expect(prompt).toContain('Task: the diff')
    expect(api.commandPlatform.diagnostics(id).warnings).toEqual([
      expect.objectContaining({ skillName: 'reviewer', field: 'agent' }),
    ])
  })

  it('replays only the requested session and matches the live projection', async () => {
    const { api, events } = await setup({
      replies: [{ text: 'one' }, { text: 'two' }],
    })
    const a = session(api, 'A')
    const b = session(api, 'B')
    await api.chat.submit({ content: 'first', sessionId: a })
    await api.chat.submit({ content: 'second', sessionId: b })
    const replay = api.runtime.replay({ sessionId: a })
    expect(replay.sessionId).toBe(a)
    expect(replay.events.length).toBeGreaterThan(0)
    expect(replay.events.every((event) => event.session_id === a)).toBe(true)
    const live = events.filter(
      (event) => Number(event.seq) > 0 && event.session_id === a,
    )
    expect(replay.events).toEqual(live)
    expect(replay.latestSeq).toBe(live.at(-1)!.seq)
    const tail = api.runtime.replay({
      sessionId: a,
      afterSeq: replay.latestSeq - 1,
    })
    expect(tail.events).toHaveLength(1)
    expect(() => api.runtime.replay({ sessionId: 'draft:x' })).toThrow(/draft/)
  })
})

describe('CoreApi control', () => {
  it('switches permission preset and plan mode', async () => {
    const { api } = await setup()
    const id = session(api)
    api.control.setPermissionMode('read-only', id)
    expect(api.control.get(id)).toMatchObject({
      preset: 'read-only',
      plan: false,
    })
    const planned = api.control.setMode('plan', id)
    expect(planned.control).toMatchObject({ plan: true })
    expect(api.control.get(id).plan).toBe(true)
    api.control.setMode('default', id)
    expect(api.control.get(id).plan).toBe(false)
    expect(() => api.control.setPermissionMode('nope', id)).toThrow(
      /unknown permission preset/,
    )
  })

  it('answers ask_user_question and resumes the blocked turn', async () => {
    const { api, events } = await setup({
      replies: [
        askColor,
        (request: GenerateOptions) => {
          expect(JSON.stringify(request.messages.at(-1)?.content)).toContain(
            'blue',
          )
          return replyChunks({ text: 'blue it is' })
        },
      ],
    })
    const id = session(api)
    const submitted = api.chat.submit({ content: 'pick', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const interactionId = pendingInteractionId(events, 'ask_request')
    expect(api.control.get(id).pending).toMatchObject({ id: interactionId })
    const settled = await api.control.answerInteraction(interactionId, {
      color: { choice: 'blue', freeform: '' },
    })
    expect(settled).toMatchObject({ interactionId, sessionId: id })
    expect((await submitted).content).toBe('blue it is')
    expect(api.control.get(id).pending).toBeNull()
  })

  it('approves a plan through exit_plan_mode and leaves plan mode', async () => {
    const { api, events } = await setup({
      replies: [
        {
          tools: [
            {
              id: 'p1',
              name: 'exit_plan_mode',
              args: { plan: '# Do the thing\n- step' },
            },
          ],
        },
        { text: 'implementing' },
      ],
    })
    const id = session(api)
    api.control.setMode('plan', id)
    const submitted = api.chat.submit({ content: 'plan it', sessionId: id })
    await waitFor(() => eventOf(events, 'plan_draft') !== undefined)
    const planId = pendingInteractionId(events, 'plan_draft')
    await api.control.approvePlan(planId)
    expect((await submitted).content).toBe('implementing')
    expect(eventOf(events, 'plan_approved')).toBeDefined()
    expect(api.control.get(id).plan).toBe(false)
  })

  it('cancels a pending interaction and rejects unknown interaction ids', async () => {
    const { api, events } = await setup({
      replies: [askColor, { text: 'cancelled then' }],
    })
    const id = session(api)
    const submitted = api.chat.submit({ content: 'pick', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const interactionId = pendingInteractionId(events, 'ask_request')
    await api.control.cancelInteraction(interactionId)
    await submitted
    expect(api.control.get(id).pending).toBeNull()
    await expect(
      api.control.answerInteraction('missing', {}),
    ).rejects.toBeInstanceOf(CoreMutationGuardError)
    await expect(api.control.cancelInteraction(interactionId)).rejects.toThrow(
      /not pending/,
    )
  })
})

describe('CoreApi mutation guard', () => {
  it('rejects config, MCP, and model writes while plan mode is active', async () => {
    const { api } = await setup()
    const id = session(api)
    api.sessions.activate(id)
    api.control.setMode('plan', id)
    await expect(api.config.save('x')).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    await expect(api.mcp.saveConfig({ servers: {} })).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    const pasted = { mcpServers: { docs: { url: 'https://docs.test/mcp' } } }
    await expect(api.mcp.importServers({ raw: pasted })).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    await expect(
      api.mcp.importServers({ raw: pasted, dryRun: true }),
    ).resolves.toMatchObject({ dryRun: true, added: ['docs'] })
    await expect(
      api.mcp.setServerEnabled({ name: 'docs', enabled: false }),
    ).rejects.toBeInstanceOf(CoreMutationGuardError)
    await expect(api.mcp.removeServer({ name: 'docs' })).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    await expect(
      api.model.saveEntry(validModelEntry('blocked') as never),
    ).rejects.toBeInstanceOf(CoreMutationGuardError)
    await expect(
      api.model.deleteEntry({ entryId: 'entry-1' }),
    ).rejects.toBeInstanceOf(CoreMutationGuardError)
    expect(() => api.scheduler.createJob({})).toThrow(CoreMutationGuardError)
    expect(() => api.skills.save('blocked-save', '# Blocked')).toThrow(
      CoreMutationGuardError,
    )
    expect(() => api.skills.delete('blocked-delete')).toThrow(
      CoreMutationGuardError,
    )
    await expect(api.hooks.saveConfig('{}')).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
  })

  it('rejects config, MCP, and model writes while an interaction is pending', async () => {
    const { api, events } = await setup({
      replies: [askColor, { text: 'done' }],
    })
    const id = session(api)
    const submitted = api.chat.submit({ content: 'pick', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    await expect(api.config.save('x')).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    await expect(api.mcp.saveConfig({ servers: {} })).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
    await expect(
      api.model.saveEntry(validModelEntry('blocked') as never),
    ).rejects.toBeInstanceOf(CoreMutationGuardError)
    await api.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      { color: { choice: 'red', freeform: '' } },
    )
    await submitted
    await expect(api.mcp.saveConfig({ servers: {} })).resolves.toBeDefined()
  })

  it('keeps retired install operations retired', async () => {
    const { api, stateRoot } = await setup()
    await expect(api.environment.install({} as never)).rejects.toMatchObject({
      code: 'operation_retired',
    })
    await expect(
      api.environment.createInstallPlan({} as never),
    ).rejects.toMatchObject({ code: 'operation_retired' })
    await expect(api.tasks.resume('x')).rejects.toMatchObject({
      code: 'operation_retired',
    })
    expect(existsSync(join(stateRoot, 'skills', '.staging'))).toBe(false)
  })
})

describe('CoreApi tasks and tools', () => {
  it('lists a background bash job and serves its transcript', async () => {
    const { api } = await setup({
      replies: [
        {
          tools: [
            {
              id: 'b1',
              name: 'bash',
              args: {
                command: 'echo job-out',
                description: 'Print a word',
                run_in_background: true,
              },
            },
          ],
        },
        { text: 'started' },
      ],
    })
    const id = session(api)
    await api.chat.submit({ content: 'run in background', sessionId: id })
    const tasks = api.tasks.list({ sessionId: id })
    const job = tasks.find((task) => task.kind === 'job')
    expect(job).toMatchObject({
      kind: 'job',
      job_kind: 'bash',
      label: 'echo job-out',
      session_id: id,
    })
    const waited = await api.tasks.wait(job!.id, { timeoutMs: 5000 })
    expect(waited).toMatchObject({ status: 'completed' })
    expect(api.tasks.get(job!.id)).toMatchObject({
      id: job!.id,
      status: 'completed',
    })
    const transcript = api.tasks.transcript(job!.id)
    expect(transcript).toMatchObject({ taskId: job!.id, total: 1, eof: true })
    expect(transcript.entries[0]!.content).toContain('job-out')
    expect(() => api.tasks.transcript('unknown-task')).toThrow(
      CoreMutationGuardError,
    )
  })

  it('lists a foreground subagent and serves its transcript', async () => {
    const { api, events } = await setup({
      replies: [
        {
          tools: [
            {
              id: 's1',
              name: 'subagent',
              args: {
                description: 'Child task',
                prompt: 'do the child work',
                run_in_background: false,
              },
            },
          ],
        },
        { text: 'child done' },
        { text: 'parent done' },
      ],
    })
    const id = session(api)
    const result = await api.chat.submit({ content: 'delegate', sessionId: id })
    expect(result.content).toBe('parent done')
    const child = api.tasks
      .list({ sessionId: id })
      .find((task) => task.kind === 'subagent')
    expect(child).toMatchObject({
      kind: 'subagent',
      label: 'Child task',
      session_id: id,
    })
    const transcript = api.tasks.transcript(child!.id)
    expect(
      transcript.entries.some(
        (entry) =>
          entry.role === 'user' && entry.content.includes('do the child work'),
      ),
    ).toBe(true)
    expect(
      transcript.entries.some(
        (entry) =>
          entry.role === 'assistant' && entry.content.includes('child done'),
      ),
    ).toBe(true)
    expect(eventOf(events, 'subagent_start')).toMatchObject({
      session_id: id,
      subagent_id: child!.id,
    })
  })

  it('lists a workflow run with its rounds and serves its transcript', async () => {
    const { api, events } = await setup({
      replies: [
        {
          tools: [
            {
              id: 'wf1',
              name: 'workflow',
              args: {
                meta: { name: 'probe', description: 'one child' },
                script: `phase('ask'); log('asking'); return await agent('do the child work', { label: 'asker' })`,
              },
            },
          ],
        },
        { text: 'child answer' },
        { text: 'parent done' },
      ],
    })
    const id = session(api)
    const result = await api.chat.submit({ content: 'run it', sessionId: id })
    expect(result.content).toBe('parent done')
    const run = api.tasks
      .list({ sessionId: id })
      .find((task) => task.kind === 'workflow')
    expect(run).toMatchObject({
      kind: 'workflow',
      label: 'probe',
      status: 'completed',
      rounds: 1,
      workflow_tool: 'workflow',
      call_id: 'wf1',
      session_id: id,
    })
    expect(run!.agents).toEqual([
      expect.objectContaining({ seq: 1, label: 'asker', outcome: 'completed' }),
    ])
    const transcript = api.tasks.transcript(run!.id)
    expect(transcript.entries.map((entry) => entry.role)).toEqual([
      'workflow',
      'phase',
      'log',
      'agent',
      'agent',
      'result',
    ])
    expect(transcript.entries.at(-1)!.content).toContain('child answer')
    expect(await api.tasks.cancel(run!.id)).toMatchObject({
      status: 'completed',
    })
    expect(eventOf(events, 'workflow_finished')).toMatchObject({
      session_id: id,
      task: { id: run!.id, kind: 'workflow', status: 'completed' },
    })
    expect(eventOf(events, 'subagent_start')).toMatchObject({
      session_id: id,
      parent_id: 'wf1',
    })
  })

  it('reads spilled tool results only from the spill store', async () => {
    const { api, stateRoot, root } = await setup()
    mkdirSync(join(stateRoot, 'spill'), { recursive: true })
    const spilled = join(stateRoot, 'spill', 'result.txt')
    writeFileSync(spilled, 'full text content')
    writeFileSync(join(root, 'outside.txt'), 'secret')
    expect(api.tools.readResult({ ref: spilled })).toEqual({
      content: 'full text content',
    })
    expect(() =>
      api.tools.readResult({ ref: join(root, 'outside.txt') }),
    ).toThrow(CoreMutationGuardError)
    expect(() =>
      api.tools.readResult({
        ref: join(stateRoot, 'spill', '..', 'settings.json'),
      }),
    ).toThrow(CoreMutationGuardError)
    expect(() =>
      api.tools.readResult({ ref: join(stateRoot, 'spill') }),
    ).toThrow(CoreMutationGuardError)
    expect(() => api.tools.readResult({ ref: '/etc/passwd' })).toThrow(
      CoreMutationGuardError,
    )
  })
})

describe('CoreApi goals', () => {
  it('starts, lists, pauses, resumes, and cancels a goal', async () => {
    const { api, adapter, events } = await setup({
      replies: [{ text: 'round one' }, { text: 'round two' }],
    })
    const id = session(api)
    api.sessions.activate(id)
    const started = await api.goals.start({
      sessionId: id,
      objective: 'ship the feature',
    })
    expect(started.accepted).toBe(true)
    const goalId = started.goal!.id
    expect(started.goal).toMatchObject({
      objective: 'ship the feature',
      phase: 'active',
    })
    expect(await api.goals.list({ sessionId: id })).toEqual([
      expect.objectContaining({ id: goalId }),
    ])
    // Rounds continue until the scripted model runs dry, which disarms the goal.
    const agent = api.host.agentFor(id)
    await waitFor(() => adapter.remaining === 0 && agent.status !== 'running')
    await agent.whenIdle()
    const live = api.host.goals.get(agent)!
    expect(live.roundsStarted).toBeGreaterThanOrEqual(2)
    // The projected goal view (bootstrap / goal_updated) tracks admitted rounds.
    expect(api.host.goalView(id)).toMatchObject({
      id: goalId,
      revision: live.revision,
      roundsStarted: live.roundsStarted,
    })
    expect(events.some((event) => event.event === 'goal_updated')).toBe(true)

    const paused = await api.goals.pause(goalId)
    expect(paused.goal).toMatchObject({ id: goalId, phase: 'paused' })
    expect((await api.goals.get(goalId)).phase).toBe('paused')
    const resumed = await api.goals.resume(goalId)
    expect(resumed.goal).toMatchObject({ id: goalId, phase: 'active' })
    await agent.whenIdle()
    const cancelled = await api.goals.cancel(goalId)
    expect(cancelled).toMatchObject({
      accepted: true,
      goal: null,
      cleared: { id: goalId },
    })
    expect((await api.bootstrap({ sessionId: id })).goals.active).toBeNull()
    await expect(api.goals.get(goalId)).rejects.toMatchObject({
      code: 'goal_not_found',
    })
    await expect(
      api.goals.start({ sessionId: id, objective: '  ' }),
    ).rejects.toMatchObject({ code: 'goal_objective_invalid' })
  })
})

describe('CoreApi commands', () => {
  it('lists builtins and creates a real new-chat boundary with /new', async () => {
    const { api } = await setup()
    const previous = session(api)
    api.sessions.activate(previous)
    const commands = await api.commands.list({
      sessionId: previous,
      invocationSource: 'desktop',
    })
    expect(commands.find((item) => item.id === 'builtin.new')).toMatchObject({
      name: 'new',
      kind: 'core_action',
    })
    const result = await api.commands.invoke({
      sessionId: previous,
      commandId: 'builtin.new',
      rawInput: '/new',
      invocationId: 'new-1',
      invocationSource: 'desktop',
    })
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { code: 'session_transitioned' },
    })
    const next = String(api.host.activeSessionId)
    expect(next).not.toBe(previous)
    expect(api.host.kept.sessionStore.get(next)).toMatchObject({
      parent_session_id: previous,
      message_count: 0,
    })
    expect(api.host.kept.sessionStore.get(previous)).toMatchObject({
      transitioned_to_session_id: next,
    })
  })

  it('carries the permission preset into the /new session with plan mode off', async () => {
    const { api } = await setup()
    const previous = session(api)
    api.sessions.activate(previous)
    api.host.setPermissionPreset(previous, 'read-only')
    api.host.setPlanMode(previous, true)
    const result = await api.commands.invoke({
      sessionId: previous,
      commandId: 'builtin.new',
      rawInput: '/new',
      invocationId: 'new-preset',
      invocationSource: 'desktop',
    })
    expect(result).toMatchObject({ status: 'completed' })
    const next = String(api.host.activeSessionId)
    expect(next).not.toBe(previous)
    expect(api.host.controlPayload(next)).toMatchObject({
      preset: 'read-only',
      plan: false,
    })
  })

  it('applies /permissions and /plan to the declared session only', async () => {
    const { api } = await setup()
    const active = session(api, 'Active')
    api.sessions.activate(active)
    const background = session(api, 'Background')
    await expect(
      api.commands.invoke({
        sessionId: background,
        commandId: 'builtin.permissions',
        rawInput: '/permissions read-only',
        invocationId: 'perm-1',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: {
        code: 'permission_preset_updated',
        data: { preset: 'read-only' },
      },
    })
    expect(api.control.get(background).preset).toBe('read-only')
    expect(api.control.get(active).preset).toBe('workspace-write')

    await expect(
      api.commands.invoke({
        sessionId: background,
        commandId: 'builtin.plan',
        rawInput: '/plan',
        invocationId: 'plan-1',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: { code: 'plan_enabled' },
    })
    expect(api.control.get(background).plan).toBe(true)
    expect(api.control.get(active).plan).toBe(false)

    await expect(
      api.commands.invoke({
        sessionId: background,
        commandId: 'builtin.plan',
        rawInput: '/plan off',
        invocationId: 'plan-2',
        invocationSource: 'desktop',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      receipt: { code: 'plan_disabled' },
    })
    expect(api.control.get(background).plan).toBe(false)
  })
})

describe('CoreApi sessions and kept services', () => {
  it('deletes a session and its log', async () => {
    const { api } = await setup({ replies: [{ text: 'hello' }] })
    const keep = session(api, 'Keep')
    const doomed = session(api, 'Doomed')
    await api.chat.submit({ content: 'hi', sessionId: doomed })
    expect(api.host.sessions.has(doomed)).toBe(true)
    await api.sessions.delete(doomed)
    expect(api.host.sessions.has(doomed)).toBe(false)
    expect(api.host.kept.sessionStore.get(doomed)).toBeNull()
    expect(api.host.kept.sessionStore.get(keep)).not.toBeNull()
  })

  it('returns structured scheduler payloads and rejects non agent_turn payloads', async () => {
    const { api } = await setup()
    const created = api.scheduler.createJob({
      name: 'Typed scheduler job',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: {
        kind: 'agent_turn',
        message: 'run a typed task',
        deliver: true,
      },
      deleteAfterRun: false,
      misfirePolicy: 'latest',
    })
    expect(created).toMatchObject({
      job: { name: 'Typed scheduler job', misfirePolicy: 'latest' },
      scheduler: { jobs: expect.any(Array) },
    })
    const jobId = String((created.job as Record<string, unknown>).id)
    expect(
      api.scheduler.updateJob(jobId, { misfirePolicy: 'catch-up-one' }).job,
    ).toMatchObject({ misfirePolicy: 'catch-up-one' })
    expect(
      api.scheduler.updateJob(jobId, { name: 'Renamed' }).job,
    ).toMatchObject({ name: 'Renamed', misfirePolicy: 'catch-up-one' })
    expect(api.scheduler.pauseJob(jobId)).toMatchObject({
      job: { id: jobId, enabled: false },
    })
    expect(api.scheduler.deleteJob(jobId)).toMatchObject({
      deleted: jobId,
      scheduler: { jobs: expect.any(Array) },
    })

    const schedule = { kind: 'every', everyMs: 60_000 }
    expect(() =>
      api.scheduler.createJob({
        name: 'x',
        schedule,
        payload: { kind: 'system_event', message: 'internal' },
      }),
    ).toThrow(/system_event.*internal/i)
    expect(() =>
      api.scheduler.createJob({
        name: 'x',
        schedule,
        payload: { kind: 'team_wake', message: 'wake' },
      }),
    ).toThrow(/agent_turn/)
    expect(() =>
      api.scheduler.createJob({
        name: 'x',
        schedule,
        payload: { kind: 'agent_turn', message: 'run' },
        misfirePolicy: 'replay-all',
      }),
    ).toThrow(/misfirePolicy/)
    expect(() => api.scheduler.deleteJob('missing')).toThrow(/not found/)
  })

  it('normalizes missing and legacy sidebar state', async () => {
    const { api, root } = await setup()
    const defaults = {
      section_order: ['projects', 'chats'],
      project_sort: 'updated_at',
      chat_sort: 'updated_at',
      project_order: [],
      chat_order: [],
      project_session_order: {},
      collapsed_project_ids: [],
      pinned_session_ids: [],
      right_workspace: {
        version: 3,
        workbenchOpen: false,
        width: 840,
        filesTreeWidth: 280,
        pane: 'launcher',
      },
    }
    expect(api.sidebar.get()).toEqual(defaults)
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(
      join(root, 'memory', 'sidebar_state.json'),
      JSON.stringify({
        project_sort: 'manual',
        section_order: ['chats'],
        collapsed_project_ids: 'legacy-bad-value',
        project_session_order: { p1: ['s1', 2] },
      }),
    )
    expect(api.sidebar.get()).toEqual({
      ...defaults,
      section_order: ['chats', 'projects'],
      project_sort: 'manual',
      project_session_order: { p1: ['s1', '2'] },
    })
    const patched = api.sidebar.patch({
      chat_sort: 'created_at',
      right_workspace: {
        version: 3,
        width: 9999,
        pane: 'files',
        workbenchOpen: true,
      },
    })
    expect(patched).toMatchObject({
      chat_sort: 'created_at',
      right_workspace: { width: 960, pane: 'files', workbenchOpen: true },
    })
    expect(api.sidebar.get()).toEqual(patched)
  })

  it('normalizes pinned sessions and unpins deleted or archived sessions', async () => {
    const { api, stateRoot } = await setup()
    const keep = session(api, 'Keep')
    const doomed = session(api, 'Doomed')
    const archived = session(api, 'Archived')
    const many = Array.from({ length: 60 }, (_, index) => `s-${index}`)

    expect(
      api.sidebar.patch({
        pinned_session_ids: [' s-1 ', 's-1', '', 7, null, { id: 'x' }, 's-2'],
      }).pinned_session_ids,
    ).toEqual(['s-1', 's-2'])
    expect(
      api.sidebar.patch({ pinned_session_ids: many }).pinned_session_ids,
    ).toEqual(many.slice(0, 50))
    expect(
      api.sidebar.patch({ pinned_session_ids: 'not-a-list' })
        .pinned_session_ids,
    ).toEqual([])

    api.sidebar.patch({
      chat_sort: 'created_at',
      pinned_session_ids: [doomed, keep, archived],
    })
    await api.sessions.delete(doomed)
    expect(api.sidebar.get().pinned_session_ids).toEqual([keep, archived])
    await api.sessions.rename(archived, { archived: true })
    expect(api.sidebar.get()).toMatchObject({
      chat_sort: 'created_at',
      pinned_session_ids: [keep],
    })
    await api.sessions.rename(archived, { archived: false })
    expect(api.sidebar.get().pinned_session_ids).toEqual([keep])
    expect(
      JSON.parse(
        readFileSync(join(stateRoot, 'memory', 'sidebar_state.json'), 'utf8'),
      ).pinned_session_ids,
    ).toEqual([keep])
  })

  it('routes the global pull request and git remote facades through validation', async () => {
    const { api } = await setup()
    await expect(
      api.pullRequests.view({ repo: 'not a repo', number: 1 }),
    ).rejects.toMatchObject({ code: 'pull_request_argument_invalid' })
    await expect(
      api.pullRequests.diff({ repo: 'acme/widgets', number: 0 }),
    ).rejects.toMatchObject({ code: 'pull_request_argument_invalid' })
    await expect(
      api.pullRequests.list({ filter: 'all', limit: 51 }),
    ).rejects.toMatchObject({ code: 'pull_request_argument_invalid' })
    const chat = session(api)
    await expect(api.git.remote({ sessionId: chat })).rejects.toMatchObject({
      code: 'workspace_project_required',
    })
  })

  it('reports diagnostics with a kernel section', async () => {
    const { api, root, stateRoot } = await setup()
    const id = session(api)
    api.sessions.activate(id)
    const diagnostics = (await api.diagnostics.get()) as Record<string, any>
    expect(diagnostics.kernel).toMatchObject({
      activeSessionId: id,
      busySessions: [],
      activeRoute: 'test-route',
    })
    expect(diagnostics.kernel.tools).toEqual(
      expect.arrayContaining(['bash', 'read', 'ask_user_question', 'subagent']),
    )
    expect(diagnostics.paths).toMatchObject({
      runtimeRoot: root,
      stateRoot,
      sessionsRoot: join(stateRoot, 'sessions'),
      memoryRoot: join(stateRoot, 'memory'),
    })
  })

  it('keeps private writes under stateRoot, not the repository root', async () => {
    const { api, root, stateRoot } = await setup({
      replies: [{ text: 'pong' }],
    })
    const id = session(api)
    await api.chat.submit({ content: 'ping', sessionId: id })
    const skill =
      '---\nname: user-skill\ndescription: Mine\n---\n# User Skill\n'
    api.skillService.save('user-skill', skill)
    expect(
      readFileSync(join(stateRoot, 'skills', 'user-skill', 'SKILL.md'), 'utf8'),
    ).toBe(skill)
    expect(existsSync(join(stateRoot, 'sessions'))).toBe(true)
    expect(existsSync(join(root, 'memory'))).toBe(false)
    expect(existsSync(join(root, 'sessions'))).toBe(false)
    expect(existsSync(join(root, 'skills'))).toBe(false)
  })

  it('saves model config in stateRoot', async () => {
    const { api, root, stateRoot } = await setup()
    await api.model.saveEntry(validModelEntry('state-root-model') as never)
    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(true)
    expect(existsSync(join(root, 'model_config.json'))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'model_config.json'), 'utf8'))
        .models[0].displayName,
    ).toBe('state-root-model')
  })

  it('deletes skill directories through skills.delete', async () => {
    const root = tmp('emperor-core-api-skill-delete-')
    const stateRoot = join(root, 'home')
    mkdirSync(join(stateRoot, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(stateRoot, 'skills', 'demo', 'SKILL.md'), '# Demo\n')
    const { api } = await setup({ root, stateRoot })
    expect(api.skills.delete('demo')).toMatchObject({
      deleted: 'demo',
      scope: 'user',
    })
    expect(existsSync(join(stateRoot, 'skills', 'demo'))).toBe(false)
  })

  it('lists Skills per session and bootstraps invalid Skills with reasons', async () => {
    const root = tmp('emperor-core-api-skill-sessions-')
    const stateRoot = join(root, 'home')
    const project = join(root, 'project')
    mkdirSync(join(project, '.emperor', 'skills', 'deploy'), {
      recursive: true,
    })
    writeFileSync(
      join(project, '.emperor', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy the project\n---\n',
    )
    mkdirSync(join(stateRoot, 'skills', 'broken'), { recursive: true })
    writeFileSync(join(stateRoot, 'skills', 'broken', 'SKILL.md'), '# Broken\n')
    const { api } = await setup({ root, stateRoot })
    const build = String(
      api.sessions.create({
        title: 'Build',
        mode: 'build',
        project_path: project,
      }).id,
    )
    const chat = session(api)

    const names = (sessionId: string) =>
      api.skills.list({ sessionId }).skills.map((skill) => skill.name)
    expect(names(build)).toContain('deploy')
    expect(names(chat)).not.toContain('deploy')
    expect(api.skills.list({ sessionId: build }).invalid).toEqual([
      expect.objectContaining({
        name: 'broken',
        source: 'user',
        reason: 'SKILL.md must start with YAML frontmatter (---)',
      }),
    ])
    const boot = await api.bootstrap({ sessionId: build })
    expect(boot.skills.map((skill) => skill.name)).toContain('deploy')
    expect(boot.invalidSkills).toEqual([
      expect.objectContaining({ name: 'broken' }),
    ])
    expect(
      await api.commandApplicationService.skillsForSession(chat),
    ).not.toContainEqual(expect.objectContaining({ name: 'deploy' }))
    expect(api.skills.folderPath({ scope: 'project', sessionId: build })).toBe(
      join(project, '.emperor', 'skills'),
    )
  })

  it('manages desktop pet preference without spawning a process', async () => {
    const { api } = await setup()
    expect(await api.desktopPet.setEnabled(true)).toMatchObject({
      enabled: true,
      running: false,
      lastError: null,
    })
    expect((await api.desktopPet.get()).enabled).toBe(true)
    expect(await api.desktopPet.setEnabled(false)).toMatchObject({
      enabled: false,
      running: false,
    })
  })

  it('reads, validates, and saves Claude Code format hooks', async () => {
    const { api, stateRoot } = await setup()
    const empty = await api.hooks.getConfig()
    expect(empty).toMatchObject({
      path: join(stateRoot, 'hooks.json'),
      content: '',
      errors: [],
    })
    const config = {
      hooks: {
        PreToolUse: [
          { matcher: 'bash', hooks: [{ type: 'command', command: 'true' }] },
        ],
      },
    }
    expect(api.hooks.validateConfig({ config })).toMatchObject({ valid: true })
    expect(api.hooks.validateConfig({ content: '{not json' })).toMatchObject({
      valid: false,
    })
    const saved = await api.hooks.saveConfig(JSON.stringify(config))
    expect(saved).toMatchObject({ events: { PreToolUse: 1 }, errors: [] })
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'hooks.json'), 'utf8')),
    ).toEqual(config)
    expect((await api.hooks.getConfig()).content).toContain('PreToolUse')
    await expect(api.hooks.saveConfig('{not json')).rejects.toThrow()
    expect(api.hooks.getMetadata()).toMatchObject({ format: 'claude-code' })
  })

  it('reports and skips the profile interview', async () => {
    const { api } = await setup()
    const status = api.onboarding.getProfileStatus()
    expect(status).toMatchObject({ status: expect.any(String) })
    const skipped = await api.onboarding.skipProfileInterview()
    expect(skipped).toMatchObject({
      started: false,
      state: { status: 'skipped' },
    })
    expect(api.onboarding.getProfileStatus()).toMatchObject({
      status: 'skipped',
    })
  })

  it('rejects project workspace APIs for non-Build sessions', async () => {
    const { api } = await setup()
    const id = session(api)
    await expect(
      api.workspace.snapshot({ sessionId: id }),
    ).rejects.toMatchObject({ code: 'workspace_project_required' })
    await expect(
      api.git.status({ sessionId: id } as never),
    ).rejects.toMatchObject({ code: 'workspace_project_required' })
    await expect(
      api.files.list({ sessionId: id, relativePath: '' } as never),
    ).rejects.toMatchObject({ code: 'workspace_project_required' })
  })
})
