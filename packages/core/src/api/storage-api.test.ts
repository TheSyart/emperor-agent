// KRN-12 on CoreApi: 设置 › 高级 › 存储 (`storage.usage`, `storage.clean`),
// the retention sweep at startup (in the background: it never holds up or
// fails startup), and `tools.readResult` in 256 KiB pages split on UTF-8
// boundaries.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from './core-api'
import { CoreMutationGuardError } from './mutation-guard'
import { invokeCoreOperation } from './operations'
import { makeApi, waitFor, type ApiFixture } from './test-helpers'

const VIEW = { sessionId: null }
const DAY = 24 * 60 * 60 * 1000
const PAGE = 256 * 1024

const apis: CoreApi[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()))
})

async function setup(
  options: Parameters<typeof makeApi>[0] = {},
): Promise<ApiFixture> {
  const fixture = await makeApi(options)
  apis.push(fixture.api)
  return fixture
}

function backdate(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY)
  if (statSync(path).isDirectory())
    for (const name of readdirSync(path)) backdate(join(path, name), days)
  utimesSync(path, when, when)
}

describe('tools.readResult pages (KRN-12)', () => {
  it('returns page 2 exactly, never splitting a character (7)', async () => {
    const { api, stateRoot } = await setup()
    const spill = join(stateRoot, 'spill', 'session-0123456789ab')
    mkdirSync(spill, { recursive: true })
    // A three-byte character straddles the first page boundary.
    const head = 'a'.repeat(PAGE - 1)
    const second = '界' + 'b'.repeat(PAGE - 6) + '尾'
    const third = 'c'.repeat(1000) + '完'
    const text = head + second + third
    const ref = join(spill, 'abcdef012345-bash.txt')
    writeFileSync(ref, text, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')

    const first = api.tools.readResult({ ref })
    expect(first).toMatchObject({ page: 1, pages: 3, bytes })
    expect(first.content).toBe(head)

    const page2 = await invokeCoreOperation(api, 'tools.readResult', [
      { ref, page: 2 },
    ])
    expect(page2).toMatchObject({ page: 2, pages: 3, bytes })
    expect(page2.content).toBe(second)
    expect(Buffer.byteLength(page2.content, 'utf8')).toBeLessThanOrEqual(
      PAGE + 3,
    )
    const page3 = api.tools.readResult({ ref, page: 3 })
    expect(page3.content).toBe(third)
    expect(first.content + page2.content + page3.content).toBe(text)
    expect(() => api.tools.readResult({ ref, page: 4 })).toThrow(/page/)
    await expect(
      invokeCoreOperation(api, 'tools.readResult', [{ ref, page: 0 }]),
    ).rejects.toThrow()
  })

  it('reads a small or empty result as one page', async () => {
    const { api, stateRoot } = await setup()
    mkdirSync(join(stateRoot, 'spill'), { recursive: true })
    const small = join(stateRoot, 'spill', 'small.txt')
    writeFileSync(small, '一小段')
    expect(api.tools.readResult({ ref: small })).toEqual({
      content: '一小段',
      page: 1,
      pages: 1,
      bytes: 9,
    })
    const empty = join(stateRoot, 'spill', 'empty.txt')
    writeFileSync(empty, '')
    expect(api.tools.readResult({ ref: empty })).toEqual({
      content: '',
      page: 1,
      pages: 1,
      bytes: 0,
    })
  })

  it('refuses a link inside the spill store that points outside it', async () => {
    const { api, stateRoot, root } = await setup()
    mkdirSync(join(stateRoot, 'spill'), { recursive: true })
    writeFileSync(join(root, 'secret.txt'), 'secret')
    const link = join(stateRoot, 'spill', 'link.txt')
    symlinkSync(join(root, 'secret.txt'), link)
    expect(() => api.tools.readResult({ ref: link })).toThrow(
      CoreMutationGuardError,
    )
  })
})

describe('storage operations (KRN-12)', () => {
  it('reports usage by category', async () => {
    const { api, stateRoot } = await setup()
    mkdirSync(join(stateRoot, 'spill'), { recursive: true })
    writeFileSync(join(stateRoot, 'spill', 'shell-1.log'), 'x'.repeat(50_000))
    const usage = await invokeCoreOperation(api, 'storage.usage', [])
    expect(usage.categories.map((item) => item.id)).toEqual([
      'sessions',
      'attachments',
      'spill',
      'memoryVersions',
      'ledger',
      'delegations',
      'other',
    ])
    const spill = usage.categories.find((item) => item.id === 'spill')
    expect(spill?.bytes).toBeGreaterThanOrEqual(50_000)
    expect(usage.total).toBeGreaterThan(spill!.bytes)
  })

  it('cleans on request and says what it freed', async () => {
    const { api, stateRoot } = await setup()
    // Let the startup sweep finish first (a sweep in progress is shared).
    await api.retention.sweep()
    const old = join(stateRoot, 'spill', 'shell-9-9-ff-stdout.log')
    mkdirSync(join(stateRoot, 'spill'), { recursive: true })
    writeFileSync(old, 'x'.repeat(40_000))
    backdate(old, 45)
    await expect(
      invokeCoreOperation(api, 'storage.clean', []),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
    expect(existsSync(old)).toBe(true)

    const result = await invokeCoreOperation(api, 'storage.clean', [], {
      view: VIEW,
    })
    expect(existsSync(old)).toBe(false)
    expect(result.report.spill.removed).toBe(1)
    expect(result.report.freedBytes).toBeGreaterThanOrEqual(40_000)
    expect(result.usage.categories).toHaveLength(7)
  })

  it('refuses to clean in plan mode', async () => {
    const { api } = await setup()
    const id = String(api.sessions.create({ title: 'Plan' }).id)
    api.control.setMode('plan', id)
    await expect(api.storage.clean({ sessionId: id })).rejects.toBeInstanceOf(
      CoreMutationGuardError,
    )
  })
})

describe('retention at startup (KRN-12)', () => {
  it('sweeps old orphan spill in the background after startup', async () => {
    const { root } = await setup()
    await apis.pop()!.close()
    const stateRoot = join(root, 'home')
    const orphan = join(stateRoot, 'spill', 'session-ffffffffffff')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'x-bash.txt'), 'x'.repeat(10_000))
    backdate(orphan, 40)
    await setup({ root })
    await waitFor(() => !existsSync(orphan))
  })

  it('starts even when the sweep cannot run', async () => {
    const { root } = await setup()
    await apis.pop()!.close()
    const stateRoot = join(root, 'home')
    // A file where the spill folder should be: the sweep fails, startup not.
    writeFileSync(join(stateRoot, 'spill'), 'not a folder')
    const { api } = await setup({ root })
    expect(api.sessions.list().length).toBeGreaterThanOrEqual(0)
  })
})
