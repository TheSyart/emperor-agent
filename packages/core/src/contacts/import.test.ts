// GRP-04: importing a Claude Code `agents/*.md` (or a prompt file) into the
// editor. Only the file the user picked is read; nothing is saved here.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_FILE_MAX_BYTES, importAgentFile, parseAgentFile } from './import'

const REGISTERED = [
  'read',
  'grep',
  'glob',
  'bash',
  'edit',
  'write',
  'web_search',
  'web_fetch',
  'todo_write',
  'skill',
  'job_output',
  'job_list',
  'job_kill',
]

const CONTEXT = {
  registered: REGISTERED,
  globalPermission: 'workspace-write',
}

function agent(
  frontmatter: string,
  body = '你是一名严格的审稿人。\n\n1. 读改动\n2. 列问题',
): string {
  return `---\n${frontmatter}\n---\n${body}\n`
}

describe('the mapping table (card test: 导入映射表)', () => {
  it('maps each Claude Code tool and lists the ones it does not know', () => {
    const result = parseAgentFile(
      agent(
        [
          'name: code-reviewer',
          'description: Reviews code for correctness',
          'tools: Read, Grep, Glob, Bash, Edit, Write, WebSearch, WebFetch, TodoWrite, Task, mcp__github__get_issue',
          'model: sonnet',
        ].join('\n'),
      ),
      'code-reviewer.md',
      CONTEXT,
    )
    expect(result.tools).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'read',
      'web_fetch',
      'web_search',
      'write',
    ])
    expect(result.unknownTools).toEqual([
      'TodoWrite',
      'Task',
      'mcp__github__get_issue',
    ])
    // Exactly the engineer preset's own tools: that preset.
    expect(result.draft.capabilities.tools).toEqual({ preset: 'engineer' })
    expect(result.draft.capabilities.permission).toBe('workspace_write')
    expect(result.modelHint).toBe('sonnet')
    expect(result.draft.capabilities.model).toBe('inherit')
    expect(result.notes.join('\n')).toMatch(
      /TodoWrite、Task、mcp__github__get_issue/,
    )
    expect(result.notes.join('\n')).toMatch(/sonnet/)
  })

  it('takes a YAML list as well as a comma list, and picks the preset they equal', () => {
    const readOnly = parseAgentFile(
      agent('name: a\ndescription: b\ntools:\n  - Read\n  - Grep\n  - Glob'),
      'a.md',
      CONTEXT,
    )
    expect(readOnly.draft.capabilities.tools).toEqual({ preset: 'read_only' })
    expect(readOnly.draft.capabilities.permission).toBe('read_only')
    const research = parseAgentFile(
      agent(
        'name: a\ndescription: b\ntools: Read, Grep, Glob, WebSearch, WebFetch',
      ),
      'a.md',
      CONTEXT,
    )
    expect(research.draft.capabilities.tools).toEqual({ preset: 'research' })
  })

  it('keeps an odd set exact: custom, allowing only those tools', () => {
    const result = parseAgentFile(
      agent('name: a\ndescription: b\ntools: Read, Bash'),
      'a.md',
      CONTEXT,
    )
    expect(result.draft.capabilities.tools).toEqual({
      preset: 'custom',
      allow: ['bash', 'read'],
    })
    expect(result.draft.capabilities.permission).toBe('workspace_write')
  })

  it('gives a file without tools the read-only preset and says so', () => {
    const result = parseAgentFile(
      agent('name: a\ndescription: b'),
      'a.md',
      CONTEXT,
    )
    expect(result.draft.capabilities.tools).toEqual({ preset: 'read_only' })
    expect(result.draft.capabilities.permission).toBe('read_only')
    expect(result.notes.join('\n')).toMatch(/只读/)
  })

  it('stays read-only when the global preset is read-only', () => {
    const result = parseAgentFile(
      agent('name: a\ndescription: b\ntools: Read, Edit'),
      'a.md',
      { ...CONTEXT, globalPermission: 'read-only' },
    )
    expect(result.draft.capabilities.permission).toBe('read_only')
    expect(result.notes.join('\n')).toMatch(/新会话的权限/)
  })
})

describe('the fields', () => {
  it('fills name, intro (one line, at most 60) and the playbook from the body', () => {
    const long = '审'.repeat(80)
    const result = parseAgentFile(
      agent(
        `name: "安全@审计\\n员"\ndescription: "${long}\\n第二行"`,
        '正文第一行\n正文第二行',
      ),
      'x.md',
      CONTEXT,
    )
    expect(result.draft.name).toBe('安全审计 员')
    expect(Array.from(result.draft.intro)).toHaveLength(60)
    expect(result.draft.intro).not.toMatch(/\n/)
    expect(result.draft.role.playbook).toBe('正文第一行\n正文第二行')
    expect(result.draft.role.mission).toBe('')
    expect(result.draft.role.boundaries).toBe('')
    expect(result.draft.role.knowledge).toEqual([])
  })

  it('names the contact after the file when the frontmatter has no name', () => {
    const result = parseAgentFile(
      agent('description: b'),
      'release-helper.md',
      CONTEXT,
    )
    expect(result.draft.name).toBe('release-helper')
  })

  it('cuts a body longer than the playbook allows and says so', () => {
    const result = parseAgentFile(
      agent('name: a', '步'.repeat(4500)),
      'a.md',
      CONTEXT,
    )
    expect(Array.from(result.draft.role.playbook)).toHaveLength(4000)
    expect(result.notes.join('\n')).toMatch(/4000/)
  })

  it('puts the whole text into the playbook when the frontmatter is broken', () => {
    const source = '---\nname: [unclosed\n---\n正文'
    const result = parseAgentFile(source, 'broken.md', CONTEXT)
    expect(result.draft.role.playbook).toBe(source)
    expect(result.draft.name).toBe('broken')
    expect(result.notes.join('\n')).toMatch(/frontmatter/)
  })

  it('takes a plain prompt file whole', () => {
    const result = parseAgentFile(
      '你是一名译者。\n\n1. 先通读',
      'translator.txt',
      CONTEXT,
    )
    expect(result.draft.role.playbook).toBe('你是一名译者。\n\n1. 先通读')
    expect(result.draft.name).toBe('translator')
    expect(result.draft.capabilities.tools).toEqual({ preset: 'read_only' })
  })
})

describe('importAgentFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emperor-agent-import-'))

  it('reads only the picked file, once', async () => {
    const path = join(dir, 'reviewer.md')
    writeFileSync(path, agent('name: reviewer\ndescription: d\ntools: Read'))
    const reads = vi.fn((file: string) => readFile(file, 'utf8'))
    const result = await importAgentFile(path, { ...CONTEXT, readText: reads })
    expect(reads).toHaveBeenCalledTimes(1)
    expect(reads).toHaveBeenCalledWith(path)
    expect(result.draft.name).toBe('reviewer')
  })

  it('refuses a file over 64 KB (card test: 导入过大拒绝)', async () => {
    const path = join(dir, 'huge.md')
    writeFileSync(path, 'x'.repeat(AGENT_FILE_MAX_BYTES + 1))
    const reads = vi.fn((file: string) => readFile(file, 'utf8'))
    await expect(
      importAgentFile(path, { ...CONTEXT, readText: reads }),
    ).rejects.toMatchObject({
      code: 'contact_import_too_large',
      message: expect.stringMatching(/64 KB/),
    })
    expect(reads).not.toHaveBeenCalled()
  })

  it('refuses a relative path, a folder and a missing file', async () => {
    await expect(importAgentFile('agents/a.md', CONTEXT)).rejects.toMatchObject(
      {
        code: 'contact_import_unreadable',
      },
    )
    const folder = join(dir, 'folder.md')
    mkdirSync(folder)
    await expect(importAgentFile(folder, CONTEXT)).rejects.toMatchObject({
      code: 'contact_import_unreadable',
    })
    await expect(
      importAgentFile(join(dir, 'missing.md'), CONTEXT),
    ).rejects.toMatchObject({ code: 'contact_import_unreadable' })
  })

  it('refuses a binary file', async () => {
    const path = join(dir, 'image.md')
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
    await expect(importAgentFile(path, CONTEXT)).rejects.toMatchObject({
      code: 'contact_import_unreadable',
    })
  })
})
