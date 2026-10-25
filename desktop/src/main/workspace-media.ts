/**
 * `app://workspace-media/<token>` — the videos of the Files pane (BUG-05).
 * The token is Core's (files.mediaUrl): it stands for one file Core resolved
 * under the files.preview checks, for ten minutes. The address names no
 * path, so whatever follows the token is ignored; an unknown or expired
 * token, a file gone, or a path that is no longer that same file (a symlink
 * put in its place) answers 404. Bodies stream from disk with Range support,
 * so a long video seeks without being read whole.
 *
 * `emperor:workspace-media:open` (「用默认应用打开」) opens the file behind
 * such an address with `shell.openPath`: only a video Core granted, never a
 * path the renderer names.
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { WORKSPACE_MEDIA_OPEN_CHANNEL } from '../shared/ipc-contract'

export const WORKSPACE_MEDIA_HOST = 'workspace-media'

/** What main needs of a grant (Core's files.mediaGrant). */
export type WorkspaceMediaLookup = (
  token: string,
) => { absPath: string; mimeType: string } | null

const TOKEN = /^[0-9a-f]{32}$/
const GONE = '文件已不存在'
const NOT_ALLOWED = '这个视频地址已失效，请重新打开文件'

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

/** The granted file, still a regular file at that exact path; else null. */
async function grantedFile(
  url: URL,
  lookup: WorkspaceMediaLookup,
): Promise<{ absPath: string; mimeType: string; size: number } | null> {
  if (url.protocol !== 'app:' || url.host !== WORKSPACE_MEDIA_HOST) return null
  const token = tokenOf(url)
  const grant = token ? lookup(token) : null
  if (!grant) return null
  try {
    if ((await realpath(grant.absPath)) !== grant.absPath) return null
    const metadata = await stat(grant.absPath)
    if (!metadata.isFile()) return null
    return { ...grant, size: metadata.size }
  } catch {
    return null
  }
}

export async function workspaceMediaResponse(
  request: Request,
  lookup: WorkspaceMediaLookup,
): Promise<Response> {
  const file = await grantedFile(new URL(request.url), lookup)
  if (!file) return new Response('media not found', { status: 404 })
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
}): void {
  input.ipcMain.handle(WORKSPACE_MEDIA_OPEN_CHANNEL, async (event, payload) => {
    input.authorize(event)
    const address =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { url?: unknown }).url
        : undefined
    let url: URL
    try {
      url = new URL(typeof address === 'string' ? address.slice(0, 512) : '')
    } catch {
      return { ok: false, error: NOT_ALLOWED }
    }
    const token = url.host === WORKSPACE_MEDIA_HOST ? tokenOf(url) : null
    if (url.protocol !== 'app:' || !token || !input.lookup(token))
      return { ok: false, error: NOT_ALLOWED }
    const file = await grantedFile(url, input.lookup)
    if (!file) return { ok: false, error: GONE }
    const error = await input.openPath(file.absPath)
    return error ? { ok: false, error } : { ok: true }
  })
}
