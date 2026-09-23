import { describe, expect, it } from 'vitest'
import {
  BROWSER_INPUT_MAX_LENGTH,
  BROWSER_INPUT_REASONS,
  browserExternalOpenEligible,
  browserNavigationAllowed,
  isLocalHostname,
  normalizeBrowserInput,
  normalizedBrowserBounds,
} from './browser-view-policy'

function accepted(input: unknown): string {
  const result = normalizeBrowserInput(input)
  if (!result.ok) throw new Error(`rejected ${String(input)}: ${result.reason}`)
  return result.url
}

function rejection(input: unknown): string {
  const result = normalizeBrowserInput(input)
  if (result.ok) throw new Error(`accepted ${String(input)} as ${result.url}`)
  return result.reason
}

describe('normalizeBrowserInput', () => {
  it('adds http:// to bare addresses of this machine', () => {
    expect(accepted('localhost')).toBe('http://localhost/')
    expect(accepted('localhost:5173')).toBe('http://localhost:5173/')
    expect(accepted('LOCALHOST:5173/app?x=1#top')).toBe(
      'http://localhost:5173/app?x=1#top',
    )
    expect(accepted('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
    expect(accepted('127.1:3000')).toBe('http://127.0.0.1:3000/')
    expect(accepted('[::1]:8080')).toBe('http://[::1]:8080/')
    expect(accepted('[::ffff:127.0.0.1]:80/x')).toBe('http://[::ffff:7f00:1]/x')
    expect(accepted('0.0.0.0:5173')).toBe('http://0.0.0.0:5173/')
    expect(accepted('app.localhost:4000')).toBe('http://app.localhost:4000/')
  })

  it('adds https:// to every other bare host', () => {
    expect(accepted('example.com')).toBe('https://example.com/')
    expect(accepted('example.com/path?q=1#frag')).toBe(
      'https://example.com/path?q=1#frag',
    )
    expect(accepted('example.com:8443/x')).toBe('https://example.com:8443/x')
    expect(accepted('192.168.1.10:8080')).toBe('https://192.168.1.10:8080/')
    expect(accepted('localhost.example.com')).toBe(
      'https://localhost.example.com/',
    )
    expect(accepted('127.0.0.1.nip.io')).toBe('https://127.0.0.1.nip.io/')
    expect(accepted('example.com/some path')).toBe(
      'https://example.com/some%20path',
    )
    expect(accepted('例子.测试')).toBe('https://xn--fsqu00a.xn--0zwm56d/')
  })

  it('keeps explicit http and https URLs as typed', () => {
    expect(accepted('  https://example.com/docs  ')).toBe(
      'https://example.com/docs',
    )
    expect(accepted('http://example.com')).toBe('http://example.com/')
    expect(accepted('HTTPS://EXAMPLE.COM/A')).toBe('https://example.com/A')
    expect(accepted('https://localhost:5173')).toBe('https://localhost:5173/')
    expect(accepted('http://[::1]:5173/')).toBe('http://[::1]:5173/')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'javascript:1',
    'data:text/html,<script>alert(1)</script>',
    'data:5000',
    'blob:https://example.com/0f3c6e4e',
    'file:///etc/passwd',
    'file:/etc/passwd',
    'FILE://host/share',
    'about:blank',
    'about:srcdoc',
    'chrome://settings',
    'chrome-extension://abcdefghijklmnop/page.html',
    'chrome-untrusted://terminal',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com',
    'filesystem:https://example.com/temporary/x',
    'vbscript:msgbox(1)',
    'app://bundle/index.html',
    'mailto:someone@example.com',
    'tel:123',
    'ftp://example.com/file',
    'ws://localhost:8080',
    'wss://example.com/socket',
    'emperor://open',
    'localhost:dev',
  ])('rejects the non-web scheme in %s', (input) => {
    expect(rejection(input)).toBe(BROWSER_INPUT_REASONS.scheme)
  })

  it.each([
    'user:pass@example.com',
    'user@example.com',
    'token@localhost:5173',
    'http://user:pass@example.com/',
    'https://token@example.com/',
    'https://example.com@evil.example/',
    'https://:secret@example.com/',
  ])('rejects credentials in %s', (input) => {
    expect(rejection(input)).toBe(BROWSER_INPUT_REASONS.credentials)
  })

  it.each([
    '/etc/passwd',
    '//example.com',
    '\\\\server\\share',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'example.com/\u0000',
    'exa\u007fmple.com',
    'hello world',
    'http://',
    'https://',
    'http://999.999.999.999/',
    'localhost:99999',
    ':8080',
    '?q=1',
    '#top',
    '::1',
  ])('rejects unparseable input %j', (input) => {
    expect(rejection(input)).toBe(BROWSER_INPUT_REASONS.invalid)
  })

  it('rejects non-string and empty input', () => {
    for (const input of [undefined, null, 42, {}, ['https://example.com']])
      expect(rejection(input)).toBe(BROWSER_INPUT_REASONS.invalid)
    expect(rejection('')).toBe(BROWSER_INPUT_REASONS.empty)
    expect(rejection(' \n\t ')).toBe(BROWSER_INPUT_REASONS.empty)
  })

  it(`accepts at most ${BROWSER_INPUT_MAX_LENGTH} characters`, () => {
    const prefix = 'https://example.com/'
    const longest =
      prefix + 'a'.repeat(BROWSER_INPUT_MAX_LENGTH - prefix.length)
    expect(accepted(longest)).toBe(longest)
    expect(accepted(`   ${longest}   `)).toBe(longest)
    expect(rejection(`${longest}a`)).toBe(BROWSER_INPUT_REASONS.tooLong)
    // Percent-encoding may lengthen the URL past the limit.
    const encoded =
      prefix + 'é'.repeat(BROWSER_INPUT_MAX_LENGTH - prefix.length)
    expect(rejection(encoded)).toBe(BROWSER_INPUT_REASONS.tooLong)
  })
})

describe('browser view navigation guard', () => {
  it('allows credential-free http(s) navigations only', () => {
    for (const target of [
      'https://example.com/next',
      'http://localhost:5173/route',
      'http://127.0.0.1:4173/',
      'http://[::1]:3000/',
    ])
      expect(browserNavigationAllowed(target)).toBe(true)
    for (const target of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/0f3c6e4e',
      'about:blank',
      'chrome://settings',
      'chrome-extension://abc/page.html',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'app://bundle/index.html',
      'emperor://open',
      'mailto:someone@example.com',
      'https://token@example.com/',
      'http://user:pass@localhost:5173/',
      'not a url',
      '',
      undefined,
      42,
    ])
      expect(browserNavigationAllowed(target)).toBe(false)
  })

  it('hands only remote credential-free popups to the system browser', () => {
    expect(browserExternalOpenEligible('https://example.com/docs')).toBe(true)
    expect(browserExternalOpenEligible('http://example.com/')).toBe(true)
    for (const target of [
      'http://localhost:5173/',
      'http://127.0.0.1:5173/',
      'http://[::1]:5173/',
      'http://0.0.0.0:5173/',
      'http://app.localhost/',
      'https://token@example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank',
      'custom-scheme://launch',
    ])
      expect(browserExternalOpenEligible(target)).toBe(false)
  })

  it('recognizes the parser forms of this machine', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'dev.localhost',
      '127.0.0.1',
      '127.255.255.254',
      '0.0.0.0',
      '[::1]',
      '[::]',
      '[::ffff:7f00:1]',
      '[::ffff:0:0]',
    ])
      expect(isLocalHostname(host)).toBe(true)
    for (const host of [
      'example.com',
      'localhost.example.com',
      '128.0.0.1',
      '10.0.0.1',
      '[::2]',
      '[::ffff:a00:1]',
      '[fe80::1]',
    ])
      expect(isLocalHostname(host)).toBe(false)
  })
})

describe('browser view bounds', () => {
  it('accepts bounded renderer rectangles', () => {
    expect(
      normalizedBrowserBounds({ x: 2.4, y: 3.6, width: 640, height: 480 }),
    ).toEqual({ x: 2, y: 4, width: 640, height: 480 })
    expect(
      normalizedBrowserBounds({ x: -5, y: -1, width: 640, height: 480 }),
    ).toEqual({ x: 0, y: 0, width: 640, height: 480 })
  })

  it('rejects rectangles that cannot host a page', () => {
    for (const value of [
      null,
      undefined,
      'bounds',
      [0, 0, 640, 480],
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 640 },
      { x: 0, y: 0, width: 20_000, height: 480 },
      { x: Number.NaN, y: 0, width: 640, height: 480 },
    ])
      expect(normalizedBrowserBounds(value)).toBeNull()
  })
})
