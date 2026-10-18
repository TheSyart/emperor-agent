import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CSP_REPORT_PATH,
  rendererContentSecurityPolicy,
  withCspMeta,
} from './content-security-policy'

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/)
        return [name!, values]
      }),
  )

describe('main window content security policy', () => {
  it('is strict in production: own scripts only, no remote fetches, no frames', () => {
    const policy = directives(rendererContentSecurityPolicy())

    expect(policy.get('default-src')).toEqual(["'self'"])
    expect(policy.get('script-src')).toEqual(["'self'"])
    expect(policy.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(policy.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'app:'])
    expect(policy.get('font-src')).toEqual(["'self'", 'data:'])
    expect(policy.get('media-src')).toEqual(["'self'", 'blob:', 'app:'])
    expect(policy.get('object-src')).toEqual(["'none'"])
    expect(policy.get('frame-src')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'self'"])
    expect(policy.get('form-action')).toEqual(["'none'"])
    // app: and blob: stay on this machine; no http(s), ws(s) or wildcard.
    expect(policy.get('connect-src')).toEqual(["'self'", 'app:', 'blob:'])
    const everything = [...policy.values()].flat()
    expect(everything).not.toContain("'unsafe-eval'")
    expect(everything.some((value) => /^(?:https?|wss?):|\*/.test(value))).toBe(
      false,
    )
    expect(policy.has('report-uri')).toBe(false)
  })

  it('lets the Vite dev server connect for HMR, and nothing else changes', () => {
    const production = directives(rendererContentSecurityPolicy())
    const dev = directives(rendererContentSecurityPolicy({ devServer: true }))

    expect(dev.get('connect-src')).toEqual([
      "'self'",
      'app:',
      'blob:',
      'ws://localhost:*',
      'ws://127.0.0.1:*',
    ])
    for (const [name, values] of production)
      if (name !== 'connect-src') expect(dev.get(name)).toEqual(values)
  })

  it('appends a report endpoint only when asked', () => {
    const policy = directives(
      rendererContentSecurityPolicy({ reportUri: CSP_REPORT_PATH }),
    )
    expect(policy.get('report-uri')).toEqual([CSP_REPORT_PATH])
  })

  it('replaces the CSP meta of index.html for the dev server', () => {
    const html =
      '<head>\n<meta\n  http-equiv="Content-Security-Policy"\n  content="default-src \'none\'"\n/>\n<title>x</title></head>'
    const out = withCspMeta(html, "default-src 'self'")
    expect(out).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />',
    )
    expect(out).not.toContain("default-src 'none'")
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('inserts a CSP meta when index.html has none', () => {
    const out = withCspMeta(
      '<html><head><title>x</title></head></html>',
      "default-src 'self'",
    )
    expect(out).toContain(
      '<head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />',
    )
  })

  it('ships the production policy in the renderer index.html', () => {
    const html = readFileSync(
      resolve(__dirname, '../renderer/index.html'),
      'utf8',
    )
    const meta =
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(
        html,
      )
    expect(meta?.[1]).toBe(rendererContentSecurityPolicy())
  })
})
