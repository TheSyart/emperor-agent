import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CSP_REPORT_PATH,
  rendererContentSecurityPolicy,
} from './content-security-policy'
import { rendererCspPlugin, type CspMiddleware } from './vite-csp-plugin'

const INDEX =
  '<head><meta http-equiv="Content-Security-Policy" content="x" /></head>'

type Hooks = {
  transformIndexHtml: (html: string) => string
  configResolved: (config: { command: 'serve' | 'build' }) => void
  configureServer: (server: {
    middlewares: { use(handler: CspMiddleware): void }
    config: { logger: { warn(message: string): void } }
  }) => void
}

function plugin(
  command: 'serve' | 'build',
  options: Parameters<typeof rendererCspPlugin>[0] = {},
) {
  const hooks = rendererCspPlugin(options) as unknown as Hooks
  hooks.configResolved({ command })
  return hooks
}

function server(hooks: Hooks) {
  const handlers: CspMiddleware[] = []
  const warn = vi.fn()
  hooks.configureServer({
    middlewares: { use: (handler) => handlers.push(handler) },
    config: { logger: { warn } },
  })
  return { handler: handlers[0]!, warn }
}

function response() {
  const headers = new Map<string, string>()
  return {
    headers,
    statusCode: 200,
    setHeader: (name: string, value: string) =>
      headers.set(name.toLowerCase(), value),
    end: vi.fn(),
  }
}

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('renderer CSP Vite plugin', () => {
  it('keeps the production policy in the built index.html', () => {
    expect(plugin('build').transformIndexHtml(INDEX)).toContain(
      `content="${rendererContentSecurityPolicy()}"`,
    )
  })

  it('serves the dev policy (HMR WebSocket) in the dev server meta', () => {
    expect(plugin('serve').transformIndexHtml(INDEX)).toContain(
      `content="${rendererContentSecurityPolicy({ devServer: true })}"`,
    )
  })

  it('sends the dev policy as a header with a report endpoint', () => {
    const { handler } = server(plugin('serve'))
    const res = response()
    const next = vi.fn()
    handler({ method: 'GET', url: '/' } as never, res as never, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.get('content-security-policy')).toBe(
      rendererContentSecurityPolicy({
        devServer: true,
        reportUri: CSP_REPORT_PATH,
      }),
    )
  })

  it('report-only mode drops the meta and only reports', () => {
    const hooks = plugin('serve', { reportOnly: true })
    expect(hooks.transformIndexHtml(INDEX)).not.toContain(
      'Content-Security-Policy',
    )
    const { handler } = server(hooks)
    const res = response()
    handler({ method: 'GET', url: '/' } as never, res as never, vi.fn())
    expect(res.headers.has('content-security-policy')).toBe(false)
    expect(res.headers.get('content-security-policy-report-only')).toContain(
      `report-uri ${CSP_REPORT_PATH}`,
    )
  })

  it('records each violation report to the report file and the log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'emperor-csp-'))
    const reportFile = join(dir, 'reports.jsonl')
    const { handler, warn } = server(plugin('serve', { reportFile }))
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'http://127.0.0.1:5317/',
        'violated-directive': 'img-src',
        'blocked-uri': 'https://tracker.example/pixel.png',
      },
    })
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      method: 'POST',
      url: CSP_REPORT_PATH,
    })
    const res = response()
    const next = vi.fn()
    await new Promise<void>((resolve) => {
      res.end.mockImplementation(() => resolve())
      handler(req as never, res as never, next)
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(204)
    const lines = readFileSync(reportFile, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      directive: 'img-src',
      blocked: 'https://tracker.example/pixel.png',
      document: 'http://127.0.0.1:5317/',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('https://tracker.example/pixel.png'),
    )
  })
})
