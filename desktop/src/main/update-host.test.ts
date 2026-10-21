import { describe, expect, it } from 'vitest'
import type {
  ElectronRequestLike,
  ElectronRequestOptions,
  ElectronResponseLike,
} from './public-http-client'
import {
  createElectronUpdateTransport,
  updateHostOptions,
  type UpdateHostInput,
} from './update-host'

// REL-02 in main: when Core may check for updates, where a verified DMG
// goes, and the transport (Electron's net without cookies or credentials).

function input(overrides: Partial<UpdateHostInput> = {}): UpdateHostInput {
  return {
    env: {},
    isPackaged: true,
    packagedSmoke: false,
    arch: 'arm64',
    electronVersion: '42.2.0',
    downloadsDir: '/Users/me/Downloads',
    tempDir: '/private/var/folders/x/T',
    reveal: () => {},
    markQuarantine: async () => {},
    request: () => {
      throw new Error('no request in this test')
    },
    log: () => {},
    ...overrides,
  }
}

describe('update host options', () => {
  it('the packaged app checks GitHub; Downloads, Finder and the mark come from main', () => {
    const shown: string[] = []
    const options = updateHostOptions(
      input({ reveal: (path) => shown.push(path) }),
    )
    expect(options).toMatchObject({
      automatic: true,
      disabledReason: null,
      feedOverride: null,
      arch: 'arm64',
      electronVersion: '42.2.0',
      downloadsDir: '/Users/me/Downloads',
      tempDir: '/private/var/folders/x/T',
    })
    options.reveal('/Users/me/Downloads/a.dmg')
    expect(shown).toEqual(['/Users/me/Downloads/a.dmg'])
    expect(typeof options.transport).toBe('function')
    expect(options.markQuarantine).toBeTypeOf('function')
  })

  it('a development build checks only with a test feed; the packaged smoke never', () => {
    expect(updateHostOptions(input({ isPackaged: false }))).toMatchObject({
      automatic: false,
      disabledReason: 'development',
    })
    expect(
      updateHostOptions(
        input({
          isPackaged: false,
          env: { EMPEROR_UPDATE_FEED_URL: 'http://127.0.0.1:9911/releases' },
        }),
      ),
    ).toMatchObject({
      automatic: true,
      disabledReason: null,
      feedOverride: 'http://127.0.0.1:9911/releases',
    })
    expect(updateHostOptions(input({ packagedSmoke: true }))).toMatchObject({
      automatic: false,
      disabledReason: 'smoke',
    })
  })

  it('EMPEROR_UPDATE_FEED_URL works in the packaged app only on loopback, and is logged', () => {
    const logs: string[] = []
    expect(
      updateHostOptions(
        input({
          env: { EMPEROR_UPDATE_FEED_URL: 'http://localhost:8765/releases' },
          log: (line) => logs.push(line),
        }),
      ).feedOverride,
    ).toBe('http://localhost:8765/releases')
    expect(logs.join('\n')).toContain('test update feed')
    logs.length = 0
    const refused = updateHostOptions(
      input({
        env: { EMPEROR_UPDATE_FEED_URL: 'https://evil.example/releases' },
        log: (line) => logs.push(line),
      }),
    )
    expect(refused).toMatchObject({ feedOverride: null, automatic: true })
    expect(logs.join('\n')).toContain('ignored')
  })

  it('development e2e: EMPEROR_E2E_DOWNLOADS_DIR replaces Downloads and Finder is not opened', () => {
    const shown: string[] = []
    const logs: string[] = []
    const options = updateHostOptions(
      input({
        isPackaged: false,
        env: {
          EMPEROR_UPDATE_FEED_URL: 'http://127.0.0.1:9911/releases',
          EMPEROR_E2E_DOWNLOADS_DIR: '/tmp/e2e-downloads',
        },
        reveal: (path) => shown.push(path),
        log: (line) => logs.push(line),
      }),
    )
    expect(options.downloadsDir).toBe('/tmp/e2e-downloads')
    options.reveal('/tmp/e2e-downloads/a.dmg')
    expect(shown).toEqual([])
    expect(logs).toContain('update reveal /tmp/e2e-downloads/a.dmg')
    // The packaged app ignores the e2e folder.
    expect(
      updateHostOptions(
        input({ env: { EMPEROR_E2E_DOWNLOADS_DIR: '/tmp/e2e-downloads' } }),
      ).downloadsDir,
    ).toBe('/Users/me/Downloads')
  })

  it('an Intel build asks for the x64 package', () => {
    expect(updateHostOptions(input({ arch: 'x64' })).arch).toBe('x64')
  })
})

describe('Electron update transport', () => {
  it('8 · net.request with no cookies, no credentials, manual redirects', async () => {
    const seen: ElectronRequestOptions[] = []
    const transport = createElectronUpdateTransport((options) => {
      seen.push(options)
      const handlers: Record<string, (...args: unknown[]) => void> = {}
      const request = {
        on(event: string, listener: (...args: unknown[]) => void) {
          handlers[event] = listener
          return request
        },
        end() {
          queueMicrotask(() =>
            handlers.response?.({
              statusCode: 200,
              headers: {},
              destroy() {},
              async *[Symbol.asyncIterator]() {
                yield new Uint8Array([91, 93])
              },
            } satisfies ElectronResponseLike),
          )
        },
        abort() {},
      }
      return request as unknown as ElectronRequestLike
    })
    const response = await transport({
      url: new URL(
        'https://api.github.com/repos/TheSyart/emperor-agent/releases',
      ),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Emperor-Agent/0.2.0',
      },
      signal: new AbortController().signal,
    })
    expect(response.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      url: 'https://api.github.com/repos/TheSyart/emperor-agent/releases',
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
    })
    expect(seen[0]!.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'Emperor-Agent/0.2.0',
    })
  })
})
