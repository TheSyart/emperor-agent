import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXTENSION_ID,
  PAIRING_ID,
  fakeBrowser,
  newSecret,
  waitUntil,
  withNavigator,
} from './fake-main.js'

const WELCOME = `chrome-extension://${EXTENSION_ID}/welcome.html`
let loads = 0

/** A fresh service worker module over `browser.chrome`. */
async function startWorker(browser) {
  globalThis.chrome = browser.chrome
  await import(`../service-worker.js?lifecycle-${++loads}`)
}

function status(browser, path) {
  return browser.page({ kind: 'status' }, path).then((reply) => reply.value)
}

test.afterEach(() => {
  delete globalThis.chrome
})

test('a first install opens the onboarding page; an update does not', async () => {
  const browser = fakeBrowser()
  await startWorker(browser)
  browser.installed.fire({ reason: 'update', previousVersion: '0.1.0' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(browser.state.created, [])
  browser.installed.fire({ reason: 'install' })
  await waitUntil(() => browser.state.created.length === 1, 'welcome tab')
  assert.deepEqual(browser.state.created, [WELCOME])
})

test('the onboarding page may drive pairing, and the pairing says which browser it is', async () => {
  const restore = withNavigator({
    userAgent:
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150.0 Safari/537.36 Edg/150.0',
    userAgentData: {
      brands: [
        { brand: 'Chromium', version: '150' },
        { brand: 'Microsoft Edge', version: '150' },
      ],
    },
  })
  try {
    const browser = fakeBrowser()
    await startWorker(browser)
    await waitUntil(
      async () =>
        (await status(browser, 'welcome.html'))?.status === 'unpaired',
      'unpaired worker',
    )
    // Pages other than the popup and the onboarding page are refused.
    const stranger = await browser.page({ kind: 'status' }, 'other.html')
    assert.equal(stranger, undefined)
    const started = await browser.page({ kind: 'pair' }, 'welcome.html')
    assert.equal(started.ok, true)
    assert.match(started.value.pairingCode, /^\d{6}$/)
    assert.equal(browser.state.pairBegin.browser, 'edge')
    await waitUntil(
      async () => (await status(browser, 'welcome.html')).connected,
      'connected worker',
    )
    const ready = browser.state.observed.find(
      (frame) => frame.type === 'event' && frame.name === 'bridge.ready',
    )
    assert.equal(ready.data.version, '0.2.0')
    assert.equal(ready.data.browser, 'edge')
  } finally {
    restore()
  }
})

test('a pairing Emperor no longer knows is forgotten and onboarding starts again', async () => {
  const browser = fakeBrowser({
    pairing: { pairingId: PAIRING_ID, secret: newSecret() },
    authError: 'PAIRING_UNKNOWN',
  })
  await startWorker(browser)
  await waitUntil(
    () => browser.state.created.length === 1,
    'the onboarding page to open',
  )
  assert.deepEqual(browser.state.created, [WELCOME])
  assert.equal(browser.state.stored.pairing, undefined)
  const now = await status(browser)
  assert.equal(now.status, 'unpaired')
  assert.equal(now.paired, false)
  assert.match(now.detail, /重新/)
  assert.equal(browser.connected, false)
})

test('an onboarding page that is already open is brought forward instead', async () => {
  const browser = fakeBrowser({
    pairing: { pairingId: PAIRING_ID, secret: newSecret() },
    authError: 'PAIRING_UNKNOWN',
    tabs: [
      { id: 7, windowId: 2, url: 'https://example.com/' },
      { id: 8, windowId: 2, url: WELCOME },
    ],
  })
  await startWorker(browser)
  await waitUntil(
    () => browser.state.activated.length === 1,
    'the open onboarding tab',
  )
  assert.deepEqual(browser.state.activated, [[8, { active: true }]])
  assert.deepEqual(browser.state.created, [])
})

test('Emperor can remove the extension and reload it after an upgrade', async () => {
  const browser = fakeBrowser({
    pairing: { pairingId: PAIRING_ID, secret: newSecret() },
  })
  await startWorker(browser)
  await waitUntil(async () => (await status(browser)).connected, 'connected')

  const reload = await browser.request('extension.reload')
  assert.deepEqual(reload, {
    type: 'response',
    id: reload.id,
    ok: true,
    result: { reloading: true },
  })
  await waitUntil(() => browser.state.reloaded === 1, 'runtime.reload')

  const removal = await browser.request('extension.uninstall')
  assert.equal(removal.ok, true)
  assert.deepEqual(removal.result, { uninstalling: true })
  await waitUntil(
    () => browser.state.uninstalled.length === 1,
    'management.uninstallSelf',
  )
  assert.deepEqual(browser.state.uninstalled, [{ showConfirmDialog: false }])
  assert.equal(browser.state.stored.pairing, undefined)
})

test('a pairing revoked in Emperor is forgotten quietly, without onboarding', async () => {
  const browser = fakeBrowser({
    pairing: { pairingId: PAIRING_ID, secret: newSecret() },
  })
  await startWorker(browser)
  await waitUntil(async () => (await status(browser)).connected, 'connected')
  // A revocation for some other pairing is not ours to act on.
  await browser.event('pair.revoked', { pairingId: 'pairing_other000' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(browser.state.stored.pairing)
  await browser.event('pair.revoked', { pairingId: PAIRING_ID })
  await waitUntil(
    () => browser.state.stored.pairing === undefined,
    'the pairing to be removed',
  )
  const now = await status(browser)
  assert.equal(now.status, 'unpaired')
  assert.equal(now.connected, false)
  assert.match(now.detail, /Emperor/)
  assert.deepEqual(browser.state.created, [])
  // No retry: the worker stays disconnected.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(browser.connected, false)
})
