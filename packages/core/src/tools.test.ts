import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ReadFileTool, WriteFileTool, EditFileTool } from './tools/filesystem'
import { RunCommand, TodoStore, UpdateTodos } from './tools/builtin'
import { isReadonlyCommand } from './tools/resolvers'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emperor-tools-'))
})

describe('ReadFileTool', () => {
  it('reads files and paginates with line numbers', async () => {
    const p = join(dir, 'test.txt')
    writeFileSync(p, 'line1\nline2\nline3\n', 'utf8')
    const tool = new ReadFileTool(dir)
    const out = await tool.execute({ path: p })
    expect(out).toContain('1\tline1')
    expect(out).toContain('2\tline2')
  })

  it('errors on workspace escape attempts', async () => {
    const tool = new ReadFileTool(dir)
    const out = await tool.execute({ path: '../../../etc/passwd' })
    expect(out).toContain('[ERR]')
  })
})

describe('WriteFileTool + EditFileTool', () => {
  it('writes and edits files', async () => {
    const p = join(dir, 'f.txt')
    const w = new WriteFileTool(dir)
    const e = new EditFileTool(dir)

    await w.execute({ path: p, content: 'hello world' })
    expect(existsSync(p)).toBe(true)

    const out = await e.execute({ path: p, old_text: 'world', new_text: 'there' })
    expect(out).toContain('Edited')
  })

  it('edit_file reports when old_text not found', async () => {
    writeFileSync(join(dir, 'f.txt'), 'abc', 'utf8')
    const e = new EditFileTool(dir)
    expect(await e.execute({ path: join(dir, 'f.txt'), old_text: 'xyz', new_text: 'q' })).toContain('[ERR]')
  })
})

describe('RunCommand is_read_only delegates to resolvers', () => {
  it('pwd is readonly, curl is not', () => {
    const r = new RunCommand(dir)
    expect(r.isReadOnly({ command: 'pwd' })).toBe(true)
    expect(r.isReadOnly({ command: 'git status' })).toBe(true)
    expect(r.isReadOnly({ command: 'npm test' })).toBe(false)
    expect(r.isReadOnly({ command: 'curl example.com' })).toBe(false)
  })
})

describe('TodoStore + UpdateTodos', () => {
  it('rejects more than one in_progress', () => {
    const s = new TodoStore()
    const t = new UpdateTodos(s)
    expect(() => s.replace([
      { id: 1, content: 'a', status: 'in_progress' },
      { id: 2, content: 'b', status: 'in_progress' },
    ])).toThrow(/in_progress/)
  })

  it('accepts valid todos', async () => {
    const s = new TodoStore()
    const t = new UpdateTodos(s)
    const out = await t.execute({ todos: [{ id: 1, content: 'a', status: 'pending' }] })
    expect(out).toContain('Updated 1')
    expect(s.getAll()).toHaveLength(1)
  })
})
