/**
 * The update check's HTTP (REL-02). Every hop of every request is checked
 * against `UpdateUrlPolicy` before it is sent: in production only https on
 * GitHub's release hosts; a test feed (EMPEROR_UPDATE_FEED_URL, loopback
 * only) adds its own origin. Redirects are followed by hand so each target
 * is checked too. Requests carry `accept`, a fixed `user-agent` and, for the
 * API, `x-github-api-version` — no cookies, tokens or anything that names
 * the user or the Mac. The transport never sends cookies or credentials
 * (the desktop host gives Electron's net with both off).
 */
import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { UpdateError, updateErrorOf } from './errors'

import type { UpdateTransport, UpdateTransportResponse } from './types'

export type {
  UpdateTransport,
  UpdateTransportRequest,
  UpdateTransportResponse,
} from './types'

/** Hosts a release and its assets are served from. */
export const GITHUB_RELEASE_HOSTS: readonly string[] = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]

export const UPDATE_REPOSITORY = 'TheSyart/emperor-agent'
export const UPDATE_FEED_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_REDIRECTS = 5
const API_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 60_000

/**
 * EMPEROR_UPDATE_FEED_URL as a URL: unset → null; set, it must be http(s)
 * on a loopback address without credentials, else it is refused (a test
 * feed is for simulating a release on this Mac, never another server).
 */
export function feedOverrideUrl(value: string | undefined | null): URL | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UpdateError(
      'update_feed_invalid',
      'EMPEROR_UPDATE_FEED_URL 不是有效的地址，已忽略。',
    )
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !LOOPBACK_HOSTS.has(url.hostname)
  )
    throw new UpdateError(
      'update_feed_invalid',
      'EMPEROR_UPDATE_FEED_URL 只能指向本机（127.0.0.1、localhost）的测试更新源，已忽略。',
    )
  return url
}

export class UpdateUrlPolicy {
  constructor(private readonly override: URL | null) {}

  get testFeed(): URL | null {
    return this.override
  }

  allows(url: URL): boolean {
    if (url.username || url.password) return false
    if (this.override && url.origin === this.override.origin) return true
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      GITHUB_RELEASE_HOSTS.includes(url.hostname)
    )
  }
}

export interface UpdateHttpOptions {
  transport: UpdateTransport
  policy: UpdateUrlPolicy
  /** `Emperor-Agent/<version>`. */
  userAgent: string
  timeoutMs?: number
  idleTimeoutMs?: number
}

interface RequestOptions {
  accept: string
  /** A GitHub REST call: adds the API version header. */
  api?: boolean
  signal?: AbortSignal
}

export class UpdateHttp {
  readonly policy: UpdateUrlPolicy
  private readonly transport: UpdateTransport
  private readonly userAgent: string
  private readonly timeoutMs: number
  private readonly idleTimeoutMs: number

  constructor(options: UpdateHttpOptions) {
    this.transport = options.transport
    this.policy = options.policy
    this.userAgent = options.userAgent
    this.timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  }

  /** A small body (the release list, SHA256SUMS.txt), whole. */
  async getBytes(
    url: URL,
    options: RequestOptions & { maxBytes: number },
  ): Promise<Uint8Array> {
    const controller = linkedController(options.signal)
    const timer = setTimeout(
      () =>
        controller.abort(
          new UpdateError('update_network_failed', '连接 GitHub 超时。'),
        ),
      this.timeoutMs,
    )
    timer.unref?.()
    try {
      const response = await this.open(url, options, controller.signal)
      const chunks: Buffer[] = []
      let bytes = 0
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength
          if (bytes > options.maxBytes) throw tooLarge()
          chunks.push(Buffer.from(chunk))
        }
      } finally {
        response.close()
      }
      return Buffer.concat(chunks, bytes)
    } catch (error) {
      throw abortReason(controller.signal) ?? updateErrorOf(error)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Stream a download into `file` (created 0600, never overwritten) and
   * return its SHA-256. A body longer than `maxBytes`, a length other than
   * `expectedBytes`, or `idleTimeoutMs` without data fails and removes the
   * file.
   */
  async downloadTo(
    url: URL,
    file: string,
    options: {
      maxBytes: number
      expectedBytes?: number
      signal?: AbortSignal
      onProgress?: (receivedBytes: number) => void
    },
  ): Promise<string> {
    const controller = linkedController(options.signal)
    let idle: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(
        () =>
          controller.abort(
            new UpdateError(
              'update_network_failed',
              `下载超过 ${Math.round(this.idleTimeoutMs / 1000)} 秒没有收到数据，已停止。`,
            ),
          ),
        this.idleTimeoutMs,
      )
      idle.unref?.()
    }
    touch()
    const handle = await open(file, 'wx', 0o600)
    let closed = false
    try {
      const response = await this.open(
        url,
        { accept: 'application/octet-stream' },
        controller.signal,
      )
      const hash = createHash('sha256')
      let bytes = 0
      try {
        for await (const chunk of response.body) {
          if (controller.signal.aborted) break
          touch()
          bytes += chunk.byteLength
          if (bytes > options.maxBytes) throw tooLarge()
          hash.update(chunk)
          await handle.write(chunk)
          options.onProgress?.(bytes)
        }
      } finally {
        response.close()
      }
      const reason = abortReason(controller.signal)
      if (reason) throw reason
      if (
        options.expectedBytes !== undefined &&
        bytes !== options.expectedBytes
      )
        throw new UpdateError(
          'update_network_failed',
          `下载不完整（收到 ${bytes} 字节，应为 ${options.expectedBytes} 字节），已删除。`,
        )
      await handle.sync()
      await handle.close()
      closed = true
      return hash.digest('hex')
    } catch (error) {
      if (!closed) await handle.close().catch(() => {})
      await rm(file, { force: true }).catch(() => {})
      throw abortReason(controller.signal) ?? updateErrorOf(error)
    } finally {
      if (idle) clearTimeout(idle)
    }
  }

  private async open(
    start: URL,
    options: RequestOptions,
    signal: AbortSignal,
  ): Promise<UpdateTransportResponse> {
    const headers: Record<string, string> = {
      accept: options.accept,
      'user-agent': this.userAgent,
      ...(options.api ? { 'x-github-api-version': '2022-11-28' } : {}),
    }
    let url = start
    for (let redirects = 0; ; redirects += 1) {
      if (!this.policy.allows(url)) throw blockedUrl()
      const response = await this.transport({ url, headers, signal })
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.close()
        const location = headerValue(response.headers.location)
        if (!location || redirects >= MAX_REDIRECTS)
          throw new UpdateError(
            'update_network_failed',
            'GitHub 的跳转不完整或次数过多。',
          )
        try {
          url = new URL(location, url)
        } catch {
          throw blockedUrl()
        }
        continue
      }
      if (response.statusCode !== 200) {
        response.close()
        throw new UpdateError(
          'update_network_failed',
          `GitHub 返回 HTTP ${response.statusCode}。`,
        )
      }
      return response
    }
  }
}

/**
 * Node's http/https without redirects, cookies or an agent pool: the
 * fallback when the host gives no transport (and the tests' real server).
 */
export const nodeUpdateTransport: UpdateTransport = (request) =>
  new Promise((resolve, reject) => {
    const send = request.url.protocol === 'https:' ? httpsRequest : httpRequest
    const outgoing = send(
      request.url,
      {
        method: 'GET',
        headers: request.headers,
        agent: false,
        signal: request.signal,
      },
      (incoming) => {
        resolve({
          statusCode: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: incoming,
          close: () => incoming.destroy(),
        })
      },
    )
    outgoing.once('error', reject)
    outgoing.end()
  })

function linkedController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else
      signal.addEventListener('abort', () => controller.abort(signal.reason), {
        once: true,
      })
  }
  return controller
}

function abortReason(signal: AbortSignal): UpdateError | null {
  if (!signal.aborted) return null
  return signal.reason instanceof UpdateError
    ? signal.reason
    : new UpdateError('cancelled', '已取消下载。')
}

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function blockedUrl(): UpdateError {
  return new UpdateError(
    'update_blocked_url',
    '更新地址不在 GitHub 的发布地址范围内，已拒绝。',
  )
}

function tooLarge(): UpdateError {
  return new UpdateError(
    'update_too_large',
    '下载的内容比发布时声明的大，已停止并删除。',
  )
}
