import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { SessionEntry } from '../sessions/store'
import { CoreUnavailableError } from '../runtime/lifecycle'
import { CORE_API_ROUTE_OPERATIONS, type CoreApi } from './core-api'
import {
  CORE_OPERATION_REGISTRY,
  coreOperationKeys,
  invokeCoreOperation,
  isCoreOperationKey,
  type CoreOperationArgs,
  type CoreOperationKey,
  type CoreOperationResult,
} from './operations'

describe('Core operation registry', () => {
  it('covers every public CoreApi route exactly once', () => {
    const routeKeys = CORE_API_ROUTE_OPERATIONS.map((entry) => entry.key).sort()

    expect(coreOperationKeys()).toHaveLength(120)
    expect(coreOperationKeys()).toEqual(routeKeys)
    expect(Object.keys(CORE_OPERATION_REGISTRY).sort()).toEqual(routeKeys)
  })

  it('keeps Plan outside the public permission selector and validates Goal replacement input', () => {
    expect(
      CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
        'accept_edits',
      ]),
    ).toEqual(['accept_edits'])
    expect(() =>
      CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse(['plan']),
    ).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['goals.replace'].args.parse([
        { goalId: 'goal_1', outcome: '新的结果', sessionId: 'session_1' },
      ]),
    ).toEqual([
      { goalId: 'goal_1', outcome: '新的结果', sessionId: 'session_1' },
    ])
    expect(() =>
      CORE_OPERATION_REGISTRY['goals.replace'].args.parse([
        { goalId: 'goal_1', outcome: '   ', sessionId: 'session_1' },
      ]),
    ).toThrow()
  })

  it('uses exact Zod tuples for no-arg, optional, single, and multi-arg operations', () => {
    expect(CORE_OPERATION_REGISTRY['memory.tokens'].args.parse([])).toEqual([])
    expect(() =>
      CORE_OPERATION_REGISTRY['memory.tokens'].args.parse([{}]),
    ).toThrow()

    expect(CORE_OPERATION_REGISTRY.bootstrap.args.parse([])).toEqual([])
    expect(
      CORE_OPERATION_REGISTRY.bootstrap.args.parse([{ sessionId: 's1' }]),
    ).toEqual([{ sessionId: 's1' }])
    expect(() => CORE_OPERATION_REGISTRY.bootstrap.args.parse(['s1'])).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['onboarding.startProfileInterview'].args.parse(
        [],
      ),
    ).toEqual([])
    expect(() =>
      CORE_OPERATION_REGISTRY['onboarding.startProfileInterview'].args.parse([
        {},
      ]),
    ).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse([
        's1',
        { title: 'New title' },
      ]),
    ).toEqual(['s1', { title: 'New title' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse(['s1']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse([
        's1',
        { archived: 'yes' },
      ]),
    ).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['team.wakeMember'].args.parse([
        'alice',
        { purpose: 'recover', recovery: 'retry' },
      ]),
    ).toEqual(['alice', { purpose: 'recover', recovery: 'retry' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['team.wakeMember'].args.parse([
        'alice',
        { recovery: 'force' },
      ]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([
        { sessionId: 's1', afterSeq: 0, format: 'envelope_v2' },
      ]),
    ).toEqual([{ sessionId: 's1', afterSeq: 0, format: 'envelope_v2' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([{ format: 'raw' }]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['tasks.wait'].args.parse([
        'subagent_1',
        { timeoutMs: 250 },
      ]),
    ).toEqual(['subagent_1', { timeoutMs: 250 }])
    expect(() =>
      CORE_OPERATION_REGISTRY['tasks.wait'].args.parse([
        'subagent_1',
        { timeoutMs: -1 },
      ]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['tasks.resume'].args.parse([
        'subagent_1',
        { mode: 'background', ttlMs: 1_000 },
      ]),
    ).toEqual(['subagent_1', { mode: 'background', ttlMs: 1_000 }])
    expect(() =>
      CORE_OPERATION_REGISTRY['tasks.resume'].args.parse([
        'subagent_1',
        { mode: 'recursive' },
      ]),
    ).toThrow()
    const schedulerCreate = {
      name: 'Daily review',
      schedule: {
        kind: 'cron' as const,
        expr: '0 9 * * *',
        tz: 'Asia/Shanghai',
      },
      payload: {
        kind: 'agent_turn' as const,
        message: 'Review current work',
        deliver: true,
      },
      deleteAfterRun: false,
      misfirePolicy: 'latest' as const,
    }
    expect(
      CORE_OPERATION_REGISTRY['scheduler.createJob'].args.parse([
        schedulerCreate,
      ]),
    ).toEqual([schedulerCreate])
    expect(() =>
      CORE_OPERATION_REGISTRY['scheduler.createJob'].args.parse([
        { ...schedulerCreate, misfirePolicy: 'replay-all' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['scheduler.createJob'].args.parse([
        { ...schedulerCreate, maxConcurrentRuns: 99 },
      ]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['scheduler.updateJob'].args.parse([
        'job-1',
        { misfirePolicy: 'catch-up-one' },
      ]),
    ).toEqual(['job-1', { misfirePolicy: 'catch-up-one' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['scheduler.updateJob'].args.parse([
        'job-1',
        { misfirePolicy: 'all' },
      ]),
    ).toThrow()
    const gitRewind = {
      sessionId: 'session-one',
      checkpointId: 'fcp_0123456789abcdef01234567',
      confirmed: true as const,
      confirmedGitRisk: true as const,
      previewRevision: 'a'.repeat(64),
      dirtyStrategy: 'abort' as const,
    }
    expect(
      CORE_OPERATION_REGISTRY['fileCheckpoints.rewindGit'].args.parse([
        gitRewind,
      ]),
    ).toEqual([gitRewind])
    expect(() =>
      CORE_OPERATION_REGISTRY['fileCheckpoints.rewindGit'].args.parse([
        { ...gitRewind, confirmedGitRisk: false },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['fileCheckpoints.rewindGit'].args.parse([
        { ...gitRewind, previewRevision: 'project-controlled-ref' },
      ]),
    ).toThrow()
  })

  it('exposes only typed schema-v2 model mutations', () => {
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'model.saveEntry',
        'model.deleteEntry',
        'model.activate',
        'model.resolveProfile',
        'model.setReasoningEffort',
      ]),
    )
    expect(coreOperationKeys()).not.toContain('model.saveConfig')
    expect(coreOperationKeys()).not.toContain('model.saveOnboardingConfig')

    expect(
      CORE_OPERATION_REGISTRY['model.saveEntry'].args.parse([
        {
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2',
          apiBase: 'https://api.openai.com/v1',
          apiKey: null,
          contextWindowTokens: 128_000,
          maxTokens: 16_000,
          reasoningEffort: 'high',
          capabilityOverrides: { vision: false },
        },
      ]),
    ).toHaveLength(1)
    expect(() =>
      CORE_OPERATION_REGISTRY['model.saveEntry'].args.parse([
        { config: { arbitrary: true } },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['model.test'].args.parse([
        { entryId: 'entry-1', kind: 'text', role: 'secondary' },
      ]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['model.resolveProfile'].args.parse([
        {
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2',
          capabilityOverrides: { vision: false },
          contextWindowTokens: 128_000,
          maxTokens: 16_000,
        },
      ]),
    ).toHaveLength(1)
    expect(
      CORE_OPERATION_REGISTRY['model.test'].args.parse([
        { entryId: 'entry-1', kind: 'vision' },
      ]),
    ).toEqual([{ entryId: 'entry-1', kind: 'vision' }])
  })

  it('rejects malformed security-sensitive payloads before invoking CoreApi', () => {
    expect(() =>
      CORE_OPERATION_REGISTRY['attachments.save'].args.parse([
        { raw: 'not-bytes', name: 'a.txt', mime: 'text/plain' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['mcp.saveConfig'].args.parse(['echo pwned']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['desktopPet.setEnabled'].args.parse(['true']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['chat.submit'].args.parse([
        {
          content: 'review',
          requestedSkills: [{ name: '../outside', source: 'slash' }],
        },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.create'].args.parse([
        { name: '../outside', description: 'Unsafe' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.package'].args.parse([
        { name: 'valid', output: '/tmp/untrusted' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['environment.install'].args.parse([
        {
          planId: 'plan_1',
          acceptedLicenseIds: [],
          confirmedStepIds: [],
          command: 'curl https://evil.example',
        },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.previewInstall'].args.parse([
        { source: { kind: 'url', url: 'http://insecure.example/a.zip' } },
      ]),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['fileCheckpoints.rewind'].args.parse([
        {
          sessionId: 'session-one',
          checkpointId: 'fcp_0123456789abcdef01234567',
          confirmed: true,
        },
      ]),
    ).toHaveLength(1)
    expect(() =>
      CORE_OPERATION_REGISTRY['fileCheckpoints.rewind'].args.parse([
        {
          sessionId: 'session-one',
          checkpointId: 'fcp_0123456789abcdef01234567',
          confirmed: false,
        },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['fileCheckpoints.preview'].args.parse([
        {
          sessionId: 'session-one',
          checkpointId: 'fcp_0123456789abcdef01234567',
          workspaceRoot: '/renderer-controlled',
        },
      ]),
    ).toThrow()
  })

  it('defines exact Environment and Skill installation tuples', () => {
    expect(
      CORE_OPERATION_REGISTRY['environment.getStatus'].args.parse([]),
    ).toEqual([])
    expect(
      CORE_OPERATION_REGISTRY['environment.getStatus'].args.parse([
        { forceRefresh: true },
      ]),
    ).toEqual([{ forceRefresh: true }])
    expect(
      CORE_OPERATION_REGISTRY['environment.getInstallLog'].args.parse([
        { jobId: 'job_1', cursor: 0, limit: 50 },
      ]),
    ).toEqual([{ jobId: 'job_1', cursor: 0, limit: 50 }])
    expect(
      CORE_OPERATION_REGISTRY['skills.previewInstall'].args.parse([
        { source: { kind: 'local', path: '/tmp/skill.zip' } },
      ]),
    ).toEqual([{ source: { kind: 'local', path: '/tmp/skill.zip' } }])
    expect(
      CORE_OPERATION_REGISTRY['skills.confirmInstall'].args.parse([
        {
          previewId: `preview_${'a'.repeat(24)}`,
          digest: 'b'.repeat(64),
          candidateId: `candidate_${'c'.repeat(20)}`,
          permissionConfirmed: true,
        },
      ]),
    ).toEqual([
      {
        previewId: `preview_${'a'.repeat(24)}`,
        digest: 'b'.repeat(64),
        candidateId: `candidate_${'c'.repeat(20)}`,
        permissionConfirmed: true,
      },
    ])
  })

  it('preserves forward-compatible MCP fields while validating known fields', () => {
    const parsed = CORE_OPERATION_REGISTRY['mcp.saveConfig'].args.parse([
      {
        servers: {
          alpha: {
            transport: 'stdio',
            command: 'node',
            args: ['server.mjs'],
            vendorOption: { mode: 'safe' },
            tool_overrides: {
              search: { read_only: true, vendorPolicy: 'audit' },
            },
          },
        },
        defaults: { read_only: true, vendorDefault: 'preserve' },
        vendorRoot: { revision: 3 },
      },
    ])

    expect(parsed[0]).toMatchObject({
      servers: {
        alpha: {
          vendorOption: { mode: 'safe' },
          tool_overrides: {
            search: { read_only: true, vendorPolicy: 'audit' },
          },
        },
      },
      defaults: { vendorDefault: 'preserve' },
      vendorRoot: { revision: 3 },
    })
  })

  it('accepts a zero transcript limit supported by SidechainTranscript', () => {
    expect(
      CORE_OPERATION_REGISTRY['tasks.transcript'].args.parse([
        'task_1',
        { offset: 0, limit: 0 },
      ]),
    ).toEqual(['task_1', { offset: 0, limit: 0 }])
  })

  it('rejects task transcript ids that can escape the task directory', () => {
    for (const taskId of [
      '../escape',
      '..',
      '.',
      'nested/task',
      'nested\\task',
    ]) {
      expect(() =>
        CORE_OPERATION_REGISTRY['tasks.transcript'].args.parse([taskId]),
      ).toThrow()
    }
  })

  it('invokes the fixed adapter instead of resolving a dotted property path', async () => {
    const rename = vi.fn(() => ({ id: 's1', title: 'Renamed' }))
    const api = { sessions: { rename } } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'sessions.rename', ['s1', { title: 'Renamed' }]),
    ).resolves.toEqual({ id: 's1', title: 'Renamed' })
    expect(rename).toHaveBeenCalledWith('s1', { title: 'Renamed' })
  })

  it('rejects every operation before lifecycle readiness without invoking the domain API', async () => {
    const rename = vi.fn()
    const api = {
      loop: {
        lifecycleSupervisor: {
          assertReady: () => {
            throw new CoreUnavailableError('starting')
          },
        },
      },
      sessions: { rename },
    } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'sessions.rename', ['s1', { title: 'Blocked' }]),
    ).rejects.toMatchObject({
      code: 'core_unavailable',
      message: 'Core runtime is not ready (starting).',
    })
    expect(rename).not.toHaveBeenCalled()
  })

  it('maps schema failures to a safe operation argument error', async () => {
    const setEnabled = vi.fn()
    const api = { desktopPet: { setEnabled } } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'desktopPet.setEnabled', ['true']),
    ).rejects.toMatchObject({
      code: 'invalid_core_arguments',
      message: 'Invalid arguments for desktopPet.setEnabled',
    })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('exposes a runtime operation-key guard without accepting arbitrary strings', () => {
    expect(isCoreOperationKey('hooks.getConfig')).toBe(true)
    expect(isCoreOperationKey('chat.__proto__')).toBe(false)
    expect(isCoreOperationKey('missing.operation')).toBe(false)
  })
})

const renameArgs: CoreOperationArgs<'sessions.rename'> = [
  's1',
  { title: 'Typed' },
]
expectTypeOf(renameArgs).toMatchTypeOf<
  [string, string | { title?: string | null; archived?: boolean | null }]
>()

type RenameResult = CoreOperationResult<'sessions.rename'>
expectTypeOf<Awaited<RenameResult>>().toEqualTypeOf<SessionEntry>()

type ToolResult = CoreOperationResult<'tools.readResult'>
expectTypeOf<Awaited<ToolResult>>().toEqualTypeOf<{ content: string }>()

expectTypeOf<
  (typeof CORE_API_ROUTE_OPERATIONS)[number]['key']
>().toEqualTypeOf<CoreOperationKey>()

// @ts-expect-error operation keys are a closed union
const invalidKeyArgs: CoreOperationArgs<'missing.operation'> = []
void invalidKeyArgs

// @ts-expect-error sessions.rename requires a patch argument
const invalidRenameArgs: CoreOperationArgs<'sessions.rename'> = ['s1']
void invalidRenameArgs
