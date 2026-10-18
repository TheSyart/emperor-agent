import { describe, expect, it, vi } from 'vitest'
import {
  createTrustedRendererPolicy,
  UntrustedIpcCallerError,
  type IpcInvokeEventLike,
} from './trusted-renderer'

describe('trusted renderer policy', () => {
  it('trusts only the production app bundle host', () => {
    const policy = makePolicy()

    expect(policy.isTrustedUrl('app://bundle/index.html')).toBe(true)
    expect(policy.isTrustedUrl('app://bundle/chat/session-1')).toBe(true)
    expect(policy.isTrustedUrl('app://attachments/a/raw')).toBe(false)
    expect(policy.isTrustedUrl('app://bundle.evil.example/index.html')).toBe(
      false,
    )
    expect(policy.isTrustedUrl('https://example.com')).toBe(false)
  })

  it('trusts path changes on the exact configured development origin', () => {
    const policy = makePolicy({ developmentUrl: 'http://127.0.0.1:5173/' })

    expect(policy.isTrustedUrl('http://127.0.0.1:5173/chat')).toBe(true)
    expect(policy.isTrustedUrl('http://127.0.0.1:5174/chat')).toBe(false)
    expect(policy.isTrustedUrl('http://127.0.0.1.evil:5173/chat')).toBe(false)
    expect(policy.isTrustedUrl('https://127.0.0.1:5173/chat')).toBe(false)
  })

  it('rejects malformed and credential-bearing renderer URLs', () => {
    const policy = makePolicy()

    expect(policy.isTrustedUrl('not a url')).toBe(false)
    expect(policy.isTrustedUrl('app://user:secret@bundle/index.html')).toBe(
      false,
    )
  })

  it('prevents an external navigation and opens HTTP(S) in the system browser', async () => {
    const openExternal = vi.fn(async () => undefined)
    const policy = makePolicy({ openExternal })
    const event = { preventDefault: vi.fn() }

    policy.handleNavigation(event, 'https://example.com/docs')
    await Promise.resolve()

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('prevents non-HTTP navigation without dispatching an external opener', () => {
    const openExternal = vi.fn(async () => undefined)
    const policy = makePolicy({ openExternal })
    const event = { preventDefault: vi.fn() }

    policy.handleNavigation(event, 'file:///tmp/private.txt')

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('keeps the window on its document: an in-app link never reloads it (UI-4)', async () => {
    const openExternal = vi.fn(async () => undefined)
    const policy = makePolicy({ openExternal })
    const current = 'app://bundle/chat/session-1'

    // `[packages/core](packages/core)` resolved against the chat route.
    const relative = { preventDefault: vi.fn() }
    policy.handleNavigation(
      relative,
      'app://bundle/chat/packages/core',
      current,
    )
    const root = { preventDefault: vi.fn() }
    policy.handleNavigation(root, 'app://bundle/index.html', current)
    await Promise.resolve()

    expect(relative.preventDefault).toHaveBeenCalledOnce()
    expect(root.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still lets the document reload itself (dev server full reload)', () => {
    const policy = makePolicy({ developmentUrl: 'http://127.0.0.1:5173/' })
    const reload = { preventDefault: vi.fn() }
    const hashOnly = { preventDefault: vi.fn() }

    policy.handleNavigation(
      reload,
      'http://127.0.0.1:5173/chat/a',
      'http://127.0.0.1:5173/chat/a',
    )
    policy.handleNavigation(
      hashOnly,
      'app://bundle/chat/a#top',
      'app://bundle/chat/a',
    )

    expect(reload.preventDefault).not.toHaveBeenCalled()
    expect(hashOnly.preventDefault).not.toHaveBeenCalled()
  })

  it('blocks every subframe navigation and leaves the main frame to will-navigate', async () => {
    const openExternal = vi.fn(async () => undefined)
    const policy = makePolicy({ openExternal })
    const frame = { preventDefault: vi.fn() }
    const main = { preventDefault: vi.fn() }

    policy.handleFrameNavigation({
      ...frame,
      url: 'app://bundle/index.html',
      isMainFrame: false,
    })
    policy.handleFrameNavigation({
      ...main,
      url: 'https://example.com',
      isMainFrame: true,
    })
    await Promise.resolve()

    expect(frame.preventDefault).toHaveBeenCalledOnce()
    expect(main.preventDefault).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('always denies popup creation while forwarding eligible external URLs', async () => {
    const openExternal = vi.fn(async () => undefined)
    const policy = makePolicy({ openExternal })

    expect(policy.handleWindowOpen({ url: 'https://example.com' })).toEqual({
      action: 'deny',
    })
    expect(
      policy.handleWindowOpen({ url: 'javascript:alert(document.domain)' }),
    ).toEqual({ action: 'deny' })
    await Promise.resolve()

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('routes a user link through the browser settings when main supplies a router', async () => {
    const openExternal = vi.fn(async () => undefined)
    const openLink = vi.fn(async () => undefined)
    const policy = createTrustedRendererPolicy({
      productionUrl: 'app://bundle/index.html',
      mainWebContents: () => null,
      openExternal,
      openLink,
    })
    policy.handleWindowOpen({ url: 'http://localhost:5173/app' })
    policy.handleNavigation({ preventDefault: vi.fn() }, 'https://example.com')
    policy.handleWindowOpen({ url: 'file:///etc/hosts' })
    await Promise.resolve()
    expect(openLink.mock.calls).toEqual([
      ['http://localhost:5173/app'],
      ['https://example.com/'],
    ])
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('authorizes only the trusted top frame of the main webContents', () => {
    const mainWebContents = {}
    const policy = makePolicy({ mainWebContents: () => mainWebContents })
    const topFrame = frame('app://bundle/index.html')

    expect(() =>
      policy.authorizeIpc({ sender: mainWebContents, senderFrame: topFrame }),
    ).not.toThrow()
  })

  it('rejects remote, subframe, missing-frame, and wrong-webContents IPC callers', () => {
    const mainWebContents = {}
    const policy = makePolicy({ mainWebContents: () => mainWebContents })
    const trustedTop = frame('app://bundle/index.html')
    const remoteTop = frame('https://example.com')
    const subframe = {
      url: 'app://bundle/index.html',
      top: trustedTop,
    }
    const cases: IpcInvokeEventLike[] = [
      { sender: mainWebContents, senderFrame: remoteTop },
      { sender: mainWebContents, senderFrame: subframe },
      { sender: mainWebContents, senderFrame: null },
      { sender: {}, senderFrame: trustedTop },
    ]

    for (const event of cases)
      expect(() => policy.authorizeIpc(event)).toThrow(UntrustedIpcCallerError)
  })
})

function frame(url: string) {
  const value: { url: string; top: unknown } = { url, top: null }
  value.top = value
  return value
}

function makePolicy(
  overrides: Partial<Parameters<typeof createTrustedRendererPolicy>[0]> = {},
) {
  return createTrustedRendererPolicy({
    productionUrl: 'app://bundle/index.html',
    developmentUrl: null,
    mainWebContents: () => null,
    openExternal: async () => undefined,
    onExternalOpenError: () => undefined,
    ...overrides,
  })
}
