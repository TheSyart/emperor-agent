import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { ExternalInbound } from '../external/models'
import { makePlanRecord, PlanStatus } from '../plans/models'
import { ToolResultStore } from '../context/tool-results'
import { RuntimeEventStore } from '../runtime/store'
import { SchedulerPayload, SchedulerSchedule } from '../scheduler/models'
import { CoreApi, CORE_API_ROUTE_OPERATIONS } from './core-api'
import { CoreMutationGuardError } from './mutation-guard'
import { CoreSkillService } from './services/skill-service'
import { GoalContractValidator, newGoalRecord } from '../goals/validation'
import { ControlManager } from '../control/manager'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

const EXPECTED_OPERATIONS = [
  'attachments.rawPath',
  'attachments.save',
  'bootstrap',
  'chat.stopRuntime',
  'chat.submit',
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
  'external.get',
  'goals.cancel',
  'goals.get',
  'goals.list',
  'goals.pause',
  'goals.replace',
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
  'mcp.saveConfig',
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
  'model.setReasoningEffort',
  'model.test',
  'onboarding.getProfileStatus',
  'onboarding.skipProfileInterview',
  'onboarding.startProfileInterview',
  'plans.get',
  'plans.list',
  'projects.list',
  'projects.resolve',
  'runtime.replay',
  'scheduler.createJob',
  'scheduler.deleteJob',
  'scheduler.get',
  'scheduler.pauseJob',
  'scheduler.resumeJob',
  'scheduler.runJob',
  'scheduler.updateJob',
  'sessions.activate',
  'sessions.create',
  'sessions.delete',
  'sessions.list',
  'sessions.rename',
  'sidebar.get',
  'sidebar.patch',
  'skills.confirmInstall',
  'skills.create',
  'skills.delete',
  'skills.get',
  'skills.list',
  'skills.package',
  'skills.previewInstall',
  'skills.save',
  'skills.tools',
  'skills.validate',
  'tasks.get',
  'tasks.list',
  'tasks.transcript',
  'team.get',
  'team.getMember',
  'team.sendMessage',
  'team.shutdownMember',
  'team.spawnMember',
  'team.wakeMember',
  'tools.readResult',
]

describe('CoreApi (MIG-IPC-001)', () => {
  it('binds an approved Goal Plan before resuming the control turn', async () => {
    const root = tmp('emperor-core-api-goal-plan-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = api.loop.activeSessionId!
    const created = await api.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_core_api_plan',
        outcome: 'Approve and bind a Plan.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2026-07-15T14:00:00.000Z',
      }),
    )
    const active = GoalContractValidator.lock(
      created,
      {
        inScope: ['Plan approval'],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Plan approved.',
            required: true,
            verification: { kind: 'command', requirement: 'npm test' },
          },
        ],
        escalationConditions: [],
      },
      '2026-07-15T14:00:01.000Z',
    )
    const planning = await api.loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: active,
      expectedLastEventSeq: created.lastEventSeq,
    })
    api.loop.controlManager.setActiveGoalPlanContext(planning)
    api.control.setMode('plan')
    const interaction = api.loop.controlManager.createPlan({
      title: 'Approve Goal Plan',
      summary: 'Approve the Core-bound Plan.',
      planMarkdown: '# Plan\n\n- Run tests',
      steps: [
        {
          id: 'step_1',
          title: 'Run tests',
          files: ['package.json'],
          commands: ['npm test'],
          acceptance: ['tests pass'],
        },
      ],
    })

    const planId = String(interaction.meta.plan_id)
    const bridge = api.loop.goalPlanBridge
    const originalBind = bridge.bindApprovedPlan.bind(bridge)
    let observedPreparedQuarantine = false
    bridge.bindApprovedPlan = async (input) => {
      observedPreparedQuarantine = true
      expect(api.loop.controlManager.planStore.isQuarantined(planId)).toBe(true)
      expect(
        api.loop.controlManager.consumePlanPermissionToken({
          toolName: 'run_command',
          arguments: { command: 'npm test' },
        }),
      ).toBeNull()
      return originalBind(input)
    }

    await api.control.approvePlan(interaction.id, { uiHidden: true })

    expect(observedPreparedQuarantine).toBe(true)
    expect(api.loop.controlManager.planStore.isQuarantined(planId)).toBe(false)
    expect(await api.loop.goalStore.get(created.id)).toMatchObject({
      status: 'active',
      runtime: {
        phase: 'executing',
        currentPlanId: interaction.meta.plan_id,
      },
    })
    await api.close()
  })

  it('does not start Goal Plan approval when durable quarantine preparation fails', async () => {
    const root = tmp('emperor-core-api-goal-plan-prepare-fault-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = api.loop.activeSessionId!
    const created = await api.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_core_api_prepare_fault',
        outcome: 'Do not mutate approval without durable preparation.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2026-07-15T14:00:00.000Z',
      }),
    )
    const planning = await api.loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['Approval preparation'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'Approval does not start.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        '2026-07-15T14:00:01.000Z',
      ),
      expectedLastEventSeq: created.lastEventSeq,
    })
    api.loop.controlManager.setActiveGoalPlanContext(planning)
    api.control.setMode('plan')
    const interaction = api.loop.controlManager.createPlan({
      title: 'Prepare fault',
      summary: 'Preparation must precede approval.',
      planMarkdown: '# Plan\n\n- Run tests',
      steps: [
        {
          id: 'step_1',
          title: 'Run tests',
          commands: ['npm test'],
          acceptance: ['tests pass'],
        },
      ],
    })
    const planId = String(interaction.meta.plan_id)
    const planStore = api.loop.controlManager.planStore
    const beforeTasks = readFileSync(
      api.loop.taskManager.store.indexFile,
      'utf8',
    )
    planStore.quarantine = (() => {
      throw new Error('injected durable prepare failure')
    }) as typeof planStore.quarantine

    await expect(
      api.control.approvePlan(interaction.id, { uiHidden: true }),
    ).rejects.toThrow(/durable prepare failure/)
    expect(planStore.get(planId)?.status).toBe(PlanStatus.WAITING_APPROVAL)
    expect(planStore.get(planId)?.metadata.permission_tokens ?? []).toEqual([])
    expect(readFileSync(api.loop.taskManager.store.indexFile, 'utf8')).toBe(
      beforeTasks,
    )
    expect(api.loop.controlManager.payload().pending).not.toBeNull()
    expect(
      new ControlManager(api.loop.paths.stateRoot).planStore.isQuarantined(
        planId,
      ),
    ).toBe(true)
    await api.close()
  })

  it('aborts and compensates a Goal approval that fails inside approve()', async () => {
    const root = tmp('emperor-core-api-goal-plan-approve-fault-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = api.loop.activeSessionId!
    const created = await api.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_core_api_approve_fault',
        outcome: 'Fail closed during approval.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2026-07-15T14:00:00.000Z',
      }),
    )
    const planning = await api.loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['Approval compensation'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'No execution authority survives.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        '2026-07-15T14:00:01.000Z',
      ),
      expectedLastEventSeq: created.lastEventSeq,
    })
    api.loop.controlManager.setActiveGoalPlanContext(planning)
    api.control.setMode('plan')
    const interaction = api.loop.controlManager.createPlan({
      title: 'Approval fault',
      summary: 'Inject a failure after task/token preparation.',
      planMarkdown: '# Plan\n\n- Run tests',
      steps: [
        {
          id: 'step_1',
          title: 'Run tests',
          commands: ['npm test'],
          acceptance: ['tests pass'],
        },
      ],
    })
    const planId = String(interaction.meta.plan_id)
    const store = api.loop.controlManager.planStore
    const originalSave = store.save.bind(store)
    let injected = false
    store.save = ((record) => {
      if (!injected && record.status === PlanStatus.EXECUTING) {
        injected = true
        throw new Error('injected approve activation failure')
      }
      return originalSave(record)
    }) as typeof store.save

    await expect(
      api.control.approvePlan(interaction.id, { uiHidden: true }),
    ).rejects.toThrow(/activation failure/)
    expect(await api.loop.goalStore.get(created.id)).toMatchObject({
      runtime: { phase: 'planning', currentPlanId: null },
    })
    expect(store.get(planId)).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: { permission_tokens: [] },
    })
    expect(store.isQuarantined(planId)).toBe(false)
    expect(api.loop.controlManager.latestExecutablePlan()).toBeNull()
    expect(
      api.loop.taskManager.store
        .list()
        .filter((task) => task.metadata.plan_id === planId)
        .map((task) => task.status),
    ).not.toContain('running')
    await api.close()
  })

  it('preflights a Goal Plan before approval can issue tokens or create step tasks', async () => {
    const root = tmp('emperor-core-api-goal-plan-preflight-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = api.loop.activeSessionId!
    const created = await api.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_core_api_plan_preflight',
        outcome: 'Reject stale approval before mutation.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2026-07-15T14:00:00.000Z',
      }),
    )
    const planning = await api.loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['Plan approval'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'Plan remains unapproved.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        '2026-07-15T14:00:01.000Z',
      ),
      expectedLastEventSeq: created.lastEventSeq,
    })
    api.loop.controlManager.setActiveGoalPlanContext(planning)
    api.control.setMode('plan')
    const interaction = api.loop.controlManager.createPlan({
      title: 'Reject stale Goal Plan',
      summary: 'Do not mutate before exact preflight.',
      planMarkdown: '# Plan\n\n- Run tests',
      steps: [
        {
          id: 'step_1',
          title: 'Run tests',
          files: ['package.json'],
          commands: ['npm test'],
          acceptance: ['tests pass'],
        },
      ],
    })
    const planId = String(interaction.meta.plan_id)
    const plan = api.loop.controlManager.planStore.get(planId)!
    api.loop.controlManager.planStore.save({
      ...plan,
      metadata: {
        ...plan.metadata,
        scope: {
          ...(plan.metadata.scope as Record<string, unknown>),
          workspace_root: '/forged/workspace',
        },
      },
    })
    const beforePlan = readFileSync(
      api.loop.controlManager.planStore.indexFile,
      'utf8',
    )
    const beforeTasks = readFileSync(
      api.loop.taskManager.store.indexFile,
      'utf8',
    )

    await expect(
      api.control.approvePlan(interaction.id, { uiHidden: true }),
    ).rejects.toThrow(/scope/i)

    expect(
      readFileSync(api.loop.controlManager.planStore.indexFile, 'utf8'),
    ).toBe(beforePlan)
    expect(readFileSync(api.loop.taskManager.store.indexFile, 'utf8')).toBe(
      beforeTasks,
    )
    expect(api.loop.controlManager.planStore.get(planId)).toMatchObject({
      status: 'waiting_approval',
    })
    expect(api.loop.controlManager.payload().pending).not.toBeNull()
    await api.close()
  })

  it('starts with recoverable defaults when Model and MCP configs are corrupt', async () => {
    const root = tmp('emperor-core-api-corrupt-config-')
    const stateRoot = tmp('emperor-core-api-corrupt-state-')
    writeFileSync(join(stateRoot, 'model_config.json'), '{"models":[', 'utf8')
    writeFileSync(join(stateRoot, 'mcp_config.json'), '{"servers":', 'utf8')

    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
    })

    await expect(api.model.getConfig()).resolves.toMatchObject({
      schemaVersion: 2,
      models: [],
      activeModelId: null,
      availability: { usable: false },
    })
    await expect(api.mcp.getConfig()).resolves.toMatchObject({ servers: {} })
    expect(
      readdirSync(stateRoot).filter((name) => name.includes('.corrupt-')),
    ).toHaveLength(2)
    await api.close()
  })

  it('exposes a typed in-process method for every retired web route operation', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      stateRoot: tmp('emperor-core-api-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(CORE_API_ROUTE_OPERATIONS.map((op) => op.key).sort()).toEqual(
      EXPECTED_OPERATIONS,
    )
    for (const key of EXPECTED_OPERATIONS) {
      expect(resolveMethod(api, key), key).toBeTypeOf('function')
    }
    await api.close()
  })

  it('boots, submits a chat turn, and persists session runtime state without HTTP', async () => {
    const root = tmp('emperor-core-api-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const events: Array<Record<string, unknown>> = []

    const boot = await api.bootstrap()
    const session = api.sessions.create({ title: 'API Chat' })
    const reply = await api.chat.submit({
      content: 'ping',
      turnId: 'turn_api_1',
      sessionId: String(session.id),
      emit: async (event) => {
        events.push(event)
      },
    })
    const tools = boot.tools
    const activeSessionId = String(api.loop.activeSessionId ?? '')

    expect(boot.app).toBe('Emperor Agent')
    expect(boot).toMatchObject({
      sessionIndexSource: expect.any(String),
      repairedSessions: expect.any(Number),
    })
    expect(tools.some((tool) => tool.name === 'read_file')).toBe(true)
    expect(reply.content).toBe('pong')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(activeSessionId).toBeTruthy()
    expect(
      existsSync(
        join(root, '.emperor', 'sessions', activeSessionId, 'history.jsonl'),
      ),
    ).toBe(true)

    await api.close()
  })

  it('starts and controls a Goal through typed CoreApi operations and bootstrap', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-goals-'),
      stateRoot: tmp('emperor-core-api-goals-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = api.sessions.create({
      title: 'Goal owner',
      mode: 'build',
      project_path: process.cwd(),
    })
    api.sessions.activate(String(session.id))

    const started = await api.goals.start({
      outcome: 'Ship the typed Goal operations',
      sessionId: String(session.id),
    })
    expect(started).toMatchObject({
      accepted: true,
      goal: {
        sessionId: session.id,
        outcome: 'Ship the typed Goal operations',
      },
      activeTask: { kind: 'goal', session_id: session.id },
    })
    expect((await api.bootstrap()).goals).toMatchObject({
      active: { id: started.goal.id },
      recent: [{ id: started.goal.id }],
    })

    const paused = await api.goals.pause(started.goal.id)
    expect(paused.goal.phase).toBe('paused')
    const resumed = await api.goals.resume(started.goal.id)
    expect(resumed.accepted).toBe(true)
    const cancelled = await api.goals.cancel(started.goal.id, 'user requested')
    expect(cancelled.goal).toMatchObject({
      status: 'cancelled',
      phase: 'terminal',
    })
    await api.close()
  })

  it('materializes a draft before Goal creation and fences cross-session reads', async () => {
    const events: Array<Record<string, unknown>> = []
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-goal-draft-'),
      stateRoot: tmp('emperor-core-api-goal-draft-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      eventSink: async (event) => {
        events.push(event)
      },
    })
    const started = await api.goals.start({
      outcome: 'Promote draft once',
      sessionId: 'draft:goal-ui',
      clientDraftId: 'draft:goal-ui',
      draftSession: { mode: 'chat' },
    })
    expect(events.slice(0, 2).map((event) => event.event)).toEqual([
      'session_created',
      'goal_created',
    ])
    await api.goals.pause(started.goal.id)
    const other = api.sessions.create({ title: 'Other session' })
    api.sessions.activate(String(other.id))
    await expect(api.goals.get(started.goal.id)).rejects.toMatchObject({
      code: 'goal_session_mismatch',
    })
    api.sessions.activate(started.goal.sessionId)
    await api.goals.cancel(started.goal.id)
    await api.close()
  })

  it('pauses Goals before archive and cancels, settles, then deletes Goal state with the session', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-goal-session-lifecycle-'),
      stateRoot: tmp('emperor-core-api-goal-session-lifecycle-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = api.sessions.create({ title: 'Disposable Goal session' })
    api.sessions.activate(String(session.id))
    const started = await api.goals.start({
      outcome: 'Pause before archive',
      sessionId: String(session.id),
    })

    await api.sessions.rename(String(session.id), { archived: true })
    expect(await api.loop.goalStore.get(started.goal.id)).toMatchObject({
      runtime: { phase: 'paused', pauseReason: 'session_archived' },
    })
    const deleted = await api.sessions.delete(String(session.id))
    expect(deleted).toMatchObject({ deleted: true, removedGoals: 1 })
    expect(await api.loop.goalStore.get(started.goal.id)).toBeNull()
    await api.close()
  })

  it('forwards renderer attachment and requested skill fields to ChatService', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-chat-fields-'),
      stateRoot: tmp('emperor-core-api-chat-fields-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const submit = vi.spyOn(api.chatService, 'submit').mockResolvedValue({
      turnId: 'turn_fields',
      content: 'ok',
      activeSessionId: 'session_fields',
    })

    await (
      api.chat.submit as (input: Record<string, unknown>) => Promise<unknown>
    )({
      content: 'inspect attachment',
      attachments: ['att_1'],
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
    })

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: ['att_1'],
        requestedSkills: [{ name: 'reviewer', source: 'slash' }],
      }),
    )
    await api.close()
  })

  it('stores new private runtime state under .emperor and reports effective paths', async () => {
    const root = tmp('emperor-core-api-state-root-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const session = api.sessions.create({ title: 'State Root Chat' })
    await api.chat.submit({
      content: 'ping',
      turnId: 'turn_state_1',
      sessionId: String(session.id),
      emit: async () => {},
    })
    const diagnostics = await api.diagnostics.get()

    expect(
      existsSync(join(root, '.emperor', 'memory', 'MEMORY.local.md')),
    ).toBe(true)
    expect(
      existsSync(
        join(root, '.emperor', 'sessions', String(session.id), 'history.jsonl'),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          root,
          '.emperor',
          'sessions',
          String(session.id),
          'runtime',
          'events.jsonl',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          root,
          '.emperor',
          'sessions',
          String(session.id),
          'prompt-snapshots',
          'turn_state_1.json',
        ),
      ),
    ).toBe(true)
    expect(existsSync(join(root, '.emperor', 'control', 'state.json'))).toBe(
      true,
    )
    expect(existsSync(join(root, '.emperor', '.team', 'config.json'))).toBe(
      false,
    )
    expect(existsSync(join(root, 'memory'))).toBe(false)
    expect(existsSync(join(root, 'sessions'))).toBe(false)
    expect(diagnostics.paths).toMatchObject({
      runtimeRoot: root,
      stateRoot: join(root, '.emperor'),
      sessionsRoot: join(root, '.emperor', 'sessions'),
      memoryRoot: join(root, '.emperor', 'memory'),
    })
    expect((diagnostics as any).promptSnapshots.recent[0]).toMatchObject({
      sessionId: String(session.id),
      turnId: 'turn_state_1',
    })
    expect(
      (diagnostics as any).promptSnapshots.recent[0].sections.map(
        (section: any) => section.name,
      ),
    ).toContain('bootstrap')

    await api.close()
  })

  it('migrates private state from an explicit legacy runtime without changing signed runtimeRoot', async () => {
    const signedRuntimeRoot = tmp('emperor-core-api-signed-runtime-')
    const legacyRuntimeRoot = tmp('emperor-core-api-legacy-runtime-')
    const stateRoot = tmp('emperor-core-api-legacy-state-')
    mkdirSync(join(legacyRuntimeRoot, 'memory'), { recursive: true })
    writeFileSync(
      join(legacyRuntimeRoot, 'memory', 'MEMORY.local.md'),
      '# Legacy private memory\n',
      'utf8',
    )
    const legacySkillRoot = join(
      legacyRuntimeRoot,
      '.emperor',
      'skills',
      'legacy-direct',
    )
    mkdirSync(legacySkillRoot, { recursive: true })
    writeFileSync(
      join(legacySkillRoot, 'SKILL.md'),
      '# Must remain blocked by packaged migration\n',
      'utf8',
    )
    const options = {
      root: signedRuntimeRoot,
      stateRoot,
      legacyRuntimeRoot,
      legacyRuntimeSkillsHandled: true,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    }

    const api = await CoreApi.create(options)

    expect(api.paths.runtimeRoot).toBe(resolve(signedRuntimeRoot))
    expect(
      readFileSync(join(stateRoot, 'memory', 'MEMORY.local.md'), 'utf8'),
    ).toBe('# Legacy private memory\n')
    expect(api.loop.legacyStateMigration.legacyStateRoots[0]?.path).toBe(
      join(legacyRuntimeRoot, 'memory'),
    )
    expect(
      readFileSync(
        join(legacyRuntimeRoot, 'memory', 'MEMORY.local.md'),
        'utf8',
      ),
    ).toBe('# Legacy private memory\n')
    expect(existsSync(join(stateRoot, 'skills', 'legacy-direct'))).toBe(false)

    await api.close()
  })

  it('keeps all user writes in stateRoot when runtime resources are read-only', async () => {
    const runtimeRoot = tmp('emperor-core-api-readonly-runtime-')
    const legacyRuntimeRoot = join(
      tmp('emperor-core-api-readonly-legacy-'),
      'runtime',
    )
    const stateRoot = tmp('emperor-core-api-readonly-state-')
    const before = readdirSync(runtimeRoot)
    chmodSync(runtimeRoot, 0o555)

    try {
      const api = await CoreApi.create({
        root: runtimeRoot,
        stateRoot,
        legacyRuntimeRoot,
        legacyRuntimeSkillsHandled: true,
        templatesDir: TEMPLATES_DIR,
        modelRouter: fakeRouter(new FakeProvider()),
      })
      api.skillService.save('user-skill', '# User Skill\n')

      expect(
        readFileSync(
          join(stateRoot, 'skills', 'user-skill', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('# User Skill\n')
      expect(readdirSync(runtimeRoot)).toEqual(before)

      await api.close()
    } finally {
      chmodSync(runtimeRoot, 0o755)
    }
  })

  it('manages hooks config, audit, and test runs through CoreApi', async () => {
    const root = tmp('emperor-core-api-hooks-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const before = (await api.hooks.getConfig()) as any
    const saved = (await api.hooks.saveConfig({
      revision: before.revision,
      config: {
        version: 2,
        hooks: {
          PreToolUse: [
            {
              id: 'api-deny',
              matcher: 'write_file',
              handlers: [
                {
                  id: 'api-deny-command',
                  type: 'command',
                  command: process.execPath,
                  args: [
                    '-e',
                    'process.stdout.write(JSON.stringify({decision:"deny",reason:"api blocked"}))',
                  ],
                },
              ],
            },
          ],
        },
      },
    })) as any
    const loaded = (await api.hooks.getConfig()) as any
    const match = (await api.hooks.testMatch({
      revision: loaded.revision,
      eventName: 'PreToolUse',
      input: {
        tool_name: 'write_file',
        tool_input: { path: 'x.txt' },
        tool_use_id: 'api-call',
      },
    })) as any
    const testRun = (await api.hooks.testRun({
      revision: loaded.revision,
      eventName: 'PreToolUse',
      groupId: 'api-deny',
      handlerId: 'api-deny-command',
      confirmExecution: true,
      input: {
        tool_name: 'write_file',
        tool_input: { path: 'x.txt' },
        tool_use_id: 'api-call',
      },
    })) as any
    const audit = (await api.hooks.getAudit({ limit: 5 })) as any
    const boot = (await api.bootstrap()) as any

    expect(saved).toMatchObject({ saved: true, config: { version: 2 } })
    expect(loaded.effectiveGroups[0]).toMatchObject({
      eventName: 'PreToolUse',
      group: { id: 'api-deny', handlers: [{ id: 'api-deny-command' }] },
      source: { kind: 'global', readonly: false },
    })
    expect(match.items).toEqual([
      expect.objectContaining({
        groupId: 'api-deny',
        handlerId: 'api-deny-command',
      }),
    ])
    expect(testRun.decision).toBe('deny')
    expect(testRun.reason).toBe('api blocked')
    expect(
      audit.records.some(
        (record: any) =>
          record.groupId === 'api-deny' &&
          record.handlerId === 'api-deny-command',
      ),
    ).toBe(true)
    expect(boot.hooks.summary.total).toBe(1)

    await api.close()
  })

  it('publishes hooks metadata, pure validation, matching, and optimistic revisions', async () => {
    const root = tmp('emperor-core-api-hooks-contract-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const initial = (await api.hooks.getConfig()) as any
    const metadata = api.hooks.getMetadata() as any
    const validated = api.hooks.validateConfig({
      config: {
        version: 2,
        hooks: {
          Stop: [
            {
              id: 'check',
              handlers: [
                { id: 'prompt', type: 'prompt', prompt: 'Check completion.' },
              ],
            },
          ],
        },
      },
    }) as any
    const invalid = api.hooks.validateConfig({
      config: {
        version: 2,
        hooks: {
          Stop: [
            {
              id: 'duplicate',
              handlers: [
                { id: 'same', type: 'command', command: 'true' },
                { id: 'same', type: 'command', command: 'true' },
              ],
            },
          ],
        },
      },
    }) as any
    const auditBefore = (await api.hooks.getAudit()) as any
    const match = (await api.hooks.testMatch({
      revision: initial.revision,
      eventName: 'Stop',
      input: { reason: 'done' },
    })) as any
    const auditAfter = (await api.hooks.getAudit()) as any

    expect(metadata.events).toHaveLength(18)
    expect(metadata.handlers).toEqual(
      expect.objectContaining({
        command: expect.any(Object),
        http: expect.any(Object),
        prompt: expect.any(Object),
        agent: expect.any(Object),
      }),
    )
    expect(validated).toMatchObject({ valid: true, config: { version: 2 } })
    expect(invalid.valid).toBe(false)
    expect(invalid.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_handler_id' }),
      ]),
    )
    expect(match).toMatchObject({
      revision: initial.revision,
      eventName: 'Stop',
      items: [],
    })
    expect(auditAfter.records).toEqual(auditBefore.records)
    await expect(
      api.hooks.saveConfig({
        revision: 'stale-revision',
        config: validated.config,
      }),
    ).rejects.toThrow(/stale hooks revision/i)
    expect(((await api.hooks.getConfig()) as any).revision).toBe(
      initial.revision,
    )

    await api.close()
  })

  it('requires confirmation and exact matching selection for hook test execution', async () => {
    const root = tmp('emperor-core-api-hook-test-run-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const initial = (await api.hooks.getConfig()) as any
    const saved = (await api.hooks.saveConfig({
      revision: initial.revision,
      config: {
        version: 2,
        hooks: {
          Stop: [
            {
              id: 'stop-check',
              matcher: 'done',
              handlers: [
                {
                  id: 'stop-command',
                  type: 'command',
                  command: process.execPath,
                  args: ['-e', 'process.stdout.write("{}")'],
                },
              ],
            },
          ],
        },
      },
    })) as any
    const request = {
      revision: saved.revision,
      eventName: 'Stop',
      groupId: 'stop-check',
      handlerId: 'stop-command',
      input: { reason: 'done' },
    }

    await expect(api.hooks.testRun(request)).rejects.toThrow(
      /confirmExecution=true/,
    )
    await expect(
      api.hooks.testRun({
        ...request,
        confirmExecution: true,
        handlerId: 'missing',
      }),
    ).rejects.toThrow(/does not match/)
    await expect(
      api.hooks.testRun({
        ...request,
        confirmExecution: true,
        input: { reason: 'different' },
      }),
    ).rejects.toThrow(/does not match/)

    await api.close()
  })

  it('trusts only the active canonical project at its current hooks digest', async () => {
    const root = tmp('emperor-core-api-hook-trust-')
    const stateRoot = join(root, '.emperor-state')
    const projectRoot = join(root, 'project')
    mkdirSync(join(projectRoot, '.emperor'), { recursive: true })
    writeFileSync(
      join(projectRoot, '.emperor', 'settings.json'),
      JSON.stringify({
        version: 2,
        hooks: {
          Stop: [
            {
              id: 'project-stop',
              handlers: [
                { id: 'project-command', type: 'command', command: 'true' },
              ],
            },
          ],
        },
      }),
    )
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const initial = (await api.hooks.getConfig()) as any
    await api.hooks.saveConfig({
      revision: initial.revision,
      config: { version: 2, projectHooks: { enabled: true }, hooks: {} },
    })
    const build = api.sessions.create({
      title: 'Hook Project',
      mode: 'build',
      project_path: projectRoot,
    }) as any
    api.sessions.activate(build.id)
    const untrusted = (await api.hooks.getConfig()) as any

    expect(untrusted.projectTrust).toMatchObject({
      canonicalRoot: realpathSync.native(projectRoot),
      status: 'untrusted',
      digest: expect.any(String),
    })
    expect(
      untrusted.sources.find((source: any) => source.id === 'project'),
    ).toMatchObject({ active: false, blockedReason: 'project_untrusted' })
    await expect(
      api.hooks.setProjectTrust({
        projectRoot: root,
        expectedDigest: untrusted.projectTrust.digest,
        trusted: true,
      }),
    ).rejects.toThrow(/active project/)
    await expect(
      api.hooks.setProjectTrust({
        projectRoot,
        expectedDigest: 'stale-digest',
        trusted: true,
      }),
    ).rejects.toThrow(/digest changed/)

    const trusted = (await api.hooks.setProjectTrust({
      projectRoot,
      expectedDigest: untrusted.projectTrust.digest,
      trusted: true,
    })) as any
    const loaded = (await api.hooks.getConfig()) as any
    expect(trusted.status).toBe('trusted')
    expect(loaded.projectTrust.status).toBe('trusted')
    expect(loaded.effectiveGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: 'Stop',
          group: expect.objectContaining({ id: 'project-stop' }),
          source: expect.objectContaining({ kind: 'project', active: true }),
        }),
      ]),
    )

    await api.close()
  })

  it('filters and pages hook audit records and reports missing cancellation targets', async () => {
    const root = tmp('emperor-core-api-hook-audit-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const initial = (await api.hooks.getConfig()) as any
    const saved = (await api.hooks.saveConfig({
      revision: initial.revision,
      config: {
        version: 2,
        hooks: {
          Stop: [
            {
              id: 'audit-stop',
              handlers: [
                {
                  id: 'audit-command',
                  type: 'command',
                  command: process.execPath,
                  args: [
                    '-e',
                    'process.stdout.write(JSON.stringify({continue:false}))',
                  ],
                },
              ],
            },
          ],
        },
      },
    })) as any
    const request = {
      revision: saved.revision,
      eventName: 'Stop',
      groupId: 'audit-stop',
      handlerId: 'audit-command',
      confirmExecution: true,
      input: { reason: 'completed' },
    }
    await api.hooks.testRun(request)
    await api.hooks.testRun(request)

    const first = (await api.hooks.getAudit({
      eventName: 'Stop',
      outcome: 'passthrough',
      sourceId: 'global',
      limit: 1,
    })) as any
    const second = (await api.hooks.getAudit({
      eventName: 'Stop',
      outcome: 'passthrough',
      sourceId: 'global',
      limit: 1,
      cursor: first.nextCursor,
    })) as any
    const excluded = (await api.hooks.getAudit({
      eventName: 'PreToolUse',
      limit: 10,
    })) as any
    expect(first).toMatchObject({
      total: 2,
      cursor: '0',
      nextCursor: '1',
      records: [
        expect.objectContaining({
          eventName: 'Stop',
          handlerId: 'audit-command',
        }),
      ],
    })
    expect(second).toMatchObject({
      total: 2,
      cursor: '1',
      nextCursor: null,
      records: [expect.objectContaining({ eventName: 'Stop' })],
    })
    expect(excluded.records).toEqual([])
    await expect(
      api.hooks.cancelRun({ runId: 'missing-run' }),
    ).resolves.toEqual({ runId: 'missing-run', cancelled: false })

    await api.close()
  })

  it('returns an async hook run id that can be cancelled exactly once', async () => {
    const root = tmp('emperor-core-api-hook-cancel-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const initial = (await api.hooks.getConfig()) as any
    const saved = (await api.hooks.saveConfig({
      revision: initial.revision,
      config: {
        version: 2,
        hooks: {
          Stop: [
            {
              id: 'async-stop',
              handlers: [
                {
                  id: 'async-command',
                  type: 'command',
                  command: process.execPath,
                  args: [
                    '-e',
                    'setTimeout(() => process.stdout.write("{}"), 5000)',
                  ],
                  async: true,
                  asyncRewake: true,
                  timeoutMs: 10_000,
                },
              ],
            },
          ],
        },
      },
    })) as any
    const started = (await api.hooks.testRun({
      revision: saved.revision,
      eventName: 'Stop',
      groupId: 'async-stop',
      handlerId: 'async-command',
      confirmExecution: true,
      input: { reason: 'completed' },
    })) as any
    const runId = started.results[0]?.hookRunId

    expect(runId).toMatch(/^hook_run_/)
    await expect(api.hooks.cancelRun({ runId })).resolves.toEqual({
      runId,
      cancelled: true,
    })
    await expect(api.hooks.cancelRun({ runId })).resolves.toEqual({
      runId,
      cancelled: false,
    })

    await api.close()
  })

  it('runs ConfigChange before config, MCP, and model writes', async () => {
    const root = tmp('emperor-core-api-config-change-')
    const stateRoot = join(root, '.emperor')
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const initialHooks = (await api.hooks.getConfig()) as any
    await api.hooks.saveConfig({
      revision: initialHooks.revision,
      config: {
        version: 2,
        hooks: {
          ConfigChange: [
            {
              id: 'deny-config',
              handlers: [
                {
                  id: 'deny-command',
                  type: 'command',
                  command: process.execPath,
                  args: [
                    '-e',
                    'process.stdout.write(JSON.stringify({decision:"deny",reason:"locked"}))',
                  ],
                },
              ],
            },
          ],
        },
      },
    })
    const userBefore = api.config.get().content

    await expect(
      Promise.resolve(
        api.config.save({ content: '## Stable Preferences\n\n- forbidden\n' }),
      ),
    ).rejects.toThrow(/ConfigChange hook denied config\.save/)
    await expect(
      api.mcp.saveConfig({ servers: {}, defaults: { read_only: false } }),
    ).rejects.toThrow(/ConfigChange hook denied mcp\.saveConfig/)
    await expect(
      api.model.saveEntry(validModelEntry('forbidden-model')),
    ).rejects.toThrow(/ConfigChange hook denied model\.saveEntry/)
    expect(api.config.get().content).toBe(userBefore)
    expect(existsSync(join(stateRoot, 'mcp_config.json'))).toBe(false)
    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(false)

    await api.close()
  })

  it('saves model config through stateRoot rather than runtimeRoot', async () => {
    const root = tmp('emperor-core-api-model-runtime-')
    const stateRoot = tmp('emperor-core-api-model-state-')
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    await api.model.saveEntry(validModelEntry('state-root-model'))

    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(true)
    expect(existsSync(join(root, 'model_config.json'))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'model_config.json'), 'utf8'))
        .models[0].displayName,
    ).toBe('state-root-model')

    await api.close()
  })

  it('rejects draft session ids at bootstrap before activating or replaying', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-bootstrap-session-'),
      stateRoot: tmp('emperor-core-api-bootstrap-session-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const activeSessionId = api.loop.activeSessionId

    await expect(
      api.bootstrap({ sessionId: 'draft:new-chat' }),
    ).rejects.toThrow(/draft/i)
    expect(api.loop.activeSessionId).toBe(activeSessionId)

    await api.close()
  })

  it('replays runtime events for the requested session only', async () => {
    const root = tmp('emperor-core-api-runtime-replay-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const firstSessionId = String(api.loop.activeSessionId)
    const second = api.sessions.create({ title: 'Second Chat' })

    await api.chat.submit({
      content: 'first',
      turnId: 'turn_first',
      sessionId: firstSessionId,
      emit: async () => {},
    })
    await api.chat.submit({
      content: 'second',
      turnId: 'turn_second',
      sessionId: String(second.id),
      emit: async () => {},
    })

    const replay = api.runtime.replay({
      sessionId: firstSessionId,
      afterSeq: 0,
    }) as any
    const turnIds = replay.events.map((event: any) => event.turn_id)

    expect(replay).toMatchObject({
      sessionId: firstSessionId,
      afterSeq: 0,
      latestSeq: expect.any(Number),
    })
    expect(turnIds).toContain('turn_first')
    expect(turnIds).not.toContain('turn_second')
    expect(
      replay.events.every((event: any) => event.session_id === firstSessionId),
    ).toBe(true)

    const boot = await api.bootstrap({ sessionId: firstSessionId })
    const bootTurnIds = ((boot.runtime as any).events as any[]).map(
      (event) => event.turn_id,
    )
    expect(bootTurnIds).toContain('turn_first')
    expect(bootTurnIds).not.toContain('turn_second')

    await api.close()
  })

  it('compacts high-frequency delta events in replay by default without touching disk', async () => {
    const root = tmp('emperor-core-api-replay-compact-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const sessionId = String(api.loop.activeSessionId)
    const store = new RuntimeEventStore(
      api.loop.sessionStore.sessionDir(sessionId),
      { sessionDirOverride: true },
    )
    store.append(
      { event: 'user_message', content: 'go' },
      { turnId: 't1', sessionId },
    )
    for (let index = 0; index < 20; index += 1) {
      store.append(
        {
          event: 'plan_draft_delta',
          tool_call_id: 'c1',
          interaction: {
            id: 'p',
            title: 'T'.repeat(index + 1),
            meta: { plan_stream_id: 'c1' },
          },
        },
        { turnId: 't1', sessionId },
      )
    }
    store.append(
      { event: 'assistant_done', content: 'done' },
      { turnId: 't1', sessionId },
    )

    const replay = api.runtime.replay({ sessionId, afterSeq: 0 }) as any
    expect(
      replay.events.filter((event: any) => event.event === 'plan_draft_delta'),
    ).toHaveLength(1)
    expect(
      replay.events.find((event: any) => event.event === 'plan_draft_delta')
        .interaction.title,
    ).toBe('T'.repeat(20))

    const full = api.runtime.replay({
      sessionId,
      afterSeq: 0,
      compact: false,
    }) as any
    expect(
      full.events.filter((event: any) => event.event === 'plan_draft_delta'),
    ).toHaveLength(20)

    const boot = await api.bootstrap({ sessionId })
    expect(
      ((boot.runtime as any).events as any[]).filter(
        (event) => event.event === 'plan_draft_delta',
      ),
    ).toHaveLength(1)

    await api.close()
  })

  it('stamps active turn tasks with their session id and exposes them at bootstrap', async () => {
    class LatchedProvider extends FakeProvider {
      release: () => void = () => {}
      private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve
      })
      override async chat(args: ChatArgs): Promise<LLMResponse> {
        await this.gate
        return super.chat(args)
      }
    }
    const provider = new LatchedProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-active-session-'),
      stateRoot: tmp('emperor-core-api-active-session-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const sessionId = String(api.loop.activeSessionId)

    const idle = await api.bootstrap()
    expect((idle.runtime as any).active_tasks).toEqual([])

    const turn = api.chat.submit({
      content: 'hi',
      turnId: 'turn_active',
      sessionId,
      emit: async () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const active = api.loop.activeTasks.list()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      kind: 'turn',
      turn_id: 'turn_active',
      session_id: sessionId,
    })

    provider.release()
    await turn
    await api.close()
  })

  it('promotes a draft submit into a real session with one-shot title generation (P1-6)', async () => {
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-draft-submit-'),
      stateRoot: tmp('emperor-core-api-draft-submit-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const events: Array<Record<string, unknown>> = []
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
      emit: async (event) => {
        events.push(event)
      },
    })

    const created = events.find(
      (event) => event.event === 'session_created',
    ) as any
    expect(created).toBeTruthy()
    expect(created.client_draft_id).toBe(draftId)
    expect(created.session).toMatchObject({
      title: '新会话',
      mode: 'build',
      project_id: 'proj_1',
      title_status: 'pending',
    })
    const newSessionId = String(created.session.id)
    expect(result.activeSessionId).toBe(newSessionId)

    const createdIndex = events.findIndex(
      (event) => event.event === 'session_created',
    )
    const userIndex = events.findIndex(
      (event) => event.event === 'user_message',
    )
    expect(userIndex).toBeGreaterThan(createdIndex)

    const titleEvent = events.find(
      (event) => event.event === 'session_title_updated',
    ) as any
    expect(titleEvent).toBeTruthy()
    expect(titleEvent.session.id).toBe(newSessionId)
    const entry = api.loop.sessionStore.get(newSessionId)!
    expect(entry.title_status).toBe('generated')
    expect(entry.title).toBe('pong')

    // 第二条消息走真实 session，不再创建、不再生成标题
    const callsAfterFirst = provider.calls.length
    const secondEvents: Array<Record<string, unknown>> = []
    await api.chat.submit({
      content: '继续',
      sessionId: newSessionId,
      emit: async (event) => {
        secondEvents.push(event)
      },
    })
    expect(
      secondEvents.find((event) => event.event === 'session_created'),
    ).toBeUndefined()
    expect(
      secondEvents.find((event) => event.event === 'session_title_updated'),
    ).toBeUndefined()
    expect(provider.calls.length).toBe(callsAfterFirst + 1)

    await api.close()
  })

  it('defers title generation for trivially short first messages and feeds the reply as material (2026-07-05 B7)', async () => {
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-short-title-'),
      stateRoot: tmp('emperor-core-api-short-title-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const draftId = 'draft:short-hi'

    await api.chat.submit({
      content: 'hi',
      sessionId: draftId,
      clientDraftId: draftId,
      draftSession: { mode: 'chat' },
      emit: async () => {},
    })

    // 标题调用（命名 system prompt）必须发生在回合之后，且材料里带上助手回复
    const titleCall = provider.calls.find((call) =>
      call.messages.some((message) =>
        String(message.content ?? '').includes('命名'),
      ),
    )
    expect(titleCall).toBeTruthy()
    const userPrompt = String(
      titleCall!.messages.find((message) => message.role === 'user')?.content ??
        '',
    )
    expect(userPrompt).toContain('pong')
    const session = api.loop.sessionStore.get(String(api.loop.activeSessionId))!
    expect(session.title).not.toBe('hi')
    expect(session.title_status).toBe('generated')

    await api.close()
  })

  it('matches session route response shapes for IPC callers', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      stateRoot: tmp('emperor-core-api-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const created = api.sessions.create({ title: 'Work' })
    const items = api.sessions.list()
    const renamed = await api.sessions.rename(String(created.id), {
      title: 'Renamed',
    })
    const archived = await api.sessions.rename(String(created.id), {
      archived: true,
    })
    const all = api.sessions.list({ includeArchived: true })
    const activated = api.sessions.activate(String(api.loop.activeSessionId))

    expect(Array.isArray(items)).toBe(true)
    expect(items.some((item) => item.id === created.id)).toBe(true)
    expect(renamed).toMatchObject({ id: created.id, title: 'Renamed' })
    expect(archived).toMatchObject({ id: created.id })
    expect(String(archived.archived_at || '')).toBeTruthy()
    expect(all.some((item) => item.id === created.id)).toBe(true)
    expect(activated).toMatchObject({
      active: api.loop.activeSessionId,
      complete: true,
    })

    await api.close()
  })

  it('returns distinct workspace and agent state paths for resolved projects', async () => {
    const root = tmp('emperor-core-api-project-paths-')
    const projectDir = tmp('emperor-core-api-project-workspace-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const project = api.projects.resolve(projectDir) as any

    expect(project).toMatchObject({
      project_path: resolve(projectDir),
      workspace_path: resolve(projectDir),
      state_path: join(root, '.emperor', 'projects', project.project_id),
      memory_path: join(
        root,
        '.emperor',
        'projects',
        project.project_id,
        'AGENTS.local.md',
      ),
      agents_path: join(
        root,
        '.emperor',
        'projects',
        project.project_id,
        'AGENTS.local.md',
      ),
      legacy_agents_path: null,
      legacy_imported_at: null,
    })
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)

    await api.close()
  })

  it('keeps chat and build project contexts isolated in provider prompts', async () => {
    const root = tmp('emperor-core-api-context-isolation-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const chatSessionId = String(api.loop.activeSessionId)
    const projectAPath = join(root, 'project-a')
    const projectBPath = join(root, 'project-b')
    mkdirSync(projectAPath, { recursive: true })
    mkdirSync(projectBPath, { recursive: true })
    const projectA = api.projects.resolve(projectAPath) as any
    const projectB = api.projects.resolve(projectBPath) as any
    api.loop.projectStore.updateMemory(
      String(projectA.project_id),
      '## Architecture Notes\n\n- PROJECT_A_PRIVATE_MEMORY',
    )
    api.loop.projectStore.updateMemory(
      String(projectB.project_id),
      '## Architecture Notes\n\n- PROJECT_B_PRIVATE_MEMORY',
    )
    const buildA = api.sessions.create({
      title: 'Build A',
      mode: 'build',
      project_path: projectAPath,
    })
    const buildB = api.sessions.create({
      title: 'Build B',
      mode: 'build',
      project_path: projectBPath,
    })
    api.control.setMode('auto')

    await api.chat.submit({
      content: 'ping',
      turnId: 'turn_chat_iso',
      sessionId: chatSessionId,
    })
    await api.chat.submit({
      content: 'ping',
      turnId: 'turn_a_iso',
      sessionId: String(buildA.id),
    })
    await api.chat.submit({
      content: 'ping',
      turnId: 'turn_b_iso',
      sessionId: String(buildB.id),
    })

    const prompts = provider.calls
      .slice(-3)
      .map((call) => JSON.stringify(call.messages))
    const chatPrompt = prompts[0] ?? ''
    const promptA = prompts[1] ?? ''
    const promptB = prompts[2] ?? ''

    expect(chatPrompt).not.toContain('PROJECT_A_PRIVATE_MEMORY')
    expect(chatPrompt).not.toContain('PROJECT_B_PRIVATE_MEMORY')
    expect(promptA).toContain(JSON.stringify(projectAPath).slice(1, -1))
    expect(promptA).toContain('PROJECT_A_PRIVATE_MEMORY')
    expect(promptA).not.toContain('PROJECT_B_PRIVATE_MEMORY')
    expect(promptB).toContain(JSON.stringify(projectBPath).slice(1, -1))
    expect(promptB).toContain('PROJECT_B_PRIVATE_MEMORY')
    expect(promptB).not.toContain('PROJECT_A_PRIVATE_MEMORY')
    expect(
      readFileSync(
        join(root, '.emperor', 'sessions', chatSessionId, 'history.jsonl'),
        'utf8',
      ),
    ).toContain('turn_chat_iso')
    expect(
      readFileSync(
        join(root, '.emperor', 'sessions', String(buildA.id), 'history.jsonl'),
        'utf8',
      ),
    ).toContain('turn_a_iso')
    expect(
      readFileSync(
        join(root, '.emperor', 'sessions', String(buildB.id), 'history.jsonl'),
        'utf8',
      ),
    ).toContain('turn_b_iso')

    await api.close()
  })

  it('reconciles stale session pending tags before bootstrap and session list responses', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-control-tags-'),
      stateRoot: tmp('emperor-core-api-control-tags-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const active = api.loop.sessionStore.get(String(api.loop.activeSessionId))!
    const stale = api.loop.sessionStore.create('Stale Session')
    api.loop.sessionStore.setControlPending(active.id, {
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: 'plan_current',
      updated_at: 1,
    })
    api.loop.sessionStore.setControlPending(stale.id, {
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_stale',
      updated_at: 2,
    })

    await api.bootstrap()

    expect(api.loop.sessionStore.get(active.id)?.control_pending).toBeNull()
    expect(api.loop.sessionStore.get(stale.id)?.control_pending).toBeNull()

    const pending = api.loop.controlManager.createPlan({
      title: 'Pending Plan',
      summary: 'Need approval',
      planMarkdown: '# Plan',
      riskLevel: 'low',
    })
    api.loop.sessionStore.setControlPending(stale.id, {
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_stale',
      updated_at: 3,
    })

    const sessions = api.sessions.list()

    expect(api.loop.sessionStore.get(active.id)?.control_pending).toMatchObject(
      { interaction_id: pending.id },
    )
    expect(api.loop.sessionStore.get(stale.id)?.control_pending).toBeNull()
    expect(
      sessions.find((item) => item.id === active.id)?.control_pending,
    ).toMatchObject({ interaction_id: pending.id })
    expect(
      sessions.find((item) => item.id === stale.id)?.control_pending,
    ).toBeNull()

    await api.close()
  })

  it('serves USER.local.md through the config route parity surface', async () => {
    const root = tmp('emperor-core-api-config-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const initial = api.config.get()

    expect(initial).toMatchObject({ path: 'memory/profile/USER.local.md' })
    expect(
      readFileSync(
        join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
        'utf8',
      ),
    ).toBe((initial as any).content)
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(false)

    const saved = await api.config.save({
      content: '## Stable Preferences\n\n- 偏好更新\n',
    })

    expect(saved).toMatchObject({ path: 'memory/profile/USER.local.md' })
    expect((saved as any).content).toContain(
      '## Stable Preferences\n\n- 偏好更新',
    )
    expect(
      readFileSync(
        join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
        'utf8',
      ),
    ).toContain('## Stable Preferences\n\n- 偏好更新')
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(false)
    expect(api.onboarding.getProfileStatus()).toMatchObject({
      status: 'completed',
      canStart: false,
    })

    await api.close()
  })

  it('exposes resumable profile onboarding status, cancellation, and permanent skip', async () => {
    class ProfileAskProvider extends FakeProvider {
      override async chat(args: ChatArgs): Promise<LLMResponse> {
        this.calls.push(args)
        return {
          content: '',
          toolCalls: [
            {
              id: 'call_profile_ask',
              name: 'ask_user',
              arguments: {
                questions: [
                  {
                    id: 'identity',
                    header: '基本信息',
                    question: '希望我如何称呼你？',
                    options: [
                      { label: '使用昵称', description: '填写常用昵称' },
                      { label: '暂不设置', description: '以后再补充' },
                    ],
                  },
                ],
              },
            },
          ],
          finishReason: 'tool_calls',
          usage: { input: 1, output: 1 },
          reasoningContent: null,
          thinkingBlocks: null,
        }
      }
    }
    const root = tmp('emperor-core-api-profile-onboarding-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new ProfileAskProvider()),
    })

    expect((await api.bootstrap()).profileOnboarding).toMatchObject({
      status: 'pending',
      canStart: true,
    })
    const started = await api.onboarding.startProfileInterview()
    expect(started).toMatchObject({
      started: true,
      state: { status: 'in_progress', interactionId: expect.any(String) },
    })

    await api.control.cancelInteraction(started.state.interactionId!)
    expect(api.onboarding.getProfileStatus()).toMatchObject({
      status: 'pending',
      interactionId: null,
    })

    const skipped = await api.onboarding.skipProfileInterview()
    expect(skipped.state).toMatchObject({
      status: 'skipped',
      canStart: true,
      canSkip: false,
    })

    await api.close()
  })

  it('lets the Agent conduct multiple template-driven Ask rounds before saving the profile', async () => {
    const root = tmp('emperor-core-api-profile-dynamic-')
    const provider = new DynamicOnboardingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    api.control.setMode('auto')

    const started = await api.onboarding.startProfileInterview()
    const sessionId = started.state.sessionId!
    const firstInteractionId = started.state.interactionId!

    expect(provider.calls).toHaveLength(1)
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain(
      '[PROFILE_ONBOARDING]',
    )
    expect(api.control.get().pending).toMatchObject({
      id: firstInteractionId,
      questions: [expect.objectContaining({ id: 'preferred_address' })],
      meta: { profileOnboardingVersion: 2 },
    })

    await expect(
      api.control.answerInteraction(firstInteractionId, {
        preferred_address: { choice: '自定义称呼', freeform: '皇上' },
      }),
    ).rejects.toThrow('turn paused for ask')

    const second = api.onboarding.getProfileStatus()
    expect(second).toMatchObject({
      status: 'in_progress',
      interactionId: expect.any(String),
    })
    expect(second.interactionId).not.toBe(firstInteractionId)
    expect(provider.calls).toHaveLength(2)
    expect(api.control.get().pending).toMatchObject({
      id: second.interactionId,
      questions: [expect.objectContaining({ id: 'working_style' })],
      meta: { profileOnboardingVersion: 2 },
    })

    const result = await api.control.answerInteraction(second.interactionId!, {
      working_style: { choice: '主动推进', freeform: '高风险操作先确认' },
    })

    expect(result).toMatchObject({
      resume: true,
      result: { content: expect.stringContaining('个人档案已经完善') },
    })
    expect(provider.calls).toHaveLength(4)
    expect(api.onboarding.getProfileStatus()).toMatchObject({
      status: 'completed',
      interactionId: null,
      canStart: false,
    })
    const profile = readFileSync(
      join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
      'utf8',
    )
    expect(profile).toContain('- **称呼**：皇上')
    expect(profile).toContain('## 偏好设置\n\n- **沟通风格**：简洁直接')
    expect(profile).toContain('## 角色互动偏好\n\n- 主动推进；高风险操作先确认')

    const events = (
      api.runtime.replay({
        sessionId,
        afterSeq: 0,
        compact: false,
      }) as any
    ).events
    expect(
      events.find(
        (event: any) =>
          event.event === 'user_message' &&
          event.source === 'onboarding' &&
          event.ui_hidden !== true,
      ),
    ).toBeUndefined()
    expect(
      events.filter((event: any) => event.event === 'ask_request'),
    ).toHaveLength(2)
    expect(
      events.find(
        (event: any) =>
          event.event === 'tool_result' &&
          event.name === 'save_user_profile' &&
          String(event.summary).startsWith('Error:'),
      ),
    ).toBeUndefined()
    expect(
      events.filter(
        (event: any) =>
          event.event === 'assistant_done' &&
          String(event.content).includes('个人档案已经完善'),
      ),
    ).toHaveLength(1)
    const onboardingState = readFileSync(
      join(root, '.emperor', 'onboarding.json'),
      'utf8',
    )
    expect(onboardingState).not.toContain('皇上')
    expect(onboardingState).not.toContain('高风险操作')

    await api.close()
  })

  it('applies mutation guard at CoreApi write boundaries', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      stateRoot: tmp('emperor-core-api-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    api.control.setMode('plan')

    expect(() => api.scheduler.createJob({})).toThrow(CoreMutationGuardError)
    expect(() => api.team.wakeMember('alice')).toThrow(CoreMutationGuardError)
    expect(() =>
      api.skills.create({
        name: 'blocked-create',
        description: 'Must not write while Plan mode is active.',
      }),
    ).toThrow(CoreMutationGuardError)
    expect(() => api.skills.package({ name: 'missing' })).toThrow(
      CoreMutationGuardError,
    )
    expect(() => api.skills.save('blocked-save', '# Blocked')).toThrow(
      CoreMutationGuardError,
    )
    expect(() => api.skills.delete('blocked-delete')).toThrow(
      CoreMutationGuardError,
    )
    expect(() =>
      api.skills.confirmInstall({
        previewId: `preview_${'a'.repeat(24)}`,
        digest: 'b'.repeat(64),
        permissionConfirmed: true,
      }),
    ).toThrow(CoreMutationGuardError)
    expect(() =>
      api.environment.install({
        planId: 'plan_1',
        acceptedLicenseIds: [],
        confirmedStepIds: [],
      }),
    ).toThrow(CoreMutationGuardError)

    await api.close()
  })

  it('returns structured scheduler payloads for desktop mutations', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-scheduler-'),
      stateRoot: tmp('emperor-core-api-scheduler-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const created = await api.scheduler.createJob({
      name: 'Typed scheduler job',
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: {
        kind: 'agent_turn',
        message: 'run a typed task',
        deliver: true,
      },
      deleteAfterRun: false,
    })

    expect(created).toMatchObject({
      job: { name: 'Typed scheduler job' },
      scheduler: { jobs: expect.any(Array), status: expect.any(Object) },
    })

    const jobId = String((created.job as Record<string, unknown>).id)
    const paused = await api.scheduler.pauseJob(jobId)
    expect(paused).toMatchObject({
      job: { id: jobId, enabled: false },
      scheduler: { jobs: expect.any(Array) },
    })

    const removed = await api.scheduler.deleteJob(jobId)
    expect(removed).toMatchObject({
      deleted: jobId,
      scheduler: { jobs: expect.any(Array) },
    })

    await api.close()
  })

  it('preserves scheduler payload restrictions at the CoreApi boundary', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-scheduler-policy-'),
      stateRoot: tmp('emperor-core-api-scheduler-policy-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const schedule = { kind: 'every', everyMs: 60_000 }

    expect(() =>
      api.scheduler.createJob({
        name: 'Reserved event',
        schedule,
        payload: { kind: 'system_event', message: 'internal only' },
      }),
    ).toThrow(/system_event.*internal/i)
    expect(() =>
      api.scheduler.createJob({
        name: 'Incomplete team wake',
        schedule,
        payload: { kind: 'team_wake', message: 'wake up' },
      }),
    ).toThrow(/target.*team_wake/i)

    await api.close()
  })

  it('applies mutation guard to mcp/model config saves (audit P0-5)', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-mutation-guard-'),
      stateRoot: tmp('emperor-core-api-mutation-guard-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    api.control.setMode('plan')

    // mcp.saveConfig 能触发 StdioClientTransport spawn 子进程 —— 审计 P0-5 点名的高危 pivot，
    // 必须和 scheduler/team 一样受 mutation guard 约束，不能在 renderer 发一条 IPC 就无条件执行。
    await expect(api.mcp.saveConfig({ servers: {} })).rejects.toThrow(
      CoreMutationGuardError,
    )
    await expect(api.model.saveEntry({})).rejects.toThrow(
      CoreMutationGuardError,
    )
    await expect(api.model.deleteEntry({ entryId: 'entry-1' })).rejects.toThrow(
      CoreMutationGuardError,
    )
    expect(() => api.config.save('x')).toThrow(CoreMutationGuardError)

    await api.close()
  })

  it('normalizes missing and legacy sidebar state before returning it', async () => {
    const root = tmp('emperor-core-api-sidebar-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(api.sidebar.get()).toEqual({
      section_order: ['projects', 'chats'],
      project_sort: 'updated_at',
      chat_sort: 'updated_at',
      project_order: [],
      chat_order: [],
      project_session_order: {},
      collapsed_project_ids: [],
    })

    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(
      join(root, 'memory', 'sidebar_state.json'),
      JSON.stringify({
        project_sort: 'manual',
        section_order: ['chats'],
        collapsed_project_ids: 'legacy-bad-value',
        project_session_order: { p1: ['s1', 2] },
      }),
      'utf8',
    )

    expect(api.sidebar.get()).toEqual({
      section_order: ['chats', 'projects'],
      project_sort: 'manual',
      chat_sort: 'updated_at',
      project_order: [],
      chat_order: [],
      project_session_order: { p1: ['s1', '2'] },
      collapsed_project_ids: [],
    })

    await api.close()
  })

  it('returns diagnostics summaries without mutating missing or corrupt config files', async () => {
    const root = tmp('emperor-core-api-')
    const stateRoot = join(root, '.emperor')
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(
      join(stateRoot, 'emperor.local.json'),
      '{not valid json',
      'utf8',
    )
    writeFileSync(
      join(stateRoot, 'emperor.local.json.corrupt-1'),
      '{old broken json',
      'utf8',
    )
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const diagnostics = await api.diagnostics.get()

    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(false)
    expect(diagnostics.modelConfig).toMatchObject({
      path: join(stateRoot, 'model_config.json'),
      exists: false,
      status: 'missing',
      error: '',
    })
    expect(diagnostics.localConfig).toMatchObject({
      path: join(stateRoot, 'emperor.local.json'),
      exists: true,
      status: 'corrupt',
    })
    expect((diagnostics.localConfig as any).corruptBackups).toEqual([
      expect.objectContaining({
        path: join(stateRoot, 'emperor.local.json.corrupt-1'),
      }),
    ])
    expect(diagnostics).toHaveProperty('dependencies.desktopRenderer')
    expect(diagnostics).toHaveProperty('dependencies.desktopPetModules')

    await api.close()
  })

  it('reports legacy private data found inside a bound project source tree, without touching it (diagnostics-only)', async () => {
    const root = tmp('emperor-core-api-project-legacy-')
    const projectDir = tmp('emperor-core-api-project-legacy-src-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const clean = await api.diagnostics.get()
    expect(clean.projectLegacyPrivateData).toBeNull()

    const build = api.sessions.create({
      title: 'Build',
      mode: 'build',
      project_path: projectDir,
    })
    api.sessions.activate(String(build.id))
    const stillClean = await api.diagnostics.get()
    expect(stillClean.projectLegacyPrivateData).toBeNull()

    mkdirSync(join(projectDir, '.emperor', 'sessions'), { recursive: true })
    writeFileSync(
      join(projectDir, '.emperor', 'sessions', 'index.json'),
      '[]',
      'utf8',
    )

    const withLegacy = await api.diagnostics.get()
    expect(withLegacy.projectLegacyPrivateData).toMatchObject({
      projectPath: resolve(projectDir),
      sessions: true,
      memory: false,
    })
    // Diagnostics-only: detecting it must never delete or move it.
    expect(
      existsSync(join(projectDir, '.emperor', 'sessions', 'index.json')),
    ).toBe(true)

    await api.close()
  })

  it('answers pending ask interactions and resumes through mainline chat', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      stateRoot: tmp('emperor-core-api-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const events: Array<Record<string, unknown>> = []
    const interaction = api.loop.controlManager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '本次范围怎么定',
          options: [
            { label: '完整', description: 'full' },
            { label: '最小', description: 'small' },
          ],
        },
      ],
      context: 'need scope',
    })

    const result = await api.control.answerInteraction(
      interaction.id,
      { scope: { choice: '完整', freeform: '' } },
      {
        clientMessageId: 'control-msg-1',
        uiHidden: true,
        emit: async (event: Record<string, unknown>) => {
          events.push(event)
        },
      },
    )

    expect(result).toMatchObject({ resume: true, result: { content: 'pong' } })
    expect(events.map((event) => event.event)).toContain('ask_answered')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(
      events.find((event) => event.event === 'user_message'),
    ).toMatchObject({
      source: 'control',
      ui_hidden: true,
      client_message_id: 'control-msg-1',
    })
    expect(
      JSON.stringify(api.loop.activeMemoryStore.loadUnarchivedHistory()),
    ).toContain('[CONTROL:ASK_ANSWERED]')

    await api.close()
  })

  it('resumes answered control interactions in their owning session after the user switches away', async () => {
    const root = tmp('emperor-core-api-control-owner-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const interaction = api.loop.controlManager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '范围怎么定',
          options: [
            { label: '完整', description: 'full' },
            { label: '最小', description: 'small' },
          ],
        },
      ],
      context: 'need scope',
    })
    api.sessions.activate(String(other.id))

    await api.control.answerInteraction(
      interaction.id,
      { scope: { choice: '完整', freeform: '' } },
      { clientMessageId: 'control-owner-msg', uiHidden: true },
    )

    expect(api.loop.activeSessionId).toBe(ownerSessionId)
    expect(
      api.loop.sessionStore.get(ownerSessionId)?.control_pending,
    ).toBeNull()
    expect(
      api.loop.sessionStore.get(String(other.id))?.control_pending,
    ).toBeNull()
    expect(
      readFileSync(
        join(root, '.emperor', 'sessions', ownerSessionId, 'history.jsonl'),
        'utf8',
      ),
    ).toContain('[CONTROL:ASK_ANSWERED]')
    const ownerEvents = readFileSync(
      join(
        root,
        '.emperor',
        'sessions',
        ownerSessionId,
        'runtime',
        'events.jsonl',
      ),
      'utf8',
    )
    expect(ownerEvents).toContain('"event":"ask_answered"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'history.jsonl',
    )
    expect(
      existsSync(otherHistoryPath)
        ? readFileSync(otherHistoryPath, 'utf8')
        : '',
    ).not.toContain('[CONTROL:ASK_ANSWERED]')
    const otherEventsPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'runtime',
      'events.jsonl',
    )
    expect(
      existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '',
    ).not.toContain('"event":"ask_answered"')

    await api.close()
  })

  it('records cancelled control interactions in their owning session after the user switches away', async () => {
    const root = tmp('emperor-core-api-control-cancel-owner-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const interaction = api.loop.controlManager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '范围怎么定',
          options: [
            { label: '完整', description: 'full' },
            { label: '最小', description: 'small' },
          ],
        },
      ],
      context: 'need scope',
    })
    api.sessions.activate(String(other.id))

    await api.control.cancelInteraction(interaction.id)

    expect(
      api.loop.sessionStore.get(ownerSessionId)?.control_pending,
    ).toBeNull()
    expect(
      api.loop.sessionStore.get(String(other.id))?.control_pending,
    ).toBeNull()
    const ownerEvents = readFileSync(
      join(
        root,
        '.emperor',
        'sessions',
        ownerSessionId,
        'runtime',
        'events.jsonl',
      ),
      'utf8',
    )
    expect(ownerEvents).toContain('"event":"interaction_cancelled"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherEventsPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'runtime',
      'events.jsonl',
    )
    expect(
      existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '',
    ).not.toContain('"event":"interaction_cancelled"')

    await api.close()
  })

  it('drains queued external messages into the session that received them after the user switches away', async () => {
    const root = tmp('emperor-core-api-external-owner-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const pending = api.loop.controlManager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '范围怎么定',
          options: [
            { label: '完整', description: 'full' },
            { label: '最小', description: 'small' },
          ],
        },
      ],
      context: 'busy owner session',
    })

    const queued = await api.externalBridge.ingest(
      new ExternalInbound({
        platform: 'slack',
        sender_id: 'u1',
        external_message_id: 'm-owner',
        content: 'external hello',
      }),
    )
    api.sessions.activate(String(other.id))
    await api.control.cancelInteraction(pending.id)

    const drained = await api.externalBridge.drainPending()

    expect(queued.status).toBe('queued')
    expect(drained[0]).toMatchObject({ status: 'dispatched' })
    const ownerHistory = readFileSync(
      join(root, '.emperor', 'sessions', ownerSessionId, 'history.jsonl'),
      'utf8',
    )
    expect(ownerHistory).toContain('external hello')
    const ownerEvents = readFileSync(
      join(
        root,
        '.emperor',
        'sessions',
        ownerSessionId,
        'runtime',
        'events.jsonl',
      ),
      'utf8',
    )
    expect(ownerEvents).toContain('"event":"external_queued"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'history.jsonl',
    )
    expect(
      existsSync(otherHistoryPath)
        ? readFileSync(otherHistoryPath, 'utf8')
        : '',
    ).not.toContain('external hello')
    const otherEventsPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'runtime',
      'events.jsonl',
    )
    expect(
      existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '',
    ).not.toContain('"event":"external_queued"')

    await api.close()
  })

  it('runs scheduler agent_turn jobs in the session that created them after the user switches away', async () => {
    const root = tmp('emperor-core-api-scheduler-owner-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const job = api.loop.schedulerService.addJob({
      name: 'Owner scheduled turn',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({
        kind: 'agent_turn',
        message: 'scheduled hello',
        deliver: false,
      }),
    })
    api.sessions.activate(String(other.id))

    await expect(
      api.loop.schedulerService.runJob(job.id, { force: true }),
    ).resolves.toBe(true)

    const ownerHistory = readFileSync(
      join(root, '.emperor', 'sessions', ownerSessionId, 'history.jsonl'),
      'utf8',
    )
    expect(ownerHistory).toContain('scheduled hello')
    const ownerEvents = readFileSync(
      join(
        root,
        '.emperor',
        'sessions',
        ownerSessionId,
        'runtime',
        'events.jsonl',
      ),
      'utf8',
    )
    expect(ownerEvents).toContain('"event":"scheduler_run_start"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'history.jsonl',
    )
    expect(
      existsSync(otherHistoryPath)
        ? readFileSync(otherHistoryPath, 'utf8')
        : '',
    ).not.toContain('scheduled hello')
    const otherEventsPath = join(
      root,
      '.emperor',
      'sessions',
      String(other.id),
      'runtime',
      'events.jsonl',
    )
    expect(
      existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '',
    ).not.toContain('"event":"scheduler_run_start"')

    await api.close()
  })

  it('keeps persistent Team roster isolated between build projects', async () => {
    const root = tmp('emperor-core-api-team-project-scope-')
    const projectAPath = join(root, 'project-a')
    const projectBPath = join(root, 'project-b')
    mkdirSync(projectAPath, { recursive: true })
    mkdirSync(projectBPath, { recursive: true })
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const buildA = api.sessions.create({
      title: 'Build A',
      mode: 'build',
      project_path: projectAPath,
    })
    const buildB = api.sessions.create({
      title: 'Build B',
      mode: 'build',
      project_path: projectBPath,
    })

    api.sessions.activate(String(buildA.id))
    await api.team.spawnMember({ name: 'alice', role: 'reader' })
    expect(
      (api.team.get().members as Array<Record<string, unknown>>).map(
        (member) => member.name,
      ),
    ).toContain('alice')

    api.sessions.activate(String(buildB.id))
    expect(
      (api.team.get().members as Array<Record<string, unknown>>).map(
        (member) => member.name,
      ),
    ).not.toContain('alice')

    await api.close()
  })

  it('probes a requested model entry through CoreApi model.test without a role', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      stateRoot: tmp('emperor-core-api-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const probe = vi.spyOn(api.modelService, 'test').mockResolvedValue({
      ok: true,
      kind: 'text',
      entryId: 'entry-1',
      model: 'fake-main',
      provider: 'fake',
      sample: 'pong',
    })

    await expect(
      api.model.test({ entryId: 'entry-1', kind: 'text' }),
    ).resolves.toMatchObject({
      ok: true,
      kind: 'text',
      entryId: 'entry-1',
      model: 'fake-main',
      provider: 'fake',
      sample: 'pong',
    })
    expect(probe).toHaveBeenCalledWith({ entryId: 'entry-1', kind: 'text' })

    await api.close()
  })

  it('cascades session deletion to owned tasks and plans, sparing legacy and other sessions', async () => {
    const root = tmp('emperor-core-api-cascade-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    await api.bootstrap()
    const keep = api.sessions.create({ title: 'Keep' })
    const doomed = api.sessions.create({ title: 'Doomed' })
    const keepId = String(keep.id)
    const doomedId = String(doomed.id)

    const ownedTask = api.loop.taskManager.startTask({
      kind: 'subagent',
      title: 'owned',
      source: 'test',
      sessionId: doomedId,
    })
    const keepTask = api.loop.taskManager.startTask({
      kind: 'subagent',
      title: 'kept',
      source: 'test',
      sessionId: keepId,
    })
    const legacyTask = api.loop.taskManager.startTask({
      kind: 'subagent',
      title: 'legacy',
      source: 'test',
    })
    const planStore = api.loop.controlManager.planStore
    planStore.save(
      makePlanRecord({
        id: 'plan_doomed',
        title: 'd',
        summary: 's',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        sessionId: doomedId,
      }),
    )
    planStore.save(
      makePlanRecord({
        id: 'plan_keep',
        title: 'k',
        summary: 's',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        sessionId: keepId,
      }),
    )
    api.loop.taskManager.appendSidechain(ownedTask.id, {
      role: 'user',
      content: 'owned work',
    })
    const ownedSidechainDir = join(root, '.emperor', 'tasks', ownedTask.id)
    expect(existsSync(ownedSidechainDir)).toBe(true)

    expect(api.tasks.list({ sessionId: keepId }).map((t) => t.id)).toEqual([
      keepTask.id,
    ])
    expect(api.tasks.list().length).toBe(3)

    const result = await api.sessions.delete(doomedId)

    expect(result).toMatchObject({
      deleted: true,
      removedTasks: 1,
      removedPlans: 1,
    })
    expect(api.loop.taskManager.store.get(ownedTask.id)).toBeNull()
    expect(api.loop.taskManager.store.get(keepTask.id)).not.toBeNull()
    expect(api.loop.taskManager.store.get(legacyTask.id)).not.toBeNull()
    expect(planStore.get('plan_doomed')).toBeNull()
    expect(planStore.get('plan_keep')).not.toBeNull()
    expect(existsSync(ownedSidechainDir)).toBe(false)

    await api.close()
  })

  it('serves persisted full tool outputs and fences path escapes', async () => {
    const root = tmp('emperor-core-api-toolresult-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const store = new ToolResultStore(join(root, '.emperor'))
    const record = store.persistLargeResult(
      'turn_x',
      'call_x',
      'huge_output',
      'full text content',
    )

    expect(api.tools.readResult({ ref: record.artifact_path })).toEqual({
      content: 'full text content',
    })
    expect(() => api.tools.readResult({ ref: '../outside.txt' })).toThrow()
    expect(() =>
      api.tools.readResult({ ref: 'memory/tool-results/../../memory.md' }),
    ).toThrow()
    expect(() => api.tools.readResult({ ref: '/etc/passwd' })).toThrow()

    await api.close()
  })

  it('deletes skill directories through CoreApi skills.delete', async () => {
    const root = tmp('emperor-core-api-')
    const stateRoot = join(root, '.emperor')
    mkdirSync(join(stateRoot, 'skills', 'demo'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'demo', 'SKILL.md'),
      '# Demo\n',
      'utf8',
    )
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(api.skills.delete('demo')).toEqual({ deleted: 'demo' })
    expect(existsSync(join(stateRoot, 'skills', 'demo'))).toBe(false)

    await api.close()
  })

  it('previews and confirms local Skill archives through CoreApi', async () => {
    const root = tmp('emperor-core-api-')
    const stateRoot = join(root, '.emperor')
    const api = await CoreApi.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const source = new CoreSkillService(join(root, 'source-state'))
    source.create({
      name: 'imported-skill',
      description: 'Use when testing a secure local install.',
      resources: ['references'],
    })
    const archivePath = source.package({ name: 'imported-skill' }).path

    const preview = await api.skills.previewInstall({
      source: { kind: 'local', path: archivePath },
    })
    const installed = await api.skills.confirmInstall({
      previewId: preview.previewId,
      digest: preview.digest,
      candidateId: preview.candidates[0]!.candidateId,
      permissionConfirmed: true,
    })

    expect(installed).toMatchObject({ name: 'imported-skill' })
    expect(
      readFileSync(
        join(stateRoot, 'skills', 'imported-skill', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Use when testing a secure local install.')

    await api.close()
  })

  it('manages desktop pet preference without spawning a separate process', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      stateRoot: tmp('emperor-core-api-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const enabled = await api.desktopPet.setEnabled(true)
    expect(enabled).toMatchObject({
      enabled: true,
      running: true,
      lastError: null,
      available: true,
    })
    expect((await api.desktopPet.get()).enabled).toBe(true)

    const disabled = await api.desktopPet.setEnabled(false)
    expect(disabled).toMatchObject({
      enabled: false,
      running: false,
      lastError: null,
    })

    await api.close()
  })
})

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
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

class DynamicOnboardingProvider extends FakeProvider {
  override async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return toolResponse(
        '初次见面。我会参考个人偏好模板逐步了解你，先从称呼开始。',
        'call_profile_ask_1',
        'ask_user',
        {
          questions: [
            {
              id: 'preferred_address',
              header: '称呼',
              question: '你希望我平时怎么称呼你？',
              options: [
                { label: '直接称呼“你”', description: '不记录额外称呼' },
                { label: '自定义称呼', description: '填写常用称呼' },
              ],
            },
          ],
          context: '先建立自然的称呼方式。',
        },
      )
    }
    if (this.calls.length === 2) {
      return toolResponse(
        '称呼记下了。我还想根据你的协作习惯补充一个问题。',
        'call_profile_ask_2',
        'ask_user',
        {
          questions: [
            {
              id: 'working_style',
              header: '协作方式',
              question: '你希望我默认怎样推进任务？',
              options: [
                { label: '主动推进', description: '边界清晰时直接完成' },
                { label: '关键步骤确认', description: '重要步骤先确认' },
              ],
            },
          ],
          context: '根据前一轮回答继续完善协作偏好。',
        },
      )
    }
    if (this.calls.length === 3) {
      return toolResponse(
        '信息已经足够，我现在整理并保存个人档案。',
        'call_profile_save',
        'save_user_profile',
        { content: dynamicProfileMarkdown() },
      )
    }
    return response('个人档案已经完善。之后我会按这些偏好与你协作。')
  }
}

function fakeRouter(provider: FakeProvider): {
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
  provider: FakeProvider,
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

function toolResponse(
  content: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMResponse {
  return {
    content,
    toolCalls: [{ id, name, arguments: args }],
    finishReason: 'tool_calls',
    usage: { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

function dynamicProfileMarkdown(): string {
  return [
    '## 基本信息',
    '',
    '- **称呼**：皇上',
    '- **时区**：UTC+8',
    '- **语言**：中文',
    '',
    '## 偏好设置',
    '',
    '- **沟通风格**：简洁直接',
    '- **技术深度**：自动适配',
    '',
    '## 工作背景',
    '',
    '- **主要角色**：未设置',
    '- **常用工具**：未设置',
    '',
    '## 兴趣领域',
    '',
    '- 未设置',
    '',
    '## 性格与工作风格',
    '',
    '- 主动推进',
    '',
    '## 角色互动偏好',
    '',
    '- 主动推进；高风险操作先确认',
    '',
  ].join('\n')
}
