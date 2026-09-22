import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../../../llm/client'
import { SkillLoaders } from '../../../skills/file-loader'
import { SkillLibrary } from '../../../skills/library'
import type { Agent } from '../../agent/agent'
import type { ApprovalService } from '../../approval/service'
import { HarnessHost } from '../../host/host'
import { SandboxPolicyService, type SandboxMode } from '../../sandbox/policy'
import { ScriptedAdapter, testRoute, type ScriptedReply } from '../../testing'
import type { ToolRunContext } from '../definition'
import { createSkillManageTool } from './skill-manage'

const SKILL =
  '---\nname: my-helper\ndescription: Helps with things\n---\n# Helper\n'

function setup(mode: SandboxMode, outcome = 'allowed-once') {
  const root = mkdtempSync(join(tmpdir(), 'emperor-skill-manage-'))
  const stateRoot = join(root, 'state')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(join(runtimeRoot, 'skills', 'builtin-one'), { recursive: true })
  writeFileSync(
    join(runtimeRoot, 'skills', 'builtin-one', 'SKILL.md'),
    '---\nname: builtin-one\ndescription: Built in\n---\n',
  )
  const library = new SkillLibrary({
    loaders: new SkillLoaders({ runtimeRoot, stateRoot }),
  })
  const request = vi.fn(async () => outcome)
  const approval = { request } as unknown as ApprovalService
  const tool = createSkillManageTool({
    library,
    sandbox: new SandboxPolicyService({ defaultMode: mode }),
    approval,
    projectRootOf: () => null,
  })
  const agent = {
    id: 'agent-1',
    session: { id: 'agent-1', events: [], header: { cwd: root } },
  } as unknown as Agent
  const run = async (raw: unknown) => {
    const args = tool.parse(raw)
    const context: ToolRunContext = {
      callId: 'call-1',
      name: 'skill_manage',
      arguments: args,
      agent,
      signal: new AbortController().signal,
      deferContext: () => {},
      concludeTurn: () => {},
    }
    const result = await tool.execute(args, context)
    return typeof result === 'object' && 'content' in result
      ? String(result.content)
      : String(result)
  }
  return { root, stateRoot, library, request, run }
}

describe('skill_manage tool', () => {
  it('writes without asking under danger-full-access', async () => {
    const { stateRoot, request, run } = setup('danger-full-access')
    const result = await run({
      action: 'create',
      content: SKILL,
      files: { 'scripts/run.sh': 'echo hi\n' },
    })
    expect(request).not.toHaveBeenCalled()
    expect(result).toContain('Created user Skill "my-helper"')
    expect(
      readFileSync(
        join(stateRoot, 'skills', 'my-helper', 'scripts', 'run.sh'),
        'utf8',
      ),
    ).toBe('echo hi\n')
  })

  it('asks for approval under workspace-write and fails when rejected', async () => {
    const allowed = setup('workspace-write')
    await allowed.run({ action: 'create', content: SKILL })
    expect(allowed.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'skill_manage',
        callId: 'call-1',
        reason: expect.stringMatching(/create user Skill "my-helper"/),
      }),
    )
    expect(existsSync(join(allowed.stateRoot, 'skills', 'my-helper'))).toBe(
      true,
    )

    const rejected = setup('workspace-write', 'rejected')
    await expect(
      rejected.run({ action: 'create', content: SKILL }),
    ).rejects.toThrow(/rejected this Skill change/)
    expect(existsSync(join(rejected.stateRoot, 'skills', 'my-helper'))).toBe(
      false,
    )
  })

  it('never asks for read-only actions and validates before asking', async () => {
    const { request, run } = setup('read-only')
    const listed = await run({ action: 'list' })
    expect(listed).toContain('builtin-one [builtin, read-only]')
    const validated = await run({
      action: 'validate',
      content: '---\nname: x\n---\n',
    })
    expect(validated).toContain(
      'error: Frontmatter field "description" is required',
    )
    await expect(
      run({ action: 'create', content: '# no frontmatter' }),
    ).rejects.toThrow(/SKILL.md is invalid/)
    await expect(
      run({ action: 'delete', name: 'builtin-one' }),
    ).rejects.toThrow(/read-only/)
    await expect(
      run({ action: 'create', content: SKILL, scope: 'project' }),
    ).rejects.toThrow(/Build session/)
    expect(request).not.toHaveBeenCalled()
  })

  it('updates, imports, and deletes through the library', async () => {
    const { root, stateRoot, run } = setup('danger-full-access')
    await run({ action: 'create', content: SKILL })
    await run({
      action: 'update',
      name: 'my-helper',
      content: SKILL.replace('Helps with things', 'Helps more'),
    })
    expect(
      readFileSync(join(stateRoot, 'skills', 'my-helper', 'SKILL.md'), 'utf8'),
    ).toContain('Helps more')
    const source = join(root, 'incoming', 'imported-one')
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, 'SKILL.md'),
      '---\nname: imported-one\ndescription: From a folder\n---\n',
    )
    const imported = await run({
      action: 'import',
      source: { kind: 'folder', path: join(root, 'incoming') },
    })
    expect(imported).toContain('Imported user Skill "imported-one"')
    await run({ action: 'delete', name: 'my-helper' })
    expect(existsSync(join(stateRoot, 'skills', 'my-helper'))).toBe(false)
  })
})

describe('skill_manage in the host', () => {
  const hosts: HarnessHost[] = []
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close()
  })

  it('shows the permission card under workspace-write before writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-skill-manage-host-'))
    const adapter = new ScriptedAdapter([
      {
        tools: [
          {
            id: 's1',
            name: 'skill_manage',
            args: { action: 'create', content: SKILL },
          },
        ],
      },
      { text: 'done' },
    ] as ScriptedReply[])
    const llm = new LlmClient({ adapterFor: () => adapter })
    llm.setRoutes([testRoute()], 'test-route')
    const events: Array<Record<string, unknown>> = []
    const host = await HarnessHost.create({
      root,
      stateRoot: join(root, 'home'),
      stateRootSource: 'explicit',
      emperorHomePrepared: false,
      llm,
      initializeMcp: false,
      watchSkills: false,
      eventSink: (event) => {
        events.push(event)
      },
    })
    hosts.push(host)
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const submitted = host.submit({ sessionId: entry.id, content: 'make it' })
    const start = Date.now()
    while (!events.some((event) => event.event === 'ask_request')) {
      if (Date.now() - start > 3000) throw new Error('no approval request')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const ask = events.find((event) => event.event === 'ask_request')!
      .interaction as { id: string; meta: { interaction_type: string } }
    expect(ask.meta.interaction_type).toBe('permission')
    expect(existsSync(join(root, 'home', 'skills', 'my-helper'))).toBe(false)
    host.answerInteraction(ask.id, {
      permission: { option_id: 'allow_once', choice: '允许本次', freeform: '' },
    })
    await submitted
    expect(
      existsSync(join(root, 'home', 'skills', 'my-helper', 'SKILL.md')),
    ).toBe(true)
    expect(adapter.requests[0]?.system).toContain('`skill_manage`')
  })
})
