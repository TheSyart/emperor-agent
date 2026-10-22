/**
 * Remote images in rendered markdown (UI-38). The renderer never requests
 * them (CSP img-src has no http(s), and useMarkdown renders a placeholder);
 * when the user clicks one, main fetches it here through Core's public HTTP
 * client — the same one `web_fetch` uses: no cookies, no credentials in the
 * address, no loopback, private or link-local addresses (DNS checked, each
 * redirect too) — and hands the bytes back as a data: URL.
 */
import {
  PublicHttpError,
  type WebFetchClient,
} from '@emperor/core/host-capabilities'
import {
  MARKDOWN_REMOTE_IMAGE_CHANNEL,
  type RemoteImageResult,
} from '../shared/ipc-contract'

const MAX_BYTES = 10 * 1024 * 1024
const TIMEOUT_MS = 20_000
const MAX_URL = 4096
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown,
  ): void
}

export async function fetchRemoteImage(
  value: unknown,
  client: Pick<WebFetchClient, 'get'>,
  options: { timeoutMs?: number } = {},
): Promise<RemoteImageResult> {
  const url = remoteImageUrl(value)
  if (!url) return { ok: false, error: '这个图片地址不能加载' }
  let response: Awaited<ReturnType<WebFetchClient['get']>>
  try {
    response = await client.get({
      url,
      protocols: ['https:', 'http:'],
      maxBytes: MAX_BYTES,
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      headers: {
        accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
      },
    })
  } catch (error) {
    return { ok: false, error: failureMessage(error) }
  }
  if ('kind' in response) return { ok: false, error: '图片地址发生了跳转' }
  if (response.status < 200 || response.status > 299)
    return { ok: false, error: `图片加载失败（HTTP ${response.status}）` }
  const type = contentType(response.headers['content-type'])
  if (!IMAGE_TYPES.has(type))
    return { ok: false, error: '这个地址返回的不是图片' }
  if (!response.body.byteLength) return { ok: false, error: '图片是空的' }
  return {
    ok: true,
    dataUrl: `data:${type};base64,${Buffer.from(response.body).toString('base64')}`,
  }
}

export function registerRemoteImageIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  client: Pick<WebFetchClient, 'get'>
}): void {
  input.ipcMain.handle(
    MARKDOWN_REMOTE_IMAGE_CHANNEL,
    async (event, payload) => {
      input.authorize(event)
      const url =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as { url?: unknown }).url
          : undefined
      return await fetchRemoteImage(url, input.client)
    },
  )
}

function remoteImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  return url.toString()
}

function contentType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  return (raw ?? '').split(';')[0]!.trim().toLowerCase()
}

function failureMessage(error: unknown): string {
  if (!(error instanceof PublicHttpError)) return '图片加载失败'
  switch (error.code) {
    case 'blocked_url':
    case 'blocked_address':
      return '这个地址不能加载（本机或内网地址）'
    case 'dns_failed':
      return '找不到这个网站'
    case 'timeout':
    case 'cancelled':
      return '图片加载超时'
    case 'response_too_large':
      return '图片太大（超过 10 MB）'
    case 'redirect_limit':
      return '图片地址跳转次数过多'
    default:
      return '图片加载失败'
  }
}
