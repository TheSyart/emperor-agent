import { createHash } from 'node:crypto'
import { EmperorError } from '../errors'

export type WebsitePreviewStatus =
  'probing' | 'ready' | 'unreachable' | 'stopped'

export interface WebsitePreviewDescriptor {
  id: string
  sessionId: string
  processId: string
  revision: number
  title: string
  url: string
  status: WebsitePreviewStatus
  primary: boolean
}

export type WebsitePreviewErrorCode =
  | 'website_preview_invalid'
  | 'website_preview_owner_invalid'
  | 'website_preview_stale'
  | 'website_preview_not_ready'

export class WebsitePreviewError extends EmperorError {
  constructor(code: WebsitePreviewErrorCode, message: string) {
    super(message, code)
  }
}

export interface WebsitePreviewRegistryOptions {
  probe?: (url: string) => Promise<boolean>
}

/**
 * Session-bound preview capability registry. A URL printed by a process is
 * only a candidate until it passes loopback validation and an HTTP probe.
 */
export class WebsitePreviewRegistry {
  private readonly previews = new Map<string, WebsitePreviewDescriptor>()
  private readonly probe: (url: string) => Promise<boolean>

  constructor(opts: WebsitePreviewRegistryOptions = {}) {
    this.probe = opts.probe ?? probeLoopbackHttp
  }

  async register(input: {
    sessionId: string
    processId: string
    revision: number
    title: string
    url: string
    primary: boolean
  }): Promise<WebsitePreviewDescriptor> {
    const sessionId = requiredId(input.sessionId, 'session')
    const processId = requiredId(input.processId, 'process')
    const revision = positiveRevision(input.revision)
    const url = normalizeLoopbackUrl(input.url)
    const id = previewId(sessionId, processId, revision)
    const existing = this.previews.get(id)
    if (existing && ['ready', 'stopped'].includes(existing.status))
      return { ...existing }

    if (input.primary) {
      for (const [otherId, other] of this.previews) {
        if (other.sessionId !== sessionId || !other.primary) continue
        this.previews.set(otherId, { ...other, primary: false })
      }
    }
    const descriptor: WebsitePreviewDescriptor = {
      id,
      sessionId,
      processId,
      revision,
      title: safeTitle(input.title),
      url,
      status: 'probing',
      primary: Boolean(input.primary),
    }
    this.previews.set(id, descriptor)
    const ready = await this.probe(url).catch(() => false)
    const settled: WebsitePreviewDescriptor = {
      ...descriptor,
      status: ready ? 'ready' : 'unreachable',
    }
    this.previews.set(id, settled)
    return { ...settled }
  }

  list(sessionIdValue: string): WebsitePreviewDescriptor[] {
    const sessionId = requiredId(sessionIdValue, 'session')
    return [...this.previews.values()]
      .filter((preview) => preview.sessionId === sessionId)
      .sort((left, right) => {
        if (left.primary !== right.primary) return left.primary ? -1 : 1
        return left.id.localeCompare(right.id)
      })
      .map((preview) => ({ ...preview }))
  }

  get(previewIdValue: string): WebsitePreviewDescriptor | null {
    const preview = this.previews.get(String(previewIdValue ?? '').trim())
    return preview ? { ...preview } : null
  }

  authorize(
    previewIdValue: string,
    sessionIdValue: string,
    expectedRevision?: number,
  ): WebsitePreviewDescriptor {
    const id = String(previewIdValue ?? '').trim()
    const sessionId = requiredId(sessionIdValue, 'session')
    const preview = this.previews.get(id)
    if (!preview || preview.sessionId !== sessionId)
      throw new WebsitePreviewError(
        'website_preview_owner_invalid',
        'Website preview does not belong to this session.',
      )
    if (expectedRevision !== undefined && preview.revision !== expectedRevision)
      throw new WebsitePreviewError(
        'website_preview_stale',
        'Website preview revision is stale.',
      )
    if (preview.status !== 'ready')
      throw new WebsitePreviewError(
        'website_preview_not_ready',
        'Website preview is not ready.',
      )
    return { ...preview }
  }

  stopProcess(
    sessionIdValue: string,
    processIdValue: string,
    revision?: number,
  ): WebsitePreviewDescriptor | null {
    const sessionId = requiredId(sessionIdValue, 'session')
    const processId = requiredId(processIdValue, 'process')
    const preview = [...this.previews.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.processId === processId &&
        (revision === undefined || candidate.revision === revision),
    )
    if (!preview) return null
    const stopped: WebsitePreviewDescriptor = {
      ...preview,
      status: 'stopped',
    }
    this.previews.set(preview.id, stopped)
    return { ...stopped }
  }
}

export function normalizeLoopbackUrl(value: string): string {
  let url: URL
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    throw new WebsitePreviewError(
      'website_preview_invalid',
      'Website preview URL is invalid.',
    )
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new WebsitePreviewError(
      'website_preview_invalid',
      'Website preview protocol is not allowed.',
    )
  if (url.username || url.password)
    throw new WebsitePreviewError(
      'website_preview_invalid',
      'Website preview URL credentials are forbidden.',
    )
  if (!isLoopbackHost(url.hostname))
    throw new WebsitePreviewError(
      'website_preview_invalid',
      'Website preview must use a loopback host.',
    )
  if (!url.port)
    throw new WebsitePreviewError(
      'website_preview_invalid',
      'Website preview must use an explicit port.',
    )
  url.hash = ''
  return url.toString()
}

export function isLoopbackHost(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  )
}

function previewId(
  sessionId: string,
  processId: string,
  revision: number,
): string {
  return `site_${createHash('sha256')
    .update(`${sessionId}\0${processId}\0${revision}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`
}

function requiredId(value: string, label: string): string {
  const id = String(value ?? '').trim()
  if (!id || id.length > 256)
    throw new WebsitePreviewError(
      'website_preview_invalid',
      `Website preview ${label} id is invalid.`,
    )
  return id
}

function positiveRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new WebsitePreviewError(
      'website_preview_invalid',
      'Website preview revision is invalid.',
    )
  return value
}

function safeTitle(value: string): string {
  return (
    String(value ?? '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 160) || 'Website'
  )
}

async function probeLoopbackHttp(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  timer.unref?.()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'text/html,*/*;q=0.1' },
    })
    return response.status >= 100 && response.status < 600
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
