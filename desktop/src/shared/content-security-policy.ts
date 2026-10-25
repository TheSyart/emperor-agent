/**
 * The main window's Content Security Policy (SEC-05), from one place:
 * - main sets it as the `Content-Security-Policy` header of every
 *   `app://bundle` response (protocol.ts);
 * - `src/renderer/index.html` carries the same policy as a meta tag
 *   (content-security-policy.test.ts keeps the two equal);
 * - the Vite dev server swaps the meta for the dev policy, which only adds
 *   the HMR WebSocket (vite-csp-plugin.ts).
 *
 * Scripts come from the bundle only (no inline script, no eval). Inline
 * styles stay allowed: Vue style bindings, highlight.js and xterm set them.
 * Images and media come from the bundle, `app:` (attachments, media,
 * plugin logos, the Files pane's videos) and `data:`/`blob:`; a remote image in a reply is fetched by
 * main on request (remote-image-ipc.ts), never by the renderer. `connect-src`
 * allows `app:` (the packaged smoke reads an attachment through it) and
 * `blob:` (the preview stack copies a frame it already holds); neither
 * reaches the network.
 */

/** Where the dev server collects violation reports (dev and visual tests). */
export const CSP_REPORT_PATH = '/__emperor/csp-report'

export interface RendererCspOptions {
  /** Dev server: also allow the Vite HMR WebSocket. */
  readonly devServer?: boolean
  /** Append `report-uri` (only honoured in a header, never in the meta). */
  readonly reportUri?: string
}

const PRODUCTION: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:', 'blob:', 'app:']],
  ['font-src', ["'self'", 'data:']],
  ['connect-src', ["'self'", 'app:', 'blob:']],
  ['media-src', ["'self'", 'blob:', 'app:']],
  ['object-src', ["'none'"]],
  ['frame-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'none'"]],
]

const DEV_CONNECT = ['ws://localhost:*', 'ws://127.0.0.1:*'] as const

export function rendererContentSecurityPolicy(
  options: RendererCspOptions = {},
): string {
  const parts = PRODUCTION.map(([name, values]) => {
    const all =
      options.devServer && name === 'connect-src'
        ? [...values, ...DEV_CONNECT]
        : values
    return `${name} ${all.join(' ')}`
  })
  if (options.reportUri) parts.push(`report-uri ${options.reportUri}`)
  return parts.join('; ')
}

const META = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i

/** `html` with exactly one CSP meta carrying `policy`. */
export function withCspMeta(html: string, policy: string): string {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}" />`
  if (META.test(html)) return html.replace(META, tag)
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${tag}`)
}
