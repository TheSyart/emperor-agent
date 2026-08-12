import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Tool } from '../../tools/base'
import { ToolRegistry } from '../../tools/registry'
import type { ToolParamsSchema } from '../../tools/schema'
import { CoreSkillService } from './skill-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeTool extends Tool {
  readonly name: string
  readonly description: string
  readonly parameters: ToolParamsSchema = {
    type: 'object',
    properties: { q: { type: 'string', description: 'query' } },
    required: [],
  }
  override readOnly: boolean
  override concurrencySafe: boolean

  constructor(
    name: string,
    opts: {
      description?: string
      readOnly?: boolean
      concurrencySafe?: boolean
    } = {},
  ) {
    super()
    this.name = name
    this.description = opts.description ?? `${name} description`
    this.readOnly = opts.readOnly ?? false
    this.concurrencySafe = opts.concurrencySafe ?? false
    if (name.startsWith('mcp_')) {
      const [serverName = 'test', ...toolNameParts] = name
        .slice('mcp_'.length)
        .split('_')
      this.externalContent = true
      this.capabilityProvenance = {
        kind: 'mcp_declaration',
        serverName,
        toolName: toolNameParts.join('_') || name,
        transport: 'test',
        readOnlySource: 'tool_override',
        exclusiveSource: 'tool_override',
        generation: 1,
        clientId: 'test-client',
      }
    }
  }

  execute(): string {
    return 'ok'
  }
}

describe('CoreSkillService (MIG-IPC-007)', () => {
  it('maps installer internals to stable safe API errors', async () => {
    const service = new CoreSkillService(tmp('emperor-skill-safe-error-'))

    await expect(
      service.previewInstall({
        source: { kind: 'local', path: '/missing/private/skill.zip' },
      }),
    ).rejects.toMatchObject({
      code: 'skill_preview_failed',
      action: 'review_skill_install',
    })
  })

  it('projects tool definitions into WebUI capability payloads', () => {
    const registry = new ToolRegistry()
    registry.register(
      new FakeTool('read_file', { readOnly: true, concurrencySafe: true }),
    )
    registry.register(
      new FakeTool('mcp_docs_search', {
        description: '[MCP:docs] Search docs',
        readOnly: true,
      }),
    )
    const service = new CoreSkillService(tmp('emperor-skill-service-tools-'), {
      registry,
    })

    expect(service.tools()).toEqual([
      expect.objectContaining({
        name: 'read_file',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'query' } },
          required: [],
        },
        read_only: true,
        concurrency_safe: true,
        source: 'builtin',
        server: '',
      }),
      expect.objectContaining({
        name: 'mcp_docs_search',
        description: '[MCP:docs] Search docs',
        read_only: true,
        source: 'mcp',
        server: 'docs',
      }),
    ])
  })

  it('lists, reads, writes, and deletes skills with frontmatter metadata', () => {
    const root = tmp('emperor-skill-service-skills-')
    const stateRoot = join(root, 'state')
    const runtimeRoot = join(root, 'runtime')
    const skillDir = join(stateRoot, 'skills', 'code-audit')
    const builtinDir = join(runtimeRoot, 'skills', 'skill-creator')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(builtinDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: code-audit',
        'description: Audit code changes',
        'tags: review backend',
        'always: true',
        '---',
        '',
        '# Code Audit',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(builtinDir, 'SKILL.md'),
      '---\nname: skill-creator\ndescription: Create skills.\n---\n',
      'utf8',
    )
    let refreshes = 0
    const service = new CoreSkillService(stateRoot, {
      runtimeRoot,
      refreshRuntimeContext: () => {
        refreshes += 1
      },
    })

    expect(service.list()).toEqual([
      {
        always: true,
        command: null,
        description: 'Audit code changes',
        name: 'code-audit',
        path: 'skills/code-audit/SKILL.md',
        readOnly: false,
        requirements: { bins: [], runtimes: [], env: [] },
        source: 'user',
        status: 'active',
        tags: 'review backend',
      },
      {
        always: false,
        command: null,
        description: 'Create skills.',
        name: 'skill-creator',
        path: 'skills/skill-creator/SKILL.md',
        readOnly: true,
        requirements: { bins: [], runtimes: [], env: [] },
        source: 'builtin',
        status: 'active',
        tags: '',
      },
    ])
    expect(service.get('code-audit')).toMatchObject({
      name: 'code-audit',
      path: 'skills/code-audit/SKILL.md',
      content: expect.stringContaining('# Code Audit'),
    })

    const saved = service.save(
      'writer',
      '---\ndescription: Write docs\n---\n\n# Writer\n\n',
    )

    expect(saved).toMatchObject({
      name: 'writer',
      path: 'skills/writer/SKILL.md',
      content: expect.stringContaining('# Writer'),
    })
    expect(
      readFileSync(join(stateRoot, 'skills', 'writer', 'SKILL.md'), 'utf8'),
    ).toContain('# Writer')
    expect(refreshes).toBe(1)

    writeFileSync(
      join(stateRoot, 'skills', 'installed.v1.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        skills: {
          writer: { name: 'writer', status: 'active' },
          retained: { name: 'retained', status: 'blocked' },
        },
      })}\n`,
      'utf8',
    )

    expect(service.delete('writer')).toEqual({ deleted: 'writer' })
    expect(existsSync(join(stateRoot, 'skills', 'writer'))).toBe(false)
    expect(
      JSON.parse(
        readFileSync(join(stateRoot, 'skills', 'installed.v1.json'), 'utf8'),
      ),
    ).toEqual({
      schemaVersion: 1,
      skills: { retained: { name: 'retained', status: 'blocked' } },
    })
    expect(refreshes).toBe(2)
    expect(() => service.save('../bad', '# Bad')).toThrow(
      'Skill name must be a safe directory name',
    )
    expect(() => service.delete('skill-creator')).toThrow(/read-only/i)
  })

  it('parses Emperor slash-command metadata without trusting renderer-owned fields', () => {
    const root = tmp('emperor-skill-command-metadata-')
    const stateRoot = join(root, 'state')
    const skillDir = join(stateRoot, 'skills', 'review-code')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: review-code',
        'description: Review a selected scope',
        'metadata:',
        '  emperor:',
        '    command:',
        '      user_invocable: true',
        '      name: review-code',
        '      aliases: [audit-now]',
        '      argument_hint: "[scope]"',
        '      context: fork',
        '      agent: sili_suitang',
        '      allowed_tools: [read_file, grep]',
        '      effort: high',
        '      invocation_sources: [desktop]',
        '      sensitive_arguments: [token]',
        '      arguments:',
        '        - name: scope',
        '          type: relative_path',
        '          required: true',
        '          positional: true',
        '---',
        '',
        '# Review code',
      ].join('\n'),
      'utf8',
    )

    const service = new CoreSkillService(stateRoot)

    expect(service.get('review-code').command).toEqual({
      userInvocable: true,
      name: 'review-code',
      aliases: ['audit-now'],
      argumentHint: '[scope]',
      arguments: [
        {
          name: 'scope',
          type: 'relative_path',
          required: true,
          positional: true,
          values: [],
          description: undefined,
          variadic: false,
        },
      ],
      context: 'fork',
      agent: 'sili_suitang',
      allowedTools: ['read_file', 'grep'],
      effort: 'high',
      invocationSources: ['desktop'],
      sensitiveArguments: ['token'],
    })
  })

  it('parses Claude-compatible top-level command frontmatter', () => {
    const stateRoot = tmp('emperor-skill-service-claude-frontmatter-')
    const skillDir = join(stateRoot, 'skills', 'web-research')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: web-research',
        'description: Research public sources.',
        'user-invocable: false',
        'argument-hint: "[query]"',
        'allowed-tools: [web_fetch, run_command]',
        'context: fork',
        '---',
        '',
        '# Research',
      ].join('\n'),
      'utf8',
    )

    expect(
      new CoreSkillService(stateRoot).get('web-research').command,
    ).toMatchObject({
      userInvocable: false,
      argumentHint: '[query]',
      allowedTools: ['web_fetch', 'run_command'],
      context: 'fork',
    })
  })

  it('uses user precedence and never scans a sibling skills-catalog', () => {
    const root = tmp('emperor-skill-service-precedence-')
    const stateRoot = join(root, 'state')
    const runtimeRoot = join(root, 'runtime')
    for (const [base, body] of [
      [runtimeRoot, 'builtin'],
      [stateRoot, 'user'],
    ] as const) {
      const dir = join(base, 'skills', 'same-name')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: same-name\ndescription: ${body}\n---\n\n${body}\n`,
      )
    }
    const catalogDir = join(root, 'skills-catalog', 'catalog-only')
    mkdirSync(catalogDir, { recursive: true })
    writeFileSync(
      join(catalogDir, 'SKILL.md'),
      '---\nname: catalog-only\ndescription: Catalog only\n---\n',
    )

    const service = new CoreSkillService(stateRoot, { runtimeRoot })
    expect(service.get('same-name')).toMatchObject({
      source: 'user',
      description: 'user',
      content: expect.stringContaining('\nuser\n'),
    })
    expect(service.list().map((skill) => skill.name)).toEqual(['same-name'])
    expect(() => service.get('catalog-only')).toThrow(/not found/i)
  })

  it('refuses to save through a symbolic-link Skill directory', () => {
    const root = tmp('emperor-skill-service-symlink-')
    const stateRoot = join(root, 'state')
    const outside = join(root, 'outside')
    mkdirSync(join(stateRoot, 'skills'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'SKILL.md'), 'outside\n')
    symlinkSync(
      outside,
      join(stateRoot, 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const service = new CoreSkillService(stateRoot)
    expect(() => service.save('linked', '# Replaced')).toThrow(/symbolic link/i)
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('outside\n')
  })

  it('round-trips a deterministic Core package through preview and confirm', async () => {
    const sourceRoot = tmp('emperor-skill-service-package-source-')
    const destinationRoot = tmp('emperor-skill-service-package-destination-')
    const source = new CoreSkillService(sourceRoot)
    const destination = new CoreSkillService(destinationRoot)

    source.create({
      name: 'release-audit',
      description: 'Audit release artifacts and integrity evidence.',
      resources: ['references'],
    })
    const packaged = source.package({ name: 'release-audit' })

    const preview = await destination.previewInstall({
      source: { kind: 'local', path: packaged.path },
    })
    await expect(
      destination.confirmInstall({
        previewId: preview.previewId,
        digest: preview.digest,
        candidateId: preview.candidates[0]!.candidateId,
        permissionConfirmed: true,
      }),
    ).resolves.toMatchObject({ name: 'release-audit', status: 'active' })
    expect(destination.get('release-audit')).toMatchObject({
      name: 'release-audit',
      source: 'user',
      content: expect.stringContaining(
        'Audit release artifacts and integrity evidence.',
      ),
    })
  })

  it('treats legacy blocked markers as non-authoritative filesystem metadata', () => {
    const stateRoot = tmp('emperor-skill-service-blocked-')
    const skillDir = join(stateRoot, 'skills', 'legacy-script')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Missing frontmatter\n')
    writeFileSync(
      join(skillDir, '.emperor-skill-state.json'),
      JSON.stringify({ status: 'blocked_pending_review' }),
    )

    expect(new CoreSkillService(stateRoot).list()).toEqual([
      expect.objectContaining({
        name: 'legacy-script',
        status: 'invalid',
      }),
    ])
  })

  it('marks structurally invalid Skills as invalid even when YAML parses', () => {
    const stateRoot = tmp('emperor-skill-service-invalid-')
    const skillDir = join(stateRoot, 'skills', 'invalid-skill')
    mkdirSync(join(skillDir, 'unsupported'), { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: invalid-skill\n---\n\n# Missing description\n',
    )

    expect(new CoreSkillService(stateRoot).list()).toEqual([
      expect.objectContaining({
        name: 'invalid-skill',
        status: 'invalid',
      }),
    ])
  })
})
