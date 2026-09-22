// Ports the important cases of dsh tool-fs, fs-observation-policy and
// fs-sandbox specs onto the plain fs tools.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userText } from '../../../../llm/message'
import type { Session } from '../../../../session-log/session'
import { Agent } from '../../../agent/agent'
import {
  ApprovalService,
  type ApprovalOutcome,
} from '../../../approval/service'
import { SystemPromptAssembler } from '../../../prompt/assembler'
import {
  escalationHintMarker,
  sandboxDenialMarker,
  SandboxPolicyService,
  type SandboxMode,
} from '../../../sandbox/policy'
import { createTestHarness } from '../../../testing'
import { textOf, type ToolExecutionResult } from '../../definition'
import { ToolRegistry } from '../../registry'
import type { ToolServices } from '../../services'
import { streamWholeText } from './fsio'
import { buildWindow, formatReadOutput } from './read'
import {
  createFsTools,
  installFsPromptSections,
  unifiedDiff,
  type FsTools,
} from './index'

let root: string
/** Stands in for Emperor Home's write-staging root, outside the workspace. */
let staging: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-fs-tools-')))
  staging = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-fs-staging-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
})

interface Fixture {
  fs: FsTools
  registry: ToolRegistry
  approvals: string[]
  call(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<ToolExecutionResult>
}

function fakeAgent(id: string, cwd: string, mode?: SandboxMode): Agent {
  const events =
    mode === undefined
      ? []
      : [{ type: 'sandbox/mode', data: { mode }, seq: 0, time: 0 }]
  const session = { id, header: { cwd }, events } as unknown as Session
  return { session } as unknown as Agent
}

function fixture(
  options: { mode?: SandboxMode; answer?: ApprovalOutcome; cwd?: string } = {},
): Fixture {
  const approvals: string[] = []
  const approval = {
    async request(request: {
      toolName: string
      reason?: string
    }): Promise<ApprovalOutcome> {
      approvals.push(`${request.toolName}: ${request.reason ?? ''}`)
      return options.answer ?? 'rejected'
    },
  } as unknown as ApprovalService
  const services: ToolServices = {
    sandbox: new SandboxPolicyService({
      defaultMode: options.mode ?? 'workspace-write',
      workspaceRoot: root,
    }),
    sandboxBackend: {
      confine() {
        throw new Error('unused')
      },
    },
    approval,
    spillRoot: join(root, '.spill'),
    writeStagingRoot: staging,
  }
  const fs = createFsTools(services)
  const registry = new ToolRegistry()
  registry.register(fs.read)
  registry.register(fs.write)
  registry.register(fs.edit)
  const agents = new Map<string, Agent>()
  let callCounter = 0
  return {
    fs,
    registry,
    approvals,
    async call(name, args, sessionId = 's1') {
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        agent = fakeAgent(sessionId, options.cwd ?? root)
        agents.set(sessionId, agent)
      }
      return registry.execute({
        callId: `c${++callCounter}`,
        name,
        arguments: args,
        agent,
        signal: new AbortController().signal,
      })
    },
  }
}

const text = (result: ToolExecutionResult): string => textOf(result.content)
const codeOf = (result: ToolExecutionResult): string | undefined =>
  result.error?.info?.code

describe('read', () => {
  it('returns line-numbered content with an end-of-file footer and meta', async () => {
    const f = fixture()
    const path = join(root, 'a.txt')
    writeFileSync(path, 'one\ntwo\nthree\n')
    const result = await f.call('read', { file_path: path })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      `<path>${path}</path>\n<type>file</type>\n<content>\n1: one\n2: two\n3: three\n\n(End of file - total 3 lines)\n</content>`,
    )
    expect(result.meta).toEqual({
      path,
      startLine: 1,
      endLine: 3,
      totalLines: 3,
    })
  })

  it('paginates with offset/limit and names the continuation offset', async () => {
    const f = fixture()
    const path = join(root, 'many.txt')
    writeFileSync(
      path,
      Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'),
    )
    const result = await f.call('read', {
      file_path: path,
      offset: 4,
      limit: 3,
    })
    expect(text(result)).toContain(
      '4: line 4\n5: line 5\n6: line 6\n\n(Showing lines 4-6 of 10. Use offset=7 to continue.)',
    )
    expect(result.meta).toEqual({
      path,
      startLine: 4,
      endLine: 6,
      totalLines: 10,
    })
  })

  it('resolves a relative path against the session cwd', async () => {
    const f = fixture()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'r.txt'), 'hi')
    const result = await f.call('read', { file_path: 'sub/r.txt' })
    expect(text(result)).toContain(`<path>${join(root, 'sub', 'r.txt')}</path>`)
    expect(text(result)).toContain('1: hi')
  })

  it('caps lines at 2000 chars and the whole window at 50 KB', async () => {
    const f = fixture()
    const long = join(root, 'long.txt')
    writeFileSync(long, 'x'.repeat(2500))
    expect(text(await f.call('read', { file_path: long }))).toContain(
      `1: ${'x'.repeat(2000)}... (line truncated to 2000 chars)`,
    )

    const big = join(root, 'big.txt')
    writeFileSync(
      big,
      Array.from({ length: 1000 }, () => 'y'.repeat(100)).join('\n'),
    )
    const capped = text(await f.call('read', { file_path: big }))
    const shown = capped.match(/^\d+: /gm)?.length ?? 0
    expect(shown).toBeLessThan(1000)
    expect(capped).toContain(
      `(Output capped. Showing lines 1-${shown}. Use offset=${shown + 1} to continue.)`,
    )
  })

  it('validates offset/limit and a blank path', async () => {
    const f = fixture()
    const path = join(root, 'v.txt')
    writeFileSync(path, 'a\n')
    expect(text(await f.call('read', { file_path: path, offset: 0 }))).toBe(
      'Error: offset must be a positive integer',
    )
    expect(text(await f.call('read', { file_path: path, limit: 1.5 }))).toBe(
      'Error: limit must be a positive integer',
    )
    expect(text(await f.call('read', { file_path: path, limit: 2001 }))).toBe(
      'Error: limit must be less than or equal to 2000',
    )
    expect(text(await f.call('read', { file_path: '  ' }))).toBe(
      'Error: file_path must be a non-empty string',
    )
    const out = await f.call('read', { file_path: path, offset: 5 })
    expect(text(out)).toBe(
      `Error: offset 5 is out of range for "${path}" (1 lines)`,
    )
    expect(codeOf(out)).toBe('FS_NOT_FOUND')
  })

  it('reports missing, directory, and binary targets', async () => {
    const f = fixture()
    const missing = await f.call('read', { file_path: join(root, 'nope.txt') })
    expect(text(missing)).toBe(
      `Error: cannot read "${join(root, 'nope.txt')}": not found`,
    )
    expect(codeOf(missing)).toBe('FS_NOT_FOUND')
    expect(text(await f.call('read', { file_path: root }))).toBe(
      `Error: cannot read "${root}": not a regular file`,
    )
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
    const binary = await f.call('read', { file_path: join(root, 'bin.dat') })
    expect(text(binary)).toBe(
      `Error: cannot read "${join(root, 'bin.dat')}": binary file`,
    )
    expect(codeOf(binary)).toBe('FS_NOT_TEXT')
  })

  it('returns a short text note for images', async () => {
    const f = fixture()
    const png = join(root, 'pic.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    const result = await f.call('read', { file_path: png })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('<type>image</type>')
    expect(text(result)).toContain('image/png image, 8 bytes')
  })

  it('streams large files through the same window (binary sample + UTF-8 decoding)', async () => {
    const path = join(root, 'stream.txt')
    writeFileSync(path, 'héllo\nworld')
    const window = await buildWindow(
      streamWholeText({ displayPath: path, targetKey: path }),
      { offset: 2, limit: 5, maxLineLength: 100, maxBytes: 1000 },
      path,
    )
    expect(window).toEqual({
      lines: [{ number: 2, text: 'world' }],
      totalLines: 2,
      truncatedByBytes: false,
    })
  })

  it('renders an empty file as just the footer and strips CRLF', async () => {
    const window = await buildWindow(
      ['a\r\nb\r\n'],
      { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 },
      '/x',
    )
    expect(window.lines).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
    ])
    expect(
      formatReadOutput('/e', { offset: 1, lines: [], totalLines: 0 }),
    ).toBe(
      '<path>/e</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>',
    )
  })

  it('is concurrency safe; write and edit are exclusive', () => {
    const f = fixture()
    expect(f.registry.executionMode('read', { file_path: '/x' })).toBe(
      'parallel',
    )
    expect(
      f.registry.executionMode('write', { file_path: '/x', content: '' }),
    ).toBe('exclusive')
    expect(
      f.registry.executionMode('edit', {
        file_path: '/x',
        old_string: 'a',
        new_string: 'b',
      }),
    ).toBe('exclusive')
  })
})

describe('write', () => {
  it('creates a file (and parent dirs) with exactly the requested bytes', async () => {
    const f = fixture()
    const path = join(root, 'deep', 'dir', 'new.txt')
    const result = await f.call('write', {
      file_path: path,
      content: 'hello\nworld\n',
    })
    expect(text(result)).toBe(
      `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`,
    )
    expect(readFileSync(path, 'utf8')).toBe('hello\nworld\n')
    expect(result.meta).toMatchObject({
      path,
      kind: 'write',
      added: 2,
      removed: 0,
    })
    expect((result.meta as { diff: string }).diff).toContain('+hello')
  })

  it('never leaves a staging file in the target directory, on create or edit', async () => {
    const f = fixture()
    const path = join(root, 'staged.txt')
    await f.call('write', { file_path: path, content: 'first\n' })
    await f.call('read', { file_path: path })
    await f.call('edit', {
      file_path: path,
      old_string: 'first',
      new_string: 'second',
    })
    expect(readFileSync(path, 'utf8')).toBe('second\n')
    expect(readdirSync(root)).toEqual(['staged.txt'])
    expect(readdirSync(staging)).toEqual([])
  })

  it('rejects overwriting an existing unread file (FS_NOT_OBSERVED with remedy)', async () => {
    const f = fixture()
    const path = join(root, 'exists.txt')
    writeFileSync(path, 'original')
    const result = await f.call('write', {
      file_path: path,
      content: 'clobber',
    })
    expect(text(result)).toBe(
      `Error: cannot overwrite existing "${path}" without reading it first — read the file, then retry`,
    )
    expect(codeOf(result)).toBe('FS_NOT_OBSERVED')
    expect(readFileSync(path, 'utf8')).toBe('original')
  })

  it('overwrites after a read and reports an update diff', async () => {
    const f = fixture()
    const path = join(root, 'o.txt')
    writeFileSync(path, 'a\nb\nc\n')
    await f.call('read', { file_path: path })
    const result = await f.call('write', {
      file_path: path,
      content: 'a\nB\nc\n',
    })
    expect(text(result)).toContain('Updated file')
    expect(result.meta).toMatchObject({ kind: 'write', added: 1, removed: 1 })
    expect((result.meta as { diff: string }).diff).toContain('-b\n+B')
  })

  it('compare-and-set: rejects a stale overwrite, and a re-read unblocks it', async () => {
    const f = fixture()
    const path = join(root, 'stale.txt')
    writeFileSync(path, 'v1')
    await f.call('read', { file_path: path })
    writeFileSync(path, 'v2 changed externally')
    const stale = await f.call('write', { file_path: path, content: 'mine' })
    expect(text(stale)).toBe(
      `Error: cannot write "${path}": file changed since it was read — re-read the file, then retry`,
    )
    expect(codeOf(stale)).toBe('FS_STALE_VERSION')
    expect(readFileSync(path, 'utf8')).toBe('v2 changed externally')
    await f.call('read', { file_path: path })
    expect(
      (await f.call('write', { file_path: path, content: 'mine' })).isError,
    ).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('mine')
  })

  it('observations are per session', async () => {
    const f = fixture()
    const path = join(root, 'shared.txt')
    writeFileSync(path, 'x')
    await f.call('read', { file_path: path }, 's1')
    expect(
      codeOf(await f.call('write', { file_path: path, content: 'y' }, 's2')),
    ).toBe('FS_NOT_OBSERVED')
    expect(
      (await f.call('write', { file_path: path, content: 'y' }, 's1')).isError,
    ).toBe(false)
  })

  it('a failed read records absence so write can recreate the file', async () => {
    const f = fixture()
    const path = join(root, 'gone.txt')
    writeFileSync(path, 'x')
    await f.call('read', { file_path: path })
    rmSync(path)
    expect(
      codeOf(await f.call('write', { file_path: path, content: 'y' })),
    ).toBe('FS_STALE_VERSION')
    expect(codeOf(await f.call('read', { file_path: path }))).toBe(
      'FS_NOT_FOUND',
    )
    expect(
      (await f.call('write', { file_path: path, content: 'y' })).isError,
    ).toBe(false)
  })

  it('writes through a symlink to its target without replacing the link', async () => {
    const f = fixture()
    const real = join(root, 'real.txt')
    const alias = join(root, 'alias.txt')
    writeFileSync(real, 'r')
    symlinkSync(real, alias)
    await f.call('read', { file_path: alias })
    expect(
      (await f.call('write', { file_path: real, content: 'via real' })).isError,
    ).toBe(false)
    expect(readFileSync(alias, 'utf8')).toBe('via real')
  })
})

describe('edit', () => {
  it('requires a prior read (FS_NOT_OBSERVED), leaving the file untouched', async () => {
    const f = fixture()
    const path = join(root, 'e.txt')
    writeFileSync(path, 'alpha beta')
    const result = await f.call('edit', {
      file_path: path,
      old_string: 'alpha',
      new_string: 'ALPHA',
    })
    expect(text(result)).toBe(
      `Error: edit requires reading "${path}" first — read the file, then retry`,
    )
    expect(codeOf(result)).toBe('FS_NOT_OBSERVED')
    expect(readFileSync(path, 'utf8')).toBe('alpha beta')
  })

  it('applies a unique literal replacement after a (windowed) read', async () => {
    const f = fixture()
    const path = join(root, 'u.txt')
    writeFileSync(path, 'l1\nl2\nl3\nl4\n')
    await f.call('read', { file_path: path, offset: 3, limit: 1 })
    const result = await f.call('edit', {
      file_path: path,
      old_string: 'l2',
      new_string: 'L2',
    })
    expect(text(result)).toBe(`The file ${path} has been updated successfully.`)
    expect(readFileSync(path, 'utf8')).toBe('l1\nL2\nl3\nl4\n')
    expect(result.meta).toMatchObject({
      path,
      kind: 'edit',
      added: 1,
      removed: 1,
    })
    expect((result.meta as { diff: string }).diff).toContain('@@ -1,4 +1,4 @@')
  })

  it('rejects ambiguous and missing matches; replace_all replaces every match', async () => {
    const f = fixture()
    const path = join(root, 'amb.txt')
    writeFileSync(path, 'foo bar foo baz foo')
    await f.call('read', { file_path: path })
    const ambiguous = await f.call('edit', {
      file_path: path,
      old_string: 'foo',
      new_string: 'qux',
    })
    expect(text(ambiguous)).toBe(
      `Error: old_string matched 3 times in "${path}"; provide a more specific old_string or set replace_all to true`,
    )
    expect(codeOf(ambiguous)).toBe('FS_AMBIGUOUS_EDIT')
    const missing = await f.call('edit', {
      file_path: path,
      old_string: 'zzz',
      new_string: 'q',
    })
    expect(text(missing)).toBe(`Error: old_string was not found in "${path}"`)
    expect(codeOf(missing)).toBe('FS_EDIT_NOT_FOUND')
    const all = await f.call('edit', {
      file_path: path,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
    })
    expect(text(all)).toBe(
      `The file ${path} has been updated. All occurrences were successfully replaced.`,
    )
    expect(readFileSync(path, 'utf8')).toBe('qux bar qux baz qux')
  })

  it('validates identical/empty strings', async () => {
    const f = fixture()
    const path = join(root, 'x.txt')
    expect(
      text(
        await f.call('edit', {
          file_path: path,
          old_string: 'a',
          new_string: 'a',
        }),
      ),
    ).toBe('Error: old_string and new_string must differ')
    expect(
      text(
        await f.call('edit', {
          file_path: path,
          old_string: '',
          new_string: 'a',
        }),
      ),
    ).toBe('Error: old_string must be a non-empty string')
  })

  it('fails stale (before matching) when the file changed since the read', async () => {
    const f = fixture()
    const path = join(root, 's.txt')
    writeFileSync(path, 'one')
    await f.call('read', { file_path: path })
    writeFileSync(path, 'two, externally')
    const result = await f.call('edit', {
      file_path: path,
      old_string: 'one',
      new_string: '1',
    })
    expect(text(result)).toBe(
      `Error: cannot edit "${path}": file changed since it was read — re-read the file, then retry`,
    )
    expect(codeOf(result)).toBe('FS_STALE_VERSION')
  })

  it('supports write → edit → edit without an intervening read', async () => {
    const f = fixture()
    const path = join(root, 'cycle.txt')
    await f.call('write', { file_path: path, content: 'a b c' })
    expect(
      (
        await f.call('edit', {
          file_path: path,
          old_string: 'b',
          new_string: 'B',
        })
      ).isError,
    ).toBe(false)
    expect(
      (
        await f.call('edit', {
          file_path: path,
          old_string: 'c',
          new_string: 'C',
        })
      ).isError,
    ).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('a B C')
  })

  it('preserves CRLF line endings', async () => {
    const f = fixture()
    const path = join(root, 'crlf.txt')
    writeFileSync(path, 'a\r\nb\r\n')
    await f.call('read', { file_path: path })
    await f.call('edit', {
      file_path: path,
      old_string: 'a\nb',
      new_string: 'x\ny',
    })
    expect(readFileSync(path, 'utf8')).toBe('x\r\ny\r\n')
  })

  it('an observed-absent target reports not found', async () => {
    const f = fixture()
    const path = join(root, 'absent.txt')
    await f.call('read', { file_path: path })
    const result = await f.call('edit', {
      file_path: path,
      old_string: 'a',
      new_string: 'b',
    })
    expect(text(result)).toBe(`Error: cannot edit "${path}": not found`)
  })

  it('two concurrent edits of the same file: one wins, the other is stale', async () => {
    const f = fixture()
    const path = join(root, 'race.txt')
    writeFileSync(path, 'a b')
    await f.call('read', { file_path: path })
    const results = await Promise.all([
      f.call('edit', { file_path: path, old_string: 'a', new_string: 'A' }),
      f.call('edit', { file_path: path, old_string: 'b', new_string: 'B' }),
    ])
    expect(results.filter((r) => !r.isError)).toHaveLength(1)
    expect(results.map(codeOf).filter(Boolean)).toEqual(['FS_STALE_VERSION'])
  })
})

describe('sandbox', () => {
  const outside = '/emperor-fs-sandbox-probe-does-not-exist/file.txt'

  it('workspace-write allows the workspace and denies outside paths with the markers', async () => {
    const f = fixture({ mode: 'workspace-write' })
    expect(
      (
        await f.call('write', {
          file_path: join(root, 'in.txt'),
          content: 'ok',
        })
      ).isError,
    ).toBe(false)
    const denied = await f.call('write', { file_path: outside, content: 'no' })
    expect(text(denied)).toBe(
      `Error: ${sandboxDenialMarker('workspace-write')}\n${escalationHintMarker('write')}`,
    )
    expect(codeOf(denied)).toBe('FS_SANDBOX_DENIED')
    expect(existsSync(outside)).toBe(false)
  })

  it('a symlink inside the workspace cannot escape it', async () => {
    const workspace = join(root, 'ws')
    mkdirSync(workspace)
    symlinkSync('/', join(workspace, 'escape'))
    const f = fixture({ mode: 'workspace-write', cwd: workspace })
    // Temp areas are writable under workspace-write, so escape to a root-level path through the link.
    const denied = await f.call('write', {
      file_path: 'escape/emperor-fs-sandbox-probe-does-not-exist/x.txt',
      content: 'no',
    })
    expect(codeOf(denied)).toBe('FS_SANDBOX_DENIED')
  })

  it('read-only denies every write and edit; reads still work', async () => {
    const f = fixture({ mode: 'read-only' })
    const path = join(root, 'ro.txt')
    writeFileSync(path, 'content')
    expect((await f.call('read', { file_path: path })).isError).toBe(false)
    const write = await f.call('write', {
      file_path: join(root, 'new.txt'),
      content: 'x',
    })
    expect(text(write)).toBe(
      `Error: ${sandboxDenialMarker('read-only')}\n${escalationHintMarker('write')}`,
    )
    const edit = await f.call('edit', {
      file_path: path,
      old_string: 'content',
      new_string: 'changed',
    })
    expect(text(edit)).toBe(
      `Error: ${sandboxDenialMarker('read-only')}\n${escalationHintMarker('edit')}`,
    )
    expect(readFileSync(path, 'utf8')).toBe('content')
  })

  it('danger-full-access is unfenced', async () => {
    const f = fixture({ mode: 'danger-full-access' })
    const path = join(root, 'free.txt')
    expect(
      (await f.call('write', { file_path: path, content: 'x' })).isError,
    ).toBe(false)
  })

  it('an approved escalation runs that one call in the wider mode', async () => {
    const f = fixture({ mode: 'read-only', answer: 'allowed-once' })
    const path = join(root, 'esc.txt')
    const result = await f.call('write', {
      file_path: path,
      content: 'granted',
      sandbox_permissions: 'workspace-write',
      justification: 'Need to create the file.',
    })
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('granted')
    expect(f.approvals).toEqual([
      'write: escalate sandbox to workspace-write: Need to create the file.',
    ])
    // The grant never outlives the call.
    expect(
      codeOf(
        await f.call('write', {
          file_path: join(root, 'esc2.txt'),
          content: 'x',
        }),
      ),
    ).toBe('FS_SANDBOX_DENIED')
  })

  it('a rejected escalation fails closed and never mutates', async () => {
    const f = fixture({ mode: 'read-only', answer: 'rejected' })
    const path = join(root, 'rej.txt')
    const result = await f.call('write', {
      file_path: path,
      content: 'x',
      sandbox_permissions: 'workspace-write',
      justification: 'please',
    })
    expect(text(result)).toBe(
      'Error: the user rejected escalating this write to "workspace-write"',
    )
    expect(existsSync(path)).toBe(false)
  })

  it('validates escalation pairing and strict widening', async () => {
    const f = fixture({ mode: 'workspace-write', answer: 'allowed-once' })
    const path = join(root, 'p.txt')
    expect(
      text(
        await f.call('write', {
          file_path: path,
          content: 'x',
          sandbox_permissions: 'danger-full-access',
        }),
      ),
    ).toBe(
      'Error: invalid escalation: sandbox_permissions requires a justification',
    )
    expect(
      text(
        await f.call('write', {
          file_path: path,
          content: 'x',
          justification: 'why',
        }),
      ),
    ).toBe(
      'Error: invalid escalation: justification is only valid together with sandbox_permissions',
    )
    expect(
      text(
        await f.call('write', {
          file_path: path,
          content: 'x',
          sandbox_permissions: 'workspace-write',
          justification: 'why',
        }),
      ),
    ).toBe(
      'Error: sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode',
    )
    expect(f.approvals).toEqual([])
  })

  it('end to end: a scripted model escalates edit through the real approval service', async () => {
    const h = createTestHarness({
      replies: [
        { tools: [{ id: 'r1', name: 'read', args: { file_path: 'doc.txt' } }] },
        {
          tools: [
            {
              id: 'e1',
              name: 'edit',
              args: {
                file_path: 'doc.txt',
                old_string: 'old',
                new_string: 'new',
                sandbox_permissions: 'workspace-write',
                justification: 'Apply the requested fix.',
              },
            },
          ],
        },
        { text: 'done' },
      ],
    })
    writeFileSync(join(root, 'doc.txt'), 'old text\n')
    const approval = new ApprovalService('ask')
    const asked: string[] = []
    approval.setAnswerer(async (request) => {
      asked.push(request.reason ?? '')
      return 'allowed-once'
    })
    const fs = createFsTools({
      sandbox: new SandboxPolicyService({
        defaultMode: 'read-only',
        workspaceRoot: root,
      }),
      sandboxBackend: {
        confine() {
          throw new Error('unused')
        },
      },
      approval,
      spillRoot: join(root, '.spill'),
      writeStagingRoot: staging,
    })
    h.tools.register(fs.read)
    h.tools.register(fs.write)
    h.tools.register(fs.edit)
    const session = h.sessions.create({ id: 'fs-e2e', cwd: root })
    const agent = new Agent(session, {
      llm: h.llm,
      tools: h.tools,
      prompt: h.prompt,
      middleware: h.middleware,
    })
    agent.followup(userText('fix doc.txt'))
    await agent.whenIdle()
    expect(readFileSync(join(root, 'doc.txt'), 'utf8')).toBe('new text\n')
    expect(asked).toEqual([
      'escalate sandbox to workspace-write: Apply the requested fix.',
    ])
    expect(
      session.events
        .filter((e) => e.type === 'approval/decided')
        .map((e) => (e.data as { outcome: string }).outcome),
    ).toEqual(['allowed-once'])
    const results = session.events.filter((e) => e.type === 'tool/result')
    expect(results).toHaveLength(2)
  })
})

describe('prompt sections and diff', () => {
  it('registers read/write/edit guidance at orders 100-102 and disposes them', () => {
    const prompt = new SystemPromptAssembler()
    const dispose = installFsPromptSections(prompt)
    const sections = prompt.assemble().sections
    expect(sections.map((s) => s.name)).toEqual([
      'tool:read',
      'tool:write',
      'tool:edit',
    ])
    expect(sections[0]!.text).toContain('not shell commands like cat')
    dispose()
    expect(prompt.assemble().sections).toEqual([])
  })

  it('produces unified hunks with context and caps the diff text', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l2', 'L2').replace('l17', 'L17')
    const summary = unifiedDiff('/f', before, after)
    expect(summary.added).toBe(2)
    expect(summary.removed).toBe(2)
    expect(summary.diff.match(/^@@/gm)).toHaveLength(2)
    expect(summary.diff).toContain('@@ -1,6 +1,6 @@\n l0\n l1\n-l2\n+L2\n l3')
    const huge = unifiedDiff('/f', null, 'z'.repeat(30_000))
    expect(huge.diff.length).toBeLessThan(20_100)
    expect(huge.diffTruncated).toBe(true)
    expect(unifiedDiff('/f', 'same', 'same')).toEqual({
      added: 0,
      removed: 0,
      diff: '',
    })
  })
})
