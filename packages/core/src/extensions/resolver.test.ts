import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ExtensionResolver,
  SOURCE_PRECEDENCE,
  applyAgentSessionPolicy,
  type AgentDefinition,
  type ExtensionSourceInput,
} from './resolver'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function definition(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    aliases: [],
    description: `${name} description`,
    prompt: `${name}.md`,
    model: { inherit: true, allowedProfiles: [] },
    tools: { allow: ['read_file', 'write_file'] },
    skills: { allow: ['skill-a', 'skill-b'] },
    hooks: { allow: ['SubagentStart', 'SubagentStop'] },
    mcp: { servers: ['docs', 'search'] },
    memory: { mode: 'read-write', scopes: ['session', 'project'] },
    completion: {
      maxTurns: 20,
      requiredSections: ['结论', '证据', '风险', '建议下一步'],
    },
    sandbox: {
      filesystem: 'workspace-write',
      network: 'policy',
      process: 'policy',
    },
    delegation: { planReadonlyExplorer: false },
    ...overrides,
  }
}

function source(
  kind: ExtensionSourceInput['kind'],
  agents: Array<Record<string, unknown>>,
  opts: Partial<ExtensionSourceInput> = {},
): ExtensionSourceInput {
  const root = tmp(`emperor-extension-${kind}-`)
  for (const agent of agents) {
    const prompt = String(agent.prompt ?? `${String(agent.name)}.md`)
    if (!prompt.includes('..')) {
      mkdirSync(join(root, prompt, '..'), { recursive: true })
      writeFileSync(
        join(root, prompt),
        `${String(agent.name)} prompt\n`,
        'utf8',
      )
    }
  }
  writeFileSync(
    join(root, 'agents.json'),
    JSON.stringify({ schemaVersion: 1, agents }),
    'utf8',
  )
  return {
    id: `${kind}-source`,
    kind,
    root,
    manifests: ['agents.json'],
    trusted: kind !== 'project' && kind !== 'plugin',
    signatureVerified: kind !== 'plugin',
    ...opts,
  }
}

describe('ExtensionResolver AgentDefinition sources (P1-6)', () => {
  it('applies deterministic builtin < plugin < user < project < managed precedence with loader-owned trust', () => {
    expect(SOURCE_PRECEDENCE).toEqual({
      builtin: 100,
      plugin: 200,
      user: 300,
      project: 400,
      managed: 500,
    })
    const sources = [
      source('project', [definition('project_only'), definition('shared')], {
        trusted: true,
      }),
      source('builtin', [definition('builtin_only'), definition('shared')]),
      source('managed', [definition('managed_only'), definition('shared')]),
      source('plugin', [definition('plugin_only'), definition('shared')], {
        trusted: true,
        signatureVerified: true,
      }),
      source('user', [definition('user_only'), definition('shared')]),
    ]

    const snapshot = new ExtensionResolver({ sources }).resolve()

    expect(snapshot.agents.map((item) => item.definition.name).sort()).toEqual([
      'builtin_only',
      'managed_only',
      'plugin_only',
      'project_only',
      'shared',
      'user_only',
    ])
    expect(
      snapshot.agents.find((item) => item.definition.name === 'shared')?.source,
    ).toMatchObject({ kind: 'managed', trust: 'managed', rank: 500 })
    expect(
      snapshot.agents
        .find((item) => item.definition.name === 'shared')
        ?.overriddenSources.map((item) => item.source.kind),
    ).toEqual(['project', 'user', 'plugin', 'builtin'])
    expect(
      snapshot.sources.map((item) => [item.kind, item.trust, item.rank]),
    ).toEqual([
      ['managed', 'managed', 500],
      ['project', 'project', 400],
      ['user', 'user', 300],
      ['plugin', 'verified_plugin', 200],
      ['builtin', 'system', 100],
    ])
    expect(
      snapshot.diagnostics.filter(
        (item) => item.code === 'cross_source_collision',
      ),
    ).toHaveLength(4)
  })

  it('rejects untrusted project and unsigned plugin sources without affecting valid sources', () => {
    const snapshot = new ExtensionResolver({
      sources: [
        source('project', [definition('project_agent')]),
        source('plugin', [definition('plugin_agent')], { trusted: true }),
        source('user', [definition('user_agent')]),
      ],
    }).resolve()

    expect(snapshot.agents.map((item) => item.definition.name)).toEqual([
      'user_agent',
    ])
    expect(snapshot.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'project',
          active: false,
          blockedReason: 'project_untrusted',
          trust: 'untrusted',
        }),
        expect.objectContaining({
          kind: 'plugin',
          active: false,
          blockedReason: 'plugin_signature_unverified',
          trust: 'untrusted',
        }),
      ]),
    )
  })

  it('contains traversal, symlink, canonical manifest duplicates, alias collisions, and cross-source name collisions', () => {
    const root = tmp('emperor-extension-containment-')
    const outside = tmp('emperor-extension-outside-')
    writeFileSync(join(outside, 'outside.md'), 'outside', 'utf8')
    symlinkSync(join(outside, 'outside.md'), join(root, 'linked.md'))
    writeFileSync(join(root, 'good.md'), 'good', 'utf8')
    writeFileSync(
      join(root, 'agents.json'),
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          definition('good', { aliases: ['reserved'] }),
          definition('linked', { prompt: 'linked.md' }),
          definition('escaped', { prompt: '../outside.md' }),
        ],
      }),
      'utf8',
    )
    const lower = source('builtin', [
      definition('good'),
      definition('reserved'),
    ])
    const snapshot = new ExtensionResolver({
      sources: [
        lower,
        {
          id: 'user-source',
          kind: 'user',
          root,
          manifests: ['agents.json', './agents.json', '../outside-agents.json'],
          trusted: true,
        },
      ],
    }).resolve()

    expect(snapshot.agents.map((item) => item.definition.name).sort()).toEqual([
      'good',
      'reserved',
    ])
    expect(snapshot.aliases).not.toHaveProperty('reserved')
    expect(snapshot.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'canonical_duplicate_manifest',
        'manifest_path_traversal',
        'prompt_path_traversal',
        'prompt_symlink_rejected',
        'cross_source_collision',
        'alias_collision',
      ]),
    )
  })

  it('isolates corrupt and forbidden manifest entries while preserving other valid agents', () => {
    const valid = definition('valid')
    const root = tmp('emperor-extension-invalid-')
    writeFileSync(join(root, 'valid.md'), 'valid prompt', 'utf8')
    writeFileSync(join(root, 'forbidden.md'), 'forbidden prompt', 'utf8')
    writeFileSync(
      join(root, 'agents.json'),
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          valid,
          definition('forbidden', {
            command: 'SECRET-RM-COMMAND',
            mcp: { servers: ['docs'], url: 'https://secret.invalid' },
          }),
        ],
      }),
      'utf8',
    )
    writeFileSync(join(root, 'corrupt.json'), '{bad json', 'utf8')

    const snapshot = new ExtensionResolver({
      sources: [
        {
          id: 'user-source',
          kind: 'user',
          root,
          manifests: ['agents.json', 'corrupt.json'],
          trusted: true,
        },
      ],
    }).resolve()

    expect(snapshot.agents.map((item) => item.definition.name)).toEqual([
      'valid',
    ])
    expect(snapshot.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'invalid_agent_definition',
        'invalid_manifest_json',
      ]),
    )
    expect(JSON.stringify(snapshot)).not.toContain('SECRET-RM-COMMAND')
    expect(JSON.stringify(snapshot)).not.toContain('secret.invalid')
  })

  it('allows session policy to tighten but never widen an AgentDefinition', () => {
    const base = definition('restricted') as unknown as AgentDefinition
    const tightened = applyAgentSessionPolicy(base, {
      allowedModelProfiles: ['safe-model'],
      toolNames: ['read_file', 'execute_unlisted'],
      skillNames: ['skill-a', 'skill-unlisted'],
      hookIds: ['SubagentStart', 'UnknownHook'],
      mcpServers: ['docs', 'unlisted'],
      memoryMode: 'read',
      memoryScopes: ['session', 'global'],
      maxTurns: 6,
      sandbox: {
        filesystem: 'read-only',
        network: 'deny',
        process: 'deny',
      },
    })

    expect(tightened.model.allowedProfiles).toEqual(['safe-model'])
    expect(tightened.tools.allow).toEqual(['read_file'])
    expect(tightened.skills.allow).toEqual(['skill-a'])
    expect(tightened.hooks.allow).toEqual(['SubagentStart'])
    expect(tightened.mcp.servers).toEqual(['docs'])
    expect(tightened.memory).toEqual({ mode: 'read', scopes: ['session'] })
    expect(tightened.completion.maxTurns).toBe(6)
    expect(tightened.sandbox).toEqual({
      filesystem: 'read-only',
      network: 'deny',
      process: 'deny',
    })
    expect(base.tools.allow).toEqual(['read_file', 'write_file'])

    const cannotWiden = applyAgentSessionPolicy(tightened, {
      toolNames: ['write_file'],
      memoryMode: 'read-write',
      maxTurns: 99,
      sandbox: {
        filesystem: 'workspace-write',
        network: 'policy',
        process: 'policy',
      },
    })
    expect(cannotWiden.tools.allow).toEqual([])
    expect(cannotWiden.memory.mode).toBe('read')
    expect(cannotWiden.completion.maxTurns).toBe(6)
    expect(cannotWiden.sandbox).toEqual(tightened.sandbox)
  })
})
