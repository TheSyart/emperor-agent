/**
 * Vite plugin for the renderer's Content Security Policy (SEC-05).
 * - build: index.html keeps the production policy (content-security-policy.ts);
 * - dev server: the meta carries the dev policy (adds the HMR WebSocket),
 *   every response carries it as a header with `report-uri`, and each
 *   violation report is logged and appended to `reportFile` (JSON lines),
 *   which the visual suite checks after its run (tests/visual/csp-*.ts);
 * - `reportOnly`: no meta, `Content-Security-Policy-Report-Only` instead, to
 *   collect violations without blocking anything.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import {
  CSP_REPORT_PATH,
  rendererContentSecurityPolicy,
  withCspMeta,
} from './content-security-policy'

export interface CspPluginOptions {
  readonly reportOnly?: boolean
  /** JSON-lines file for violation reports; none: only logged. */
  readonly reportFile?: string
}

export type CspMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void

interface DevServerLike {
  middlewares: { use(handler: CspMiddleware): void }
  config: { logger: { warn(message: string): void } }
}

const MAX_REPORT_BYTES = 64 * 1024

export function rendererCspPlugin(options: CspPluginOptions = {}) {
  let serve = false
  return {
    name: 'emperor-renderer-csp',
    configResolved(config: { command: string }) {
      serve = config.command === 'serve'
    },
    transformIndexHtml(html: string): string {
      if (serve && options.reportOnly)
        return html.replace(
          /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i,
          '',
        )
      return withCspMeta(
        html,
        rendererContentSecurityPolicy({ devServer: serve }),
      )
    },
    configureServer(server: DevServerLike) {
      const header = options.reportOnly
        ? 'Content-Security-Policy-Report-Only'
        : 'Content-Security-Policy'
      const policy = rendererContentSecurityPolicy({
        devServer: true,
        reportUri: CSP_REPORT_PATH,
      })
      const warn = (message: string): void => server.config.logger.warn(message)
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (req.method === 'POST' && path === CSP_REPORT_PATH) {
          collectReport(req, res, options.reportFile, warn)
          return
        }
        res.setHeader(header, policy)
        next()
      })
    },
  }
}

function collectReport(
  req: IncomingMessage,
  res: ServerResponse,
  reportFile: string | undefined,
  warn: (message: string) => void,
): void {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= MAX_REPORT_BYTES) chunks.push(chunk)
  })
  req.on('end', () => {
    const entry = reportEntry(Buffer.concat(chunks).toString('utf8'))
    if (entry) {
      warn(
        `[csp] ${entry.directive} blocked ${entry.blocked} on ${entry.document}`,
      )
      if (reportFile) {
        try {
          mkdirSync(dirname(reportFile), { recursive: true })
          appendFileSync(reportFile, `${JSON.stringify(entry)}\n`)
        } catch {
          // The log line above still carries the violation.
        }
      }
    }
    res.statusCode = 204
    res.end()
  })
}

function reportEntry(body: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const report =
    parsed && typeof parsed === 'object' && 'csp-report' in parsed
      ? (parsed as { 'csp-report': Record<string, unknown> })['csp-report']
      : null
  if (!report || typeof report !== 'object') return null
  return {
    directive: report['effective-directive'] ?? report['violated-directive'],
    blocked: report['blocked-uri'],
    document: report['document-uri'],
    source: report['source-file'],
    line: report['line-number'],
    sample: report['script-sample'],
    disposition: report.disposition,
  }
}
