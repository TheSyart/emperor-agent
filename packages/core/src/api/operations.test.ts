import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { SessionEntry } from '../sessions/store'
import type { CoreApi } from './core-api'
import {
  CORE_OPERATION_REGISTRY,
  coreOperationDescriptors,
  coreOperationKeys,
  invokeCoreOperation,
  isCoreOperationKey,
  type CoreOperationArgs,
  type CoreOperationKey,
  type CoreOperationResult,
} from './operations'

describe('Core operation registry', () => {
  it('owns every public CoreApi operation in one descriptor registry', () => {
    const descriptors = coreOperationDescriptors()
    const descriptorKeys = descriptors.map((entry) => entry.key)

    expect(coreOperationKeys()).toHaveLength(156)
    expect(coreOperationKeys()).toEqual(descriptorKeys)
    expect(Object.keys(CORE_OPERATION_REGISTRY).sort()).toEqual(descriptorKeys)
    expect(
      descriptors.every((descriptor) =>
        Boolean(
          descriptor.handlerKey === descriptor.key &&
          descriptor.audience === 'main_renderer' &&
          descriptor.classification === 'application_operation' &&
          descriptor.inputSchema ===
            CORE_OPERATION_REGISTRY[descriptor.key].args,
        ),
      ),
    ).toBe(true)
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'workspace.snapshot',
        'git.status',
        'git.diff',
        'git.branches',
        'git.compare',
        'git.stage',
        'git.unstage',
        'git.discard',
        'git.commit',
        'git.fetch',
        'git.pull',
        'git.push',
        'git.createBranch',
        'git.switchBranch',
        'files.list',
        'files.search',
        'files.read',
        'terminals.list',
        'terminals.create',
        'terminals.read',
        'terminals.write',
        'terminals.resize',
        'terminals.close',
        'references.resolve',
        'sessions.history',
        'sessions.event',
        'sessions.lineage',
        'sessions.children',
        'sessions.watch',
      ]),
    )
    for (const retired of [
      'team.get',
      'plans.list',
      'fileCheckpoints.list',
      'projectProcesses.stop',
      'goals.replace',
    ])
      expect(isCoreOperationKey(retired)).toBe(false)
  })

  it('validates the reference operation boundary', () => {
    const registry = CORE_OPERATION_REGISTRY as unknown as Record<
      string,
      { args: { parse(input: unknown): unknown } }
    >
    const input = {
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/guide.md#L4',
      label: 'Guide',
    }
    expect(registry['references.resolve']?.args.parse([input])).toEqual([input])
    expect(() =>
      registry['references.resolve']?.args.parse([
        { ...input, absolutePath: '/forged/path' },
      ]),
    ).toThrow()
  })

  it('accepts only the three permission presets and dsh goal start input', () => {
    expect(
      CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
        'workspace-write',
      ]),
    ).toEqual(['workspace-write'])
    expect(
      CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
        'read-only',
        'session-1',
      ]),
    ).toEqual(['read-only', 'session-1'])
    for (const legacy of ['plan', 'accept_edits', 'full_access'])
      expect(() =>
        CORE_OPERATION_REGISTRY['control.setPermissionMode'].args.parse([
          legacy,
        ]),
      ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['control.setMode'].args.parse(['plan']),
    ).toEqual(['plan'])
    expect(() =>
      CORE_OPERATION_REGISTRY['control.setMode'].args.parse(['auto']),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['goals.start'].args.parse([
        { objective: '完成迁移', sessionId: 'session_1', maxRounds: 8 },
      ]),
    ).toEqual([{ objective: '完成迁移', sessionId: 'session_1', maxRounds: 8 }])
    expect(() =>
      CORE_OPERATION_REGISTRY['goals.start'].args.parse([
        { outcome: '旧字段', sessionId: 'session_1' },
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
      CORE_OPERATION_REGISTRY['sessions.history'].args.parse([
        { sessionId: 'sub-1', beforeSeq: 10, maxMessages: 20 },
      ]),
    ).toEqual([{ sessionId: 'sub-1', beforeSeq: 10, maxMessages: 20 }])
    expect(
      CORE_OPERATION_REGISTRY['sessions.history'].args.parse([
        { sessionId: 's1' },
      ]),
    ).toEqual([{ sessionId: 's1' }])
    for (const invalid of [
      { sessionId: '../etc' },
      { sessionId: 's1', beforeSeq: -1 },
      { sessionId: 's1', maxMessages: 0 },
      { sessionId: 's1', extra: true },
    ])
      expect(() =>
        CORE_OPERATION_REGISTRY['sessions.history'].args.parse([invalid]),
      ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['sessions.event'].args.parse([
        { sessionId: 'sub-1', seq: 3 },
      ]),
    ).toEqual([{ sessionId: 'sub-1', seq: 3 }])
    for (const invalid of [
      { sessionId: 's1' },
      { sessionId: 's1', seq: -1 },
      { sessionId: '../x', seq: 1 },
    ])
      expect(() =>
        CORE_OPERATION_REGISTRY['sessions.event'].args.parse([invalid]),
      ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['sessions.lineage'].args.parse([
        { sessionId: 's1' },
      ]),
    ).toEqual([{ sessionId: 's1' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.children'].args.parse(['s1']),
    ).toThrow()
    expect(
      CORE_OPERATION_REGISTRY['sessions.watch'].args.parse([
        { sessionIds: ['s1', 'sub-2'] },
      ]),
    ).toEqual([{ sessionIds: ['s1', 'sub-2'] }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.watch'].args.parse([
        { sessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`) },
      ]),
    ).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([
        { sessionId: 's1', afterSeq: 0, format: 'projection' },
      ]),
    ).toEqual([{ sessionId: 's1', afterSeq: 0, format: 'projection' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['runtime.replay'].args.parse([
        { format: 'envelope_v2' },
      ]),
    ).toThrow()
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
      CORE_OPERATION_REGISTRY['skills.copyToUser'].args.parse([
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
      CORE_OPERATION_REGISTRY['skills.import'].args.parse([
        {
          source: { kind: 'url', url: 'http://insecure.example/a.zip' },
          scope: 'user',
        },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.import'].args.parse([
        { source: { kind: 'folder', path: '/tmp/x' }, scope: 'global' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['skills.validate'].args.parse([{}]),
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
    for (const source of [
      { kind: 'content', content: '---\nname: a\n---\n', name: 'a' },
      { kind: 'folder', path: '/tmp/skill' },
      { kind: 'zip', path: '/tmp/skill.zip' },
      { kind: 'url', url: 'https://github.com/o/r/tree/main/skills/x' },
    ])
      expect(
        CORE_OPERATION_REGISTRY['skills.import'].args.parse([
          { source, scope: 'project', sessionId: 's1', overwrite: true },
        ]),
      ).toEqual([
        { source, scope: 'project', sessionId: 's1', overwrite: true },
      ])
    expect(CORE_OPERATION_REGISTRY['skills.list'].args.parse([])).toEqual([])
    expect(
      CORE_OPERATION_REGISTRY['skills.list'].args.parse([{ sessionId: 's1' }]),
    ).toEqual([{ sessionId: 's1' }])
    expect(
      CORE_OPERATION_REGISTRY['skills.delete'].args.parse([
        'my-skill',
        { sessionId: 's1', scope: 'project' },
      ]),
    ).toEqual(['my-skill', { sessionId: 's1', scope: 'project' }])
    expect(
      CORE_OPERATION_REGISTRY['skills.copyToUser'].args.parse([
        { name: 'skill-creator', overwrite: true },
      ]),
    ).toEqual([{ name: 'skill-creator', overwrite: true }])
    for (const retired of [
      'skills.previewInstall',
      'skills.confirmInstall',
      'skills.package',
    ])
      expect(Object.keys(CORE_OPERATION_REGISTRY)).not.toContain(retired)
  })

  it('validates the named MCP server operations', () => {
    const registry = CORE_OPERATION_REGISTRY
    expect(
      registry['mcp.importServers'].args.parse([
        { raw: '{"mcpServers":{}}', overwrite: ['aihot'], dryRun: true },
      ]),
    ).toEqual([
      { raw: '{"mcpServers":{}}', overwrite: ['aihot'], dryRun: true },
    ])
    expect(
      registry['mcp.importServers'].args.parse([
        { raw: { mcpServers: { a: { url: 'https://a.test/mcp' } } } },
      ]),
    ).toEqual([{ raw: { mcpServers: { a: { url: 'https://a.test/mcp' } } } }])
    expect(() =>
      registry['mcp.importServers'].args.parse([{ raw: 42 }]),
    ).toThrow()
    expect(() =>
      registry['mcp.importServers'].args.parse([
        { raw: '{}', command: 'echo pwned' },
      ]),
    ).toThrow()
    expect(
      registry['mcp.setServerEnabled'].args.parse([
        { name: ' aihot ', enabled: false },
      ]),
    ).toEqual([{ name: 'aihot', enabled: false }])
    expect(() =>
      registry['mcp.setServerEnabled'].args.parse([
        { name: 'aihot', enabled: 'false' },
      ]),
    ).toThrow()
    expect(() =>
      registry['mcp.removeServer'].args.parse([{ name: '' }]),
    ).toThrow()
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
  ReturnType<typeof coreOperationDescriptors>[number]['key']
>().toEqualTypeOf<CoreOperationKey>()

// @ts-expect-error operation keys are a closed union
const invalidKeyArgs: CoreOperationArgs<'missing.operation'> = []
void invalidKeyArgs

// @ts-expect-error sessions.rename requires a patch argument
const invalidRenameArgs: CoreOperationArgs<'sessions.rename'> = ['s1']
void invalidRenameArgs
