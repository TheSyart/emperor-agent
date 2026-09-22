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
import { CoreSkillService } from './skill-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeSkill(
  base: string,
  folder: string,
  frontmatter: string,
  body = '',
): string {
  const dir = join(base, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return dir
}

function roots(prefix: string) {
  const root = tmp(prefix)
  const stateRoot = join(root, 'state')
  const runtimeRoot = join(root, 'runtime')
  const project = join(root, 'project')
  mkdirSync(join(stateRoot, 'skills'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'skills'), { recursive: true })
  mkdirSync(project, { recursive: true })
  return { root, stateRoot, runtimeRoot, project }
}

describe('CoreSkillService (MIG-IPC-007)', () => {
  it('projects tool definitions into WebUI capability payloads', () => {
    const parameters = {
      type: 'object',
      properties: { q: { type: 'string', description: 'query' } },
      required: [],
    }
    const service = new CoreSkillService(tmp('emperor-skill-service-tools-'), {
      toolNames: () => [
        {
          name: 'read_file',
          description: 'read_file description',
          parameters,
          readOnly: true,
          concurrencySafe: true,
        },
        {
          name: 'mcp_docs_search',
          description: '[MCP:docs] Search docs',
          mcpServer: 'docs',
        },
        {
          name: 'mcp_my_server_search',
          description: '[MCP:my_server] Search',
          mcpServer: 'my_server',
        },
        { name: 'mcp_config', description: 'Manage MCP config' },
        { name: 'write_file', description: 'write' },
      ],
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
        parameters: {},
        read_only: false,
        source: 'mcp',
        server: 'docs',
      }),
      expect.objectContaining({
        name: 'mcp_my_server_search',
        source: 'mcp',
        server: 'my_server',
      }),
      expect.objectContaining({
        name: 'mcp_config',
        source: 'builtin',
        server: '',
      }),
      expect.objectContaining({
        name: 'write_file',
        read_only: false,
        exclusive: false,
        concurrency_safe: false,
        source: 'builtin',
      }),
    ])
  })

  it('lists, reads, writes, and deletes skills with frontmatter metadata', () => {
    const { stateRoot, runtimeRoot } = roots('emperor-skill-service-skills-')
    writeSkill(
      join(stateRoot, 'skills'),
      'code-audit',
      'name: code-audit\ndescription: Audit code changes\ntags: review backend\nalways: true',
      '\n# Code Audit\n',
    )
    writeSkill(
      join(runtimeRoot, 'skills'),
      'skill-creator',
      'name: skill-creator\ndescription: Create skills.',
    )
    let refreshes = 0
    const service = new CoreSkillService(stateRoot, {
      runtimeRoot,
      refreshRuntimeContext: () => {
        refreshes += 1
      },
    })

    const listed = service.list()
    expect(listed.invalid).toEqual([])
    expect(listed.skills).toEqual([
      expect.objectContaining({
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
        flat: false,
        warnings: [],
      }),
      expect.objectContaining({
        name: 'skill-creator',
        path: 'skills/skill-creator/SKILL.md',
        readOnly: true,
        source: 'builtin',
      }),
    ])
    expect(service.get('code-audit')).toMatchObject({
      name: 'code-audit',
      content: expect.stringContaining('# Code Audit'),
    })

    const saved = service.save(
      'writer',
      '---\nname: writer\ndescription: Write docs\n---\n\n# Writer\n\n',
    )
    expect(saved).toMatchObject({
      name: 'writer',
      source: 'user',
      path: 'skills/writer/SKILL.md',
      content: expect.stringContaining('# Writer'),
    })
    expect(
      readFileSync(join(stateRoot, 'skills', 'writer', 'SKILL.md'), 'utf8'),
    ).toBe('---\nname: writer\ndescription: Write docs\n---\n\n# Writer\n')
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

    expect(service.delete('writer')).toMatchObject({
      deleted: 'writer',
      scope: 'user',
    })
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
    expect(() => service.save('../bad', '# Bad')).toThrow(/Skill name/)
    expect(() =>
      service.save('writer', '---\nname: other\ndescription: x\n---\n'),
    ).toThrow(/does not match/)
  })

  it('keeps builtin and Plugin Skills read-only and copies them to the user folder', () => {
    const { stateRoot, runtimeRoot } = roots('emperor-skill-service-readonly-')
    writeSkill(
      join(runtimeRoot, 'skills'),
      'skill-creator',
      'name: skill-creator\ndescription: Create skills.',
      '\nSee [guide](references/guide.md).\n',
    )
    mkdirSync(join(runtimeRoot, 'skills', 'skill-creator', 'references'))
    writeFileSync(
      join(runtimeRoot, 'skills', 'skill-creator', 'references', 'guide.md'),
      '# Guide\n',
    )
    const service = new CoreSkillService(stateRoot, { runtimeRoot })

    expect(() =>
      service.save(
        'skill-creator',
        '---\nname: skill-creator\ndescription: Changed\n---\n',
      ),
    ).toThrow(expect.objectContaining({ code: 'skill_read_only' }))
    expect(() => service.delete('skill-creator')).toThrow(
      expect.objectContaining({ code: 'skill_read_only' }),
    )
    expect(existsSync(join(stateRoot, 'skills', 'skill-creator'))).toBe(false)

    const copy = service.copyToUser({ name: 'skill-creator' })
    expect(copy).toMatchObject({
      name: 'skill-creator',
      source: 'user',
      readOnly: false,
    })
    expect(
      readFileSync(
        join(stateRoot, 'skills', 'skill-creator', 'references', 'guide.md'),
        'utf8',
      ),
    ).toBe('# Guide\n')
    expect(service.get('skill-creator').source).toBe('user')
    expect(() => service.copyToUser({ name: 'skill-creator' })).toThrow(
      expect.objectContaining({ code: 'skill_exists' }),
    )
    const edited = service.save(
      'skill-creator',
      '---\nname: skill-creator\ndescription: Mine now\n---\n',
    )
    expect(edited).toMatchObject({ source: 'user', description: 'Mine now' })
  })

  it('writes and deletes project Skills in the project folder of the session', () => {
    const { stateRoot, runtimeRoot, project } = roots(
      'emperor-skill-service-project-',
    )
    const projectSkills = join(project, '.emperor', 'skills')
    writeSkill(projectSkills, 'deploy', 'name: deploy\ndescription: Deploy it')
    const service = new CoreSkillService(stateRoot, {
      runtimeRoot,
      projectRootFor: (sessionId) => (sessionId === 'build-1' ? project : null),
    })

    expect(service.list().skills.map((skill) => skill.name)).toEqual([])
    expect(
      service
        .list({ sessionId: 'build-1' })
        .skills.map((skill) => [skill.name, skill.source, skill.path]),
    ).toEqual([['deploy', 'project', '.emperor/skills/deploy/SKILL.md']])

    service.save(
      'deploy',
      '---\nname: deploy\ndescription: Deploy it safely\n---\n',
      { sessionId: 'build-1' },
    )
    expect(
      readFileSync(join(projectSkills, 'deploy', 'SKILL.md'), 'utf8'),
    ).toContain('Deploy it safely')
    expect(existsSync(join(stateRoot, 'skills', 'deploy'))).toBe(false)
    expect(service.delete('deploy', { sessionId: 'build-1' })).toMatchObject({
      scope: 'project',
    })
    expect(existsSync(join(projectSkills, 'deploy'))).toBe(false)
    expect(() =>
      service.folderPath({ scope: 'project', sessionId: 'chat-1' }),
    ).toThrow(expect.objectContaining({ code: 'skill_scope_unavailable' }))
    expect(service.folderPath({ scope: 'project', sessionId: 'build-1' })).toBe(
      projectSkills,
    )
    expect(service.folderPath({ scope: 'user' })).toBe(
      join(stateRoot, 'skills'),
    )
  })

  it('never creates the project Skills folder just to report its path', () => {
    const { stateRoot, runtimeRoot, project } = roots(
      'emperor-skill-service-folder-',
    )
    const service = new CoreSkillService(stateRoot, {
      runtimeRoot,
      projectRootFor: (sessionId) => (sessionId === 'build-1' ? project : null),
    })

    expect(() =>
      service.folderPath({ scope: 'project', sessionId: 'build-1' }),
    ).toThrow(expect.objectContaining({ code: 'skill_scope_unavailable' }))
    expect(existsSync(join(project, '.emperor'))).toBe(false)
    // Emperor Home is ours, so the user folder is still created on demand.
    expect(service.folderPath({ scope: 'user' })).toBe(
      join(stateRoot, 'skills'),
    )
    expect(existsSync(join(stateRoot, 'skills'))).toBe(true)
  })

  it('reports invalid Skills with reasons instead of dropping them', () => {
    const { stateRoot } = roots('emperor-skill-service-invalid-')
    const skills = join(stateRoot, 'skills')
    writeSkill(
      skills,
      'invalid-skill',
      'name: invalid-skill',
      '\n# Missing description\n',
    )
    writeSkill(skills, 'Bad Name', 'name: Bad Name\ndescription: nope')
    mkdirSync(join(skills, 'no-skill-file'))
    writeFileSync(join(skills, 'README.md'), '# Not a Skill\n')

    const listed = new CoreSkillService(stateRoot).list()
    expect(listed.skills).toEqual([])
    expect(listed.invalid).toEqual([
      expect.objectContaining({
        name: 'Bad Name',
        source: 'user',
        reason: expect.stringMatching(/Skill name must start/),
      }),
      expect.objectContaining({
        name: 'invalid-skill',
        path: join(skills, 'invalid-skill'),
        reason: 'Frontmatter field "description" is required',
      }),
    ])
    expect(
      new CoreSkillService(stateRoot).validate({ name: 'invalid-skill' }),
    ).toMatchObject({ valid: false, source: 'user' })
    expect(
      new CoreSkillService(stateRoot).validate({
        content: '---\nname: pasted\ndescription: ok\n---\n',
      }),
    ).toMatchObject({ valid: true, name: 'pasted', source: 'virtual' })
    const service = new CoreSkillService(stateRoot)
    expect(() => service.delete('Bad Name')).toThrow(/Skill name must start/)
    expect(service.delete('Bad Name', { scope: 'user' })).toMatchObject({
      scope: 'user',
      path: join(skills, 'Bad Name'),
    })
    expect(existsSync(join(skills, 'Bad Name'))).toBe(false)
    expect(() => service.delete('../escape', { scope: 'user' })).toThrow(
      /Invalid Skill folder name/,
    )
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
    writeSkill(
      join(stateRoot, 'skills'),
      'web-research',
      [
        'name: web-research',
        'description: Research public sources.',
        'user-invocable: false',
        'argument-hint: "[query]"',
        'allowed-tools: [web_fetch, run_command]',
        'context: fork',
      ].join('\n'),
      '\n# Research',
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

  it('uses user precedence and never scans a sibling skill directory', () => {
    const { root, stateRoot, runtimeRoot } = roots(
      'emperor-skill-service-precedence-',
    )
    for (const [base, body] of [
      [runtimeRoot, 'builtin'],
      [stateRoot, 'user'],
    ] as const)
      writeSkill(
        join(base, 'skills'),
        'same-name',
        `name: same-name\ndescription: ${body}`,
        `\n${body}\n`,
      )
    writeSkill(
      join(root, 'sibling-skills'),
      'sibling-only',
      'name: sibling-only\ndescription: Sibling only',
    )

    const service = new CoreSkillService(stateRoot, { runtimeRoot })
    expect(service.get('same-name')).toMatchObject({
      source: 'user',
      description: 'user',
      content: expect.stringContaining('\nuser\n'),
    })
    expect(service.list().skills.map((skill) => skill.name)).toEqual([
      'same-name',
    ])
    expect(() => service.get('sibling-only')).toThrow(/not found/i)
  })

  it('refuses to save through a symbolic-link Skill directory', () => {
    const root = tmp('emperor-skill-service-symlink-')
    const stateRoot = join(root, 'state')
    const outside = join(root, 'outside')
    mkdirSync(join(stateRoot, 'skills'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(
      join(outside, 'SKILL.md'),
      '---\nname: linked\ndescription: outside\n---\n',
    )
    symlinkSync(
      outside,
      join(stateRoot, 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const service = new CoreSkillService(stateRoot)
    expect(service.list().invalid).toEqual([
      expect.objectContaining({
        name: 'linked',
        reason: expect.stringMatching(/symbolic link/i),
      }),
    ])
    expect(() =>
      service.save('linked', '---\nname: linked\ndescription: x\n---\n'),
    ).toThrow(/symbolic link/i)
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toContain('outside')
  })

  it('imports pasted SKILL.md content under the chosen name', async () => {
    const { stateRoot } = roots('emperor-skill-service-import-')
    const service = new CoreSkillService(stateRoot)
    const result = await service.import({
      source: {
        kind: 'content',
        content: '---\nname: draft\ndescription: Pasted skill\n---\n# Body\n',
        name: 'pasted-skill',
      },
      scope: 'user',
    })
    expect(result.errors).toEqual([])
    expect(result.imported).toEqual([
      expect.objectContaining({ name: 'pasted-skill', scope: 'user' }),
    ])
    expect(service.get('pasted-skill')).toMatchObject({
      description: 'Pasted skill',
      content: expect.stringContaining('name: pasted-skill'),
    })
  })
})
