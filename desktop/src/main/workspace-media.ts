/**
 * `app://workspace-media/<token>` — what the Files pane streams (BUG-05,
 * BUG-10): videos, songs, pictures (or the PNG Core made of a HEIC) and a
 * document's first page. The token is Core's (files.mediaUrl): it stands
 * for one file Core resolved under the files.preview checks, for ten
 * minutes. The address names no path, so whatever follows the token is
 * ignored; an unknown or expired token, a grant that only names a file, a
 * file gone, or a path that is no longer that same file (a symlink put in
 * its place) answers 404. Bodies stream from disk with Range support, so a
 * long video seeks without being read whole.
 *
 * `emperor:workspace-media:open` acts on the file a grant names: 「用默认应
 * 用打开」 (`shell.openPath`, never for a program, script or bundle —
 * isOpenableFile is checked again here) or 「在访达中显示」. Never a path the
 * renderer names.
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { isOpenableFile } from '@emperor/core/api'
import { WORKSPACE_MEDIA_OPEN_CHANNEL } from '../shared/ipc-contract'

export const WORKSPACE_MEDIA_HOST = 'workspace-media'

/** What main needs of a grant (Core's files.mediaGrant). */
export type WorkspaceMediaLookup = (token: string) => {
  absPath: string
  filePath: string
  streamable: boolean
  mimeType: string
} | null

const TOKEN = /^[0-9a-f]{32}$/
const GONE = '文件已不存在'
const NOT_ALLOWED = '这个文件地址已失效，请重新打开文件'
const RUNNABLE = '这个文件可能会运行程序，只能在访达中显示'

export interface ByteRange {
  start: number
  end: number
}

/**
 * The first range of a `Range: bytes=…` header for a file of `size` bytes:
 * null when there is none to honour (no header, another unit, malformed:
 * the whole file), 'unsatisfiable' when it starts past the end. Chromium
 * never asks for several ranges; only the first one is served.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*(?:,|$)/.exec(header ?? '')
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffix = Number(match[2])
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : Infinity
  if (end < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

function tokenOf(url: URL): string | null {
  const token = url.pathname.split('/')[1] ?? ''
  return TOKEN.test(token) ? token : null
}

/** A regular file still at that exact path (no symlink put there): its size. */
async function sizeAt(path: string): Promise<number | null> {
  try {
    if ((await realpath(path)) !== path) return null
    const metadata = await stat(path)
    return metadata.isFile() ? metadata.size : null
  } catch {
    return null
  }
}

function grantOf(url: URL, lookup: WorkspaceMediaLookup) {
  if (url.protocol !== 'app:' || url.host !== WORKSPACE_MEDIA_HOST) return null
  const token = tokenOf(url)
  return token ? lookup(token) : null
}

export async function workspaceMediaResponse(
  request: Request,
  lookup: WorkspaceMediaLookup,
): Promise<Response> {
  const grant = grantOf(new URL(request.url), lookup)
  const size = grant?.streamable ? await sizeAt(grant.absPath) : null
  if (!grant || size === null)
    return new Response('media not found', { status: 404 })
  const file = { absPath: grant.absPath, mimeType: grant.mimeType, size }
  const headers: Record<string, string> = {
    'content-type': file.mimeType,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  }
  const range = parseByteRange(request.headers.get('range'), file.size)
  if (range === 'unsatisfiable')
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${file.size}` },
    })
  const { start, end } = range ?? { start: 0, end: file.size - 1 }
  headers['content-length'] = String(Math.max(0, end - start + 1))
  if (range) headers['content-range'] = `bytes ${start}-${end}/${file.size}`
  const status = range ? 206 : 200
  if (request.method === 'HEAD' || file.size === 0)
    return new Response(null, { status, headers })
  const body = Readable.toWeb(
    createReadStream(file.absPath, { start, end }),
  ) as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown,
  ): void
}

export function registerWorkspaceMediaIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  lookup: WorkspaceMediaLookup
  /** `shell.openPath`: '' on success, else the error. */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}): void {
  input.ipcMain.handle(WORKSPACE_MEDIA_OPEN_CHANNEL, async (event, payload) => {
    input.authorize(event)
    const record =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { url?: unknown; action?: unknown })
        : {}
    let url: URL
    try {
      url = new URL(
        typeof record.url === 'string' ? record.url.slice(0, 512) : '',
      )
    } catch {
      return { ok: false, error: NOT_ALLOWED }
    }
    const grant = grantOf(url, input.lookup)
    if (!grant) return { ok: false, error: NOT_ALLOWED }
    if ((await sizeAt(grant.filePath)) === null)
      return { ok: false, error: GONE }
    if (record.action === 'reveal') {
      input.showItemInFolder(grant.filePath)
      return { ok: true }
    }
    if (!isOpenableFile(grant.filePath)) return { ok: false, error: RUNNABLE }
    const error = await input.openPath(grant.filePath)
    return error ? { ok: false, error } : { ok: true }
  })
}
