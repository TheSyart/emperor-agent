import { describe, expect, it } from 'vitest'
import type {
  BrowserExtensionStatus,
  BrowserPairingStatus,
} from '../../../../../shared/ipc-contract'
import {
  connectionRows,
  extensionAddresses,
  formatCode,
  heroView,
  installSteps,
  loadedElsewhere,
  setupNeeded,
} from './chromeEdgeModel'

const ID = 'A'.repeat(21) + 'Q'

function pairing(
  overrides: Partial<BrowserPairingStatus> = {},
): BrowserPairingStatus {
  return {
    bridgeListening: true,
    pendingPairings: [],
    pairedConnections: [],
    attachedTabs: 0,
    pairings: [],
    ...overrides,
  }
}

function extension(
  overrides: {
    ready?: boolean
    chrome?: Partial<BrowserExtensionStatus['browsers'][number]>
    edge?: Partial<BrowserExtensionStatus['browsers'][number]>
  } = {},
): BrowserExtensionStatus {
  return {
    folder: {
      path: '/Users/a/.emperor/browser-extension',
      displayPath: '~/.emperor/browser-extension',
      ready: overrides.ready ?? false,
      version: overrides.ready ? '0.2.0' : null,
    },
    bundledVersion: '0.2.0',
    browsers: [
      {
        browser: 'chrome',
        name: 'Google Chrome',
        present: true,
        extension: 'none',
        developerMode: false,
        hostRegistered: false,
        ...overrides.chrome,
      },
      {
        browser: 'edge',
        name: 'Microsoft Edge',
        present: false,
        extension: 'none',
        developerMode: false,
        hostRegistered: false,
        ...overrides.edge,
      },
    ],
  }
}

const connected = pairing({
  pairedConnections: [ID],
  attachedTabs: 2,
  pairings: [
    {
      pairingId: ID,
      browser: 'chrome',
      connected: true,
      tabs: 2,
      createdAt: '2026-09-30T08:00:00.000Z',
    },
  ],
})

const steps = (p: BrowserPairingStatus, e: BrowserExtensionStatus | null) =>
  installSteps(p, e).map((step) => `${step.key}:${step.state}`)

describe('Chrome 和 Edge page model', () => {
  it('heads the page by what is going on', () => {
    expect(heroView(pairing(), extension())).toMatchObject({
      tone: 'neutral',
      badge: '未安装扩展',
      description: '让 Emperor 操作你在自己浏览器里连接的标签页',
      installLabel: '安装扩展程序',
      installPrimary: true,
      canRemove: false,
    })
    // The folder alone is not an installed extension.
    expect(heroView(pairing(), extension({ ready: true })).badge).toBe(
      '未安装扩展',
    )
    expect(
      heroView(
        pairing(),
        extension({ ready: true, chrome: { extension: 'loaded' } }),
      ),
    ).toMatchObject({
      badge: '已安装 · 未连接',
      description: '扩展 0.2.0',
      installLabel: '重新安装扩展程序',
      installPrimary: false,
      canRemove: true,
    })
    // An extension loaded from a checkout is installed too.
    expect(
      heroView(
        pairing(),
        extension({ chrome: { loadedFrom: '~/src/desktop/extension' } }),
      ),
    ).toMatchObject({ badge: '已安装 · 未连接', canRemove: true })
    expect(heroView(connected, extension({ ready: true }))).toMatchObject({
      tone: 'ok',
      badge: '已连接 1 个浏览器',
      dot: true,
    })
    expect(
      heroView(
        pairing({ pendingPairings: [pendingItem()] }),
        extension({ ready: true }),
      ),
    ).toMatchObject({ tone: 'warn', badge: '有配对等待确认' })
    // A connected browser stays the state while another one asks to pair.
    expect(
      heroView(
        { ...connected, pendingPairings: [pendingItem()] },
        extension({ ready: true }),
      ),
    ).toMatchObject({ tone: 'ok', badge: '已连接 1 个浏览器' })
  })

  it('ticks each install step and marks the first open one', () => {
    expect(steps(pairing(), extension())).toEqual([
      'folder:now',
      'developer:todo',
      'load:todo',
      'connect:todo',
    ])
    expect(steps(pairing(), extension({ ready: true }))).toEqual([
      'folder:done',
      'developer:now',
      'load:todo',
      'connect:todo',
    ])
    // 开发者模式 already on before the folder exists.
    expect(
      steps(pairing(), extension({ chrome: { developerMode: true } })),
    ).toEqual(['folder:now', 'developer:done', 'load:todo', 'connect:todo'])
    expect(
      steps(
        pairing(),
        extension({ ready: true, chrome: { extension: 'loaded' } }),
      ),
    ).toEqual(['folder:done', 'developer:done', 'load:done', 'connect:now'])
    // Switched off counts as not loaded yet.
    expect(
      steps(
        pairing(),
        extension({
          ready: true,
          chrome: { extension: 'disabled', developerMode: true },
        }),
      ),
    ).toEqual(['folder:done', 'developer:done', 'load:now', 'connect:todo'])
    // A pairing request is proof enough, before Chrome writes its files.
    expect(
      steps(
        pairing({ pendingPairings: [pendingItem()] }),
        extension({ ready: true }),
      ),
    ).toEqual(['folder:done', 'developer:done', 'load:done', 'connect:now'])
    expect(steps(connected, null)).toEqual([
      'folder:done',
      'developer:done',
      'load:done',
      'connect:done',
    ])
  })

  it('keeps the install card until a browser is paired', () => {
    expect(setupNeeded(pairing())).toBe(true)
    expect(setupNeeded(pairing({ pendingPairings: [pendingItem()] }))).toBe(
      true,
    )
    expect(setupNeeded(connected)).toBe(false)
    expect(
      setupNeeded(
        pairing({
          pairings: [
            {
              pairingId: ID,
              browser: 'chrome',
              connected: false,
              tabs: 0,
              createdAt: null,
            },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('lists Chrome and Edge, with saved pairings whose browser is closed', () => {
    expect(
      connectionRows(connected, extension({ ready: true }), false),
    ).toEqual([
      {
        key: ID,
        title: 'Google Chrome',
        description: '已连接 · 2 个可操作标签页',
        action: 'disconnect',
        pairingId: ID,
      },
      {
        key: 'edge',
        title: 'Microsoft Edge',
        description: '这台 Mac 没有安装 Edge',
      },
    ])
    const closed = 'B'.repeat(21) + 'A'
    const other = 'C'.repeat(21) + 'g'
    const rows = connectionRows(
      pairing({
        pairings: [
          {
            pairingId: closed,
            browser: 'edge',
            connected: false,
            tabs: 0,
            createdAt: '2026-09-28T08:00:00.000Z',
          },
          {
            pairingId: other,
            browser: null,
            connected: false,
            tabs: 0,
            createdAt: null,
          },
        ],
      }),
      extension({ edge: { present: true } }),
      false,
    )
    expect(rows).toEqual([
      {
        key: 'chrome',
        title: 'Google Chrome',
        description: '未安装扩展',
        action: 'setup',
      },
      {
        key: closed,
        title: 'Microsoft Edge',
        description: '未连接 · 浏览器打开后自动连接',
        action: 'revoke',
        pairingId: closed,
      },
      {
        key: other,
        title: 'Chrome 或 Edge',
        description: '未连接 · 浏览器打开后自动连接',
        action: 'revoke',
        pairingId: other,
      },
    ])
    // No 安装步骤 button while the steps are on screen.
    expect(connectionRows(pairing(), extension(), true)[0]).not.toHaveProperty(
      'action',
    )
    // A loaded or switched-off extension says what to do next.
    const [loaded] = connectionRows(
      pairing(),
      extension({ chrome: { extension: 'loaded' } }),
      true,
    )
    expect(loaded?.description).toContain('连接 Emperor')
    const [off] = connectionRows(
      pairing(),
      extension({ chrome: { extension: 'disabled' } }),
      true,
    )
    expect(off?.description).toContain('已停用')
  })

  it('tells two pairings of one browser apart by date', () => {
    const second = 'D'.repeat(21) + 'w'
    const rows = connectionRows(
      pairing({
        pairings: [
          {
            pairingId: ID,
            browser: 'chrome',
            connected: true,
            tabs: 1,
            createdAt: '2026-09-30T08:00:00.000Z',
          },
          {
            pairingId: second,
            browser: 'chrome',
            connected: false,
            tabs: 0,
            createdAt: '2026-10-01T08:00:00.000Z',
          },
        ],
      }),
      extension(),
      false,
    )
    expect(rows.slice(0, 2).map((row) => row.description)).toEqual([
      '已连接 · 1 个可操作标签页 · 配对于 9月30日',
      '未连接 · 浏览器打开后自动连接 · 配对于 10月1日',
    ])
  })

  it('offers the extensions page address of each browser here', () => {
    expect(extensionAddresses(extension())).toEqual([
      { browser: 'chrome', url: 'chrome://extensions' },
    ])
    expect(
      extensionAddresses(
        extension({ chrome: { present: false }, edge: { present: true } }),
      ),
    ).toEqual([{ browser: 'edge', url: 'edge://extensions' }])
    expect(
      extensionAddresses(extension({ edge: { present: true } })).map(
        (item) => item.url,
      ),
    ).toEqual(['chrome://extensions', 'edge://extensions'])
    expect(extensionAddresses(null)).toEqual([
      { browser: 'chrome', url: 'chrome://extensions' },
    ])
  })

  it('finds an extension loaded from another folder, and formats codes', () => {
    expect(loadedElsewhere(extension())).toBeNull()
    expect(
      loadedElsewhere(
        extension({ chrome: { loadedFrom: '~/src/desktop/extension' } }),
      ),
    ).toEqual({ name: 'Google Chrome', path: '~/src/desktop/extension' })
    expect(formatCode('482913')).toBe('482 913')
  })
})

function pendingItem() {
  return {
    pairingId: 'P'.repeat(21) + 'Q',
    extensionId: 'oobcokoopgkhlhpohfdpelkafiidojjn',
    code: '482913',
    displayed: true,
    browser: 'chrome' as const,
  }
}
