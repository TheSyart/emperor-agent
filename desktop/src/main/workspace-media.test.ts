import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKSPACE_MEDIA_OPEN_CHANNEL } from '../shared/ipc-contract'
import { appAssetRequestAccess } from './protocol'
import {
  parseByteRange,
  registerWorkspaceMediaIpc,
  workspaceMediaResponse,
  type WorkspaceMediaLookup,
} from './workspace-media'

// BUG-05: app://workspace-media/<token> streams a video Core granted, with
// Range support, and 「用默认应用打开」 opens the same granted file.

const TOKEN = 'a'.repeat(32)
const SIZE = 10_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function video(): {
  path: string
  bytes: Buffer
  lookup: WorkspaceMediaLookup
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-media-')))
  dirs.push(dir)
  const path = join(dir, '飞行 测试.mp4')
  const bytes = Buffer.alloc(SIZE)
  for (let i = 0; i < SIZE; i += 1) bytes[i] = i % 251
  writeFileSync(path, bytes)
  const lookup = vi.fn((token: string) =>
    token === TOKEN ? { absPath: path, mimeType: 'video/mp4' } : null,
  )
  return { path, bytes, lookup }
}

function get(range?: string, path = `/${TOKEN}`, method = 'GET'): Request {
  return new Request(`app://workspace-media${path}`, {
    method,
    headers: range ? { Range: range } : {},
  })
}

describe('parseByteRange (BUG-05 5)', () => {
  it('reads the Range table', () => {
    expect(parseByteRange(null, SIZE)).toBeNull()
    expect(parseByteRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 9_999 })
    expect(parseByteRange('bytes=1000-1999', SIZE)).toEqual({
      start: 1_000,
      end: 1_999,
    })
    expect(parseByteRange('bytes=-500', SIZE)).toEqual({
      start: 9_500,
      end: 9_999,
    })
    expect(parseByteRange(`bytes=${SIZE}-`, SIZE)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-1,5-6', SIZE)).toEqual({ start: 0, end: 1 })
  })

  it('clamps an end past the file, ignores what it cannot read', () => {
    expect(parseByteRange('bytes=9000-20000', SIZE)).toEqual({
      start: 9_000,
      end: 9_999,
    })
    expect(parseByteRange('bytes=-20000', SIZE)).toEqual({
      start: 0,
      end: 9_999,
    })
    expect(parseByteRange('bytes=-0', SIZE)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable')
    // Not a byte range at all: the whole file (RFC 9110 §14.2).
    for (const header of ['items=0-1', 'bytes=abc', 'bytes=5-2', 'bytes=', ''])
      expect(parseByteRange(header, SIZE), header).toBeNull()
  })
})

describe('app://workspace-media (BUG-05 5)', () => {
  it('answers 200 with the whole file when no range is asked', async () => {
    const { bytes, lookup } = video()
    const response = await workspaceMediaResponse(get(), lookup)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe(String(SIZE))
    expect(response.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  })

  it('answers 206 with the asked part', async () => {
    const { bytes, lookup } = video()
    const cases: Array<[string, number, number]> = [
      ['bytes=0-', 0, 9_999],
      ['bytes=1000-1999', 1_000, 1_999],
      ['bytes=-500', 9_500, 9_999],
      ['bytes=0-1,5-6', 0, 1],
    ]
    for (const [range, start, end] of cases) {
      const response = await workspaceMediaResponse(get(range), lookup)
      expect(response.status, range).toBe(206)
      expect(response.headers.get('content-range')).toBe(
        `bytes ${start}-${end}/${SIZE}`,
      )
      expect(response.headers.get('content-length')).toBe(
        String(end - start + 1),
      )
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        bytes.subarray(start, end + 1),
      )
    }
  })

  it('answers 416 for a start past the end', async () => {
    const { lookup } = video()
    const response = await workspaceMediaResponse(get(`bytes=${SIZE}-`), lookup)
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${SIZE}`)
  })

  it('serves only the granted file: the rest of the address is ignored', async () => {
    const { bytes, lookup } = video()
    const response = await workspaceMediaResponse(
      get(undefined, `/${TOKEN}/other.mp4`),
      lookup,
    )
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(lookup).toHaveBeenCalledWith(TOKEN)
  })

  it('answers 404 for an unknown or expired token, a malformed one, or a file gone', async () => {
    const { path, lookup } = video()
    expect(
      (
        await workspaceMediaResponse(
          get(undefined, `/${'b'.repeat(32)}`),
          lookup,
        )
      ).status,
    ).toBe(404)
    for (const bad of ['/', '/short', `/${TOKEN.toUpperCase()}`, '/..%2Fetc'])
      expect(
        (await workspaceMediaResponse(get(undefined, bad), lookup)).status,
        bad,
      ).toBe(404)
    expect(lookup).toHaveBeenCalledTimes(1)
    // A path that turned into a symlink since the grant is not followed.
    const elsewhere = join(path, '..', 'elsewhere.mp4')
    writeFileSync(elsewhere, 'x')
    unlinkSync(path)
    symlinkSync(elsewhere, path)
    expect((await workspaceMediaResponse(get(), lookup)).status).toBe(404)
    unlinkSync(path)
    expect((await workspaceMediaResponse(get(), lookup)).status).toBe(404)
  })

  it('answers HEAD with the headers only', async () => {
    const { lookup } = video()
    const response = await workspaceMediaResponse(
      get(undefined, `/${TOKEN}`, 'HEAD'),
      lookup,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(SIZE))
    expect(response.body).toBeNull()
  })
})

describe('app://workspace-media origin (BUG-05 6)', () => {
  it('lets only the main renderer read it', () => {
    expect(appAssetRequestAccess('workspace-media', 'app://bundle')).toEqual({
      allowed: true,
      allowOrigin: 'app://bundle',
    })
    for (const origin of ['app://pet', 'https://example.com', 'null'])
      expect(appAssetRequestAccess('workspace-media', origin), origin).toEqual({
        allowed: false,
        allowOrigin: null,
      })
    // A <video> request carries no Origin, like every other app:// asset.
    expect(appAssetRequestAccess('workspace-media', null).allowed).toBe(true)
  })
})

describe('emperor:workspace-media:open (BUG-05 8)', () => {
  function setup(lookup: WorkspaceMediaLookup) {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const openPath = vi.fn(async (_path: string) => '')
    const authorize = vi.fn((event: unknown) => {
      if (event !== 'main') throw new Error('IPC caller is not trusted')
    })
    registerWorkspaceMediaIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      authorize,
      lookup,
      openPath,
    })
    const invoke = async (payload: unknown, event: unknown = 'main') =>
      await handlers.get(WORKSPACE_MEDIA_OPEN_CHANNEL)!(event, payload)
    return { invoke, openPath, authorize }
  }

  it('opens the granted video in its default app', async () => {
    const { path, lookup } = video()
    const { invoke, openPath, authorize } = setup(lookup)
    await expect(
      invoke({ url: `app://workspace-media/${TOKEN}` }),
    ).resolves.toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledWith(path)
    await expect(
      invoke({ url: `app://workspace-media/${TOKEN}` }, 'other'),
    ).rejects.toThrow(/not trusted/)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('opens nothing the renderer names, nor a grant that ended or a file gone', async () => {
    const { path, lookup } = video()
    const { invoke, openPath } = setup(lookup)
    for (const payload of [
      path,
      { url: path },
      { url: `file://${path}` },
      { url: `app://media/${TOKEN}` },
      { url: `app://workspace-media/${'b'.repeat(32)}` },
      null,
    ])
      expect(await invoke(payload), JSON.stringify(payload)).toMatchObject({
        ok: false,
      })
    unlinkSync(path)
    expect(
      await invoke({ url: `app://workspace-media/${TOKEN}` }),
    ).toMatchObject({ ok: false, error: '文件已不存在' })
    expect(openPath).not.toHaveBeenCalled()
  })
})
