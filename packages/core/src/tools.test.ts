import {
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ReadFileTool, WriteFileTool, EditFileTool } from './tools/filesystem'
import { RunCommand, TodoStore, UpdateTodos } from './tools/builtin'
import { Tool } from './tools/base'
import { toolParamsSchema } from './tools/schema'
import { ToolRegistry } from './tools/registry'
import { ExecutionEnvironment } from './environment/snapshot'
import { PublicHttpError, type PublicHttpRequest } from './network/public-http'
import { WebFetch, type WebFetchClient } from './tools/web-fetch'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'emperor-tools-'))
})

describe('WebFetch', () => {
  it('keeps raw and text modes while bounding the public HTTP request', async () => {
    const requests: PublicHttpRequest[] = []
    const client: WebFetchClient = {
      async get(request) {
        requests.push(request)
        return {
          url: request.url,
          status: 200,
          headers: {},
          body: Buffer.from('<main>Hello <strong>public</strong></main>'),
        }
      },
    }
    const tool = new WebFetch(client)

    await expect(tool.execute({ url: 'https://example.com', raw: true })).resolves.toBe(
      '<main>Hello <strong>public</strong></main>',
    )
    await expect(tool.execute({ url: 'https://example.com' })).resolves.toBe(
      'Hello public',
    )
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: 'https://example.com',
      protocols: ['http:', 'https:'],
      maxBytes: 1024 * 1024,
    })
  })

  it.each([
    ['blocked_url', '[ERR] blocked non-public host'],
    ['blocked_address', '[ERR] blocked non-public host'],
    ['redirect_limit', '[ERR] web_fetch redirect limit exceeded'],
    ['response_too_large', '[ERR] web_fetch response too large'],
    ['timeout', '[ERR] web_fetch timed out'],
    ['cancelled', '[ERR] web_fetch cancelled'],
  ] as const)('maps %s failures without exposing exception details', async (code, message) => {
    const client: WebFetchClient = {
      async get() {
        throw new PublicHttpError(code, new Error('private implementation detail'))
      },
    }

    await expect(new WebFetch(client).execute({ url: 'https://example.com' })).resolves.toBe(
      message,
    )
  })

  it('maps unexpected transport failures to a stable generic message', async () => {
    const client: WebFetchClient = {
      async get() {
        throw new Error('secret transport details')
      },
    }

    await expect(new WebFetch(client).execute({ url: 'https://example.com' })).resolves.toBe(
      '[ERR] web_fetch failed',
    )
  })
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

  it('blocks reads through a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'emperor-outside-'))
    const secretPath = join(outside, 'secret.txt')
    writeFileSync(secretPath, 'TOP SECRET', 'utf8')
    const linkPath = join(dir, 'link_out')
    symlinkSync(secretPath, linkPath)

    const tool = new ReadFileTool(dir)
    const out = await tool.execute({ path: 'link_out' })
    expect(out).toContain('[ERR]')
    expect(out).not.toContain('TOP SECRET')
  })

  it('blocks private state-root reads and explains the effective workspace fence', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'emperor-workspace-'))
    const stateRoot = join(workspace, '.emperor')
    const privatePath = join(stateRoot, 'memory', 'MEMORY.local.md')
    mkdirSync(join(stateRoot, 'memory'), { recursive: true })
    writeFileSync(privatePath, 'PRIVATE MEMORY', 'utf8')

    const tool = new ReadFileTool(workspace)
    const out = await tool.execute(
      { path: privatePath },
      {
        root: stateRoot,
        workspaceRoot: workspace,
        arguments: { path: privatePath },
      },
    )

    expect(out).toContain('[ERR] path denied by workspace policy')
    expect(out).toContain(`requested: ${privatePath}`)
    expect(out).toContain(`allowed_roots: ${workspace}`)
    expect(out).toContain(`denied_roots: ${stateRoot}`)
    expect(out).not.toContain('PRIVATE MEMORY')
  })
})

describe('WriteFileTool + EditFileTool', () => {
  it('writes and edits files', async () => {
    const p = join(dir, 'f.txt')
    const w = new WriteFileTool(dir)
    const e = new EditFileTool(dir)

    await w.execute({ path: p, content: 'hello world' })
    expect(existsSync(p)).toBe(true)

    const out = await e.execute({
      path: p,
      old_text: 'world',
      new_text: 'there',
    })
    expect(out).toContain('Edited')
  })

  it('edit_file reports when old_text not found', async () => {
    writeFileSync(join(dir, 'f.txt'), 'abc', 'utf8')
    const e = new EditFileTool(dir)
    expect(
      await e.execute({
        path: join(dir, 'f.txt'),
        old_text: 'xyz',
        new_text: 'q',
      }),
    ).toContain('[ERR]')
  })

  it('blocks writes through a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'emperor-outside-'))
    const targetPath = join(outside, 'target.txt')
    writeFileSync(targetPath, 'original', 'utf8')
    const linkPath = join(dir, 'link_out')
    symlinkSync(targetPath, linkPath)

    const w = new WriteFileTool(dir)
    const out = await w.execute({ path: 'link_out', content: 'pwned' })
    expect(out).toContain('[ERR]')
    expect(readFileSync(targetPath, 'utf8')).toBe('original')
  })

  it('blocks absolute writes outside the effective workspace with the requested path', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'emperor-workspace-'))
    const outside = mkdtempSync(join(tmpdir(), 'emperor-outside-'))
    const targetPath = join(outside, 'target.txt')
    const stateRoot = join(workspace, '.emperor')

    const w = new WriteFileTool(workspace)
    const out = await w.execute(
      { path: targetPath, content: 'pwned' },
      {
        root: stateRoot,
        workspaceRoot: workspace,
        arguments: { path: targetPath, content: 'pwned' },
      },
    )

    expect(out).toContain('[ERR] path is outside workspace')
    expect(out).toContain(`requested: ${targetPath}`)
    expect(out).toContain(`allowed_roots: ${workspace}`)
    expect(existsSync(targetPath)).toBe(false)
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

describe('RunCommand deny-list (audit P1-1)', () => {
  it('refuses symlink creation and other-interpreter arbitrary code execution', async () => {
    const r = new RunCommand(dir)
    for (const command of [
      'ln -s /etc/passwd link',
      'ln -sf ../../secret secret_link',
      'perl -e "system(1)"',
      'ruby -e "puts 1"',
      'node -e "console.log(1)"',
      'osascript -e "display dialog 1"',
    ]) {
      const out = await r.execute({ command })
      expect(out, command).toContain('refused by safety policy')
    }
  })

  it('refusal message requires approval without teaching script indirection', async () => {
    const r = new RunCommand(dir)
    const out = await r.execute({ command: 'python3 -c "print(1)"' })
    expect(out).toContain('refused by safety policy')
    expect(out).not.toContain('临时脚本文件')
    expect(out).toContain('明确批准')
    expect(out).toContain('不要')
  })
})

describe('RunCommand cancellation', () => {
  it('stops a running shell command when the turn abort signal fires', async () => {
    const r = new RunCommand(dir)
    const controller = new AbortController()
    const command = `"${process.execPath}" -e "setTimeout(() => console.log('should-not-finish'), 300)"`
    const pending = r.execute({ command }, {
      root: dir,
      arguments: { command },
      signal: controller.signal,
    } as never)
    setTimeout(() => controller.abort(), 10)

    const out = await pending

    expect(out).toContain('command cancelled')
    expect(out).not.toContain('should-not-finish')
  })
})

describe('RunCommand execution environment snapshot', () => {
  it('uses the turn snapshot PATH and excludes ambient secrets', async () => {
    const previous = process.env.PROCESS_ONLY_SECRET
    process.env.PROCESS_ONLY_SECRET = 'must-not-leak'
    const executionEnvironment = new ExecutionEnvironment(
      {
        revision: 'a'.repeat(64),
        catalogRevision: 'b'.repeat(64),
        projectFingerprint: 'c'.repeat(64),
        createdAt: '2026-07-11T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/snapshot/bin'],
        env: { HOME: '/snapshot/home', PATH: '/snapshot/bin' },
        toolPaths: {},
      },
      { PROCESS_ONLY_SECRET: 'captured-but-not-whitelisted' },
    )
    try {
      const command = `"${process.execPath}" -e "process.stdout.write([process.env.PATH, process.env.HOME, process.env.PROCESS_ONLY_SECRET].map((value) => value || '').join('|'))"`
      const output = await new RunCommand(dir).execute(
        { command },
        {
          root: dir,
          arguments: {},
          executionEnvironment,
        },
      )
      expect(output).toBe('/snapshot/bin|/snapshot/home|')
      expect(output).not.toContain('must-not-leak')
      expect(output).not.toContain('captured-but-not-whitelisted')
    } finally {
      if (previous === undefined) delete process.env.PROCESS_ONLY_SECRET
      else process.env.PROCESS_ONLY_SECRET = previous
    }
  })
})

// 对齐 Python tests/unit/test_todo_tool.py — update() 返回错误串而非抛错；active_form 渲染。
describe('ToolRegistry truncation persistence (Wave3.1)', () => {
  class HugeOutputTool extends Tool {
    override name = 'huge_output'
    override description = 'returns a huge string'
    override parameters = toolParamsSchema({}, [])
    override maxResultChars = 1_000
    execute(): string {
      return 'x'.repeat(5_000)
    }
  }

  it('persists the full output to the tool-result store when capping, and links it via metadata', async () => {
    const registry = new ToolRegistry(dir)
    registry.register(new HugeOutputTool())

    const result = await registry.executeResult(
      'huge_output',
      {},
      { root: dir, turnId: 'turn_big', parentCallId: 'call_big' },
    )

    expect(result.modelContent).toContain('[truncated')
    const ref = String(result.metadata.full_output_ref ?? '')
    expect(ref).toBeTruthy()
    const artifact = join(dir, ref)
    expect(existsSync(artifact)).toBe(true)
    expect(readFileSync(artifact, 'utf8')).toBe('x'.repeat(5_000))
  })

  it('does not create a ref for outputs under the cap', async () => {
    class SmallTool extends Tool {
      override name = 'small_output'
      override description = 'small'
      override parameters = toolParamsSchema({}, [])
      override maxResultChars = 1_000
      execute(): string {
        return 'tiny'
      }
    }
    const registry = new ToolRegistry(dir)
    registry.register(new SmallTool())

    const result = await registry.executeResult(
      'small_output',
      {},
      { root: dir },
    )

    expect(result.metadata.full_output_ref).toBeUndefined()
  })
})

describe('TodoStore + UpdateTodos (test_todo_tool.py)', () => {
  it('rejects more than one in_progress with an error string', () => {
    const s = new TodoStore()
    const result = s.update([
      { id: 1, content: 'A', active_form: 'Doing A', status: 'in_progress' },
      { id: 2, content: 'B', active_form: 'Doing B', status: 'in_progress' },
    ])
    expect(result).toContain('Error: 同一时间只能有一个 in_progress')
  })

  it('accepts valid todos and returns the summary', async () => {
    const s = new TodoStore()
    const t = new UpdateTodos(s)
    const out = await t.execute({
      todos: [{ id: 1, content: 'a', status: 'pending' }],
    })
    expect(out).toContain('todos updated: total=1')
    expect(s.todos).toHaveLength(1)
  })

  it('preserves active_form and renders it for in_progress', () => {
    const s = new TodoStore()
    const result = s.update([
      {
        id: 1,
        content: '运行测试',
        active_form: '正在运行测试',
        status: 'in_progress',
      },
      { id: 2, content: '整理结果', status: 'pending' },
    ])
    expect(s.todos[0]!.active_form).toBe('正在运行测试')
    expect(result).toContain('[~] 1. 正在运行测试')
    expect(result).toContain('[ ] 2. 整理结果')
  })

  it('uses content for completed even with active_form', () => {
    const s = new TodoStore()
    const result = s.update([
      {
        id: 1,
        content: '运行测试',
        active_form: '正在运行测试',
        status: 'completed',
      },
    ])
    expect(result).toContain('[x] 1. 运行测试')
    expect(result).not.toContain('正在运行测试')
  })

  it('adds a verification nudge for 3+ completed tasks without failing the update', () => {
    const s = new TodoStore()
    const result = s.update([
      { id: 1, content: '实现 API', status: 'completed' },
      { id: 2, content: '更新 UI', status: 'completed' },
      { id: 3, content: '整理状态', status: 'completed' },
    ])

    expect(result).toContain('todos updated: total=3, completed=3')
    expect(result).toContain('NOTE:')
    expect(result).toContain('verification')
    expect(s.todos).toHaveLength(3)
  })
})

describe('write_file overwrite nudge (2026-07-05 B2a)', () => {
  it('appends an edit_file hint when overwriting an existing file, not on create', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { WriteFileTool } = await import('./tools/filesystem')
    const root = mkdtempSync(join(tmpdir(), 'emperor-write-nudge-'))
    const tool = new WriteFileTool(root)

    const first = await tool.execute({
      path: join(root, 'a.html'),
      content: '<html>v1</html>',
    })
    expect(first).not.toContain('edit_file')

    const second = await tool.execute({
      path: join(root, 'a.html'),
      content: '<html>v2 全量重写</html>',
    })
    expect(second).toContain('已整体覆盖既有文件')
    expect(second).toContain('edit_file')
  })
})

describe('SaveUserProfileTool (onboarding profile persistence)', () => {
  it('describes section patch semantics instead of whole-file overwrite semantics', async () => {
    const { SaveUserProfileTool } = await import('./tools/builtin')
    const tool = new SaveUserProfileTool({ writeUser: () => undefined })

    expect(tool.description).toContain('章节')
    expect(tool.description).toContain('patch')
    expect(tool.description).not.toContain('整份改写')
    expect(tool.description).not.toContain('整体覆盖')
  })

  it('rejects non patch-capable writers instead of falling back to direct profile overwrite', async () => {
    const { SaveUserProfileTool } = await import('./tools/builtin')
    let directWriteCalled = false
    const tool = new SaveUserProfileTool({
      writeUser: () => {
        directWriteCalled = true
      },
    })

    const result = await tool.execute({
      content: '## Stable Preferences\n\n- prefers Chinese\n',
    })

    expect(result).toContain('Error:')
    expect(result).toContain('patch-capable writer')
    expect(directWriteCalled).toBe(false)
  })

  it('applies section patches through MemoryPatch so unrelated profile sections are preserved', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { MemoryStore } = await import('./memory/store')
    const { SaveUserProfileTool } = await import('./tools/builtin')
    const dir = mkdtempSync(join(tmpdir(), 'emperor-save-profile-'))
    const userFile = join(dir, 'USER.local.md')
    const memoryDir = join(dir, 'memory')
    writeFileSync(
      userFile,
      [
        '# 用户档案',
        '',
        '## 基本信息',
        '- **称呼**：未设置',
        '- **时区**：UTC+8',
        '',
        '## 工作背景',
        '- **主要角色**：未设置',
        '',
      ].join('\n'),
      'utf8',
    )
    const memory = new MemoryStore(memoryDir, userFile)
    const tool = new SaveUserProfileTool(memory)

    const result = await tool.execute({
      content: [
        '# 用户档案',
        '',
        '## 基本信息',
        '- **称呼**：李公公',
        '- **时区**：Asia/Shanghai',
        '',
      ].join('\n'),
    })

    const next = readFileSync(userFile, 'utf8')
    expect(next).toContain(
      '## 基本信息\n- **称呼**：李公公\n- **时区**：Asia/Shanghai',
    )
    expect(next).toContain('## 工作背景\n- **主要角色**：未设置')
    expect(memory.versions.list({ target: 'user' })).toHaveLength(1)
    expect(result).toContain('patch')
  })

  it('rejects destructive profile section replacement and leaves the profile untouched', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { MemoryStore } = await import('./memory/store')
    const { SaveUserProfileTool } = await import('./tools/builtin')
    const dir = mkdtempSync(join(tmpdir(), 'emperor-save-profile-reject-'))
    const userFile = join(dir, 'USER.local.md')
    const memoryDir = join(dir, 'memory')
    const original = [
      '# 用户档案',
      '',
      '## 基本信息',
      '- **称呼**：未设置',
      '- **时区**：UTC+8',
      '- **语言**：中文',
      '- **技术水平**：专家',
      '',
    ].join('\n')
    writeFileSync(userFile, original, 'utf8')
    const memory = new MemoryStore(memoryDir, userFile)
    const tool = new SaveUserProfileTool(memory)

    const result = await tool.execute({
      content: ['# 用户档案', '', '## 基本信息', '- **称呼**：李公公', ''].join(
        '\n',
      ),
    })

    expect(result).toContain('Error:')
    expect(result).toContain('destructive_profile_replacement')
    expect(readFileSync(userFile, 'utf8')).toBe(original)
    expect(memory.versions.list({ target: 'user' })).toHaveLength(0)
  })
})
