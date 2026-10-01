import assert from 'node:assert/strict'
import test from 'node:test'

const IDS = [
  'step-sites',
  'step-pair',
  'allow',
  'pair',
  'code',
  'status',
  'message',
  'done',
]
let loads = 0

function element() {
  return {
    textContent: '',
    hidden: false,
    disabled: false,
    dataset: {},
    listeners: new Map(),
    addEventListener(kind, listener) {
      this.listeners.set(kind, listener)
    },
  }
}

/**
 * Loads welcome.js over fake elements. `worker(message)` answers the
 * service worker's replies; `sites` is the current site grant and
 * `grant` what the permission prompt answers.
 */
async function openWelcome({ worker, sites = false, grant = true }) {
  const elements = new Map(IDS.map((id) => [id, element()]))
  const requests = []
  const sent = []
  let tick = null
  const previous = {
    document: globalThis.document,
    chrome: globalThis.chrome,
    setInterval: globalThis.setInterval,
  }
  globalThis.document = { getElementById: (id) => elements.get(id) }
  globalThis.setInterval = (callback) => {
    tick = callback
    return 1
  }
  const state = { sites }
  globalThis.chrome = {
    permissions: {
      contains: async () => state.sites,
      request: (scope) => {
        requests.push(scope)
        state.sites = grant
        return Promise.resolve(grant)
      },
    },
    runtime: {
      sendMessage: async (message) => {
        sent.push(message.kind)
        return worker(message)
      },
    },
  }
  await import(`../welcome.js?welcome-${++loads}`)
  await settle()
  return {
    el: (id) => elements.get(id),
    requests,
    sent,
    tick: async () => {
      await tick?.()
      await settle()
    },
    restore() {
      globalThis.document = previous.document
      globalThis.chrome = previous.chrome
      globalThis.setInterval = previous.setInterval
    },
  }
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const unpaired = {
  status: 'unpaired',
  detail: '',
  pairingCode: null,
  paired: false,
  connected: false,
}

test('asks for every site inside the click, then pairs and shows the code', async () => {
  let pairing = false
  const page = await openWelcome({
    worker: ({ kind }) => {
      if (kind === 'pair') pairing = true
      return {
        ok: true,
        value: pairing
          ? { ...unpaired, status: 'pairing', pairingCode: '482913' }
          : unpaired,
      }
    },
  })
  try {
    assert.equal(page.el('step-sites').dataset.state, 'now')
    assert.equal(page.el('step-pair').dataset.state, 'todo')
    assert.equal(page.el('allow').hidden, false)
    assert.equal(page.el('pair').hidden, true)
    const click = page.el('allow').listeners.get('click')
    click()
    // The browser only shows the prompt for a request made in the gesture.
    assert.deepEqual(page.requests, [
      { origins: ['https://*/*', 'http://*/*'] },
    ])
    await settle()
    assert.ok(page.sent.includes('pair'))
    assert.equal(page.el('code').textContent, '482 913')
    assert.equal(page.el('code').hidden, false)
    assert.equal(page.el('step-sites').dataset.state, 'done')
    assert.equal(page.el('step-pair').dataset.state, 'now')
    assert.equal(page.el('allow').hidden, true)
    assert.match(page.el('status').textContent, /Emperor/)
  } finally {
    page.restore()
  }
})

test('shows the finished state once Emperor approved the pairing', async () => {
  let approved = false
  const page = await openWelcome({
    sites: true,
    worker: () => ({
      ok: true,
      value: approved
        ? { ...unpaired, status: 'connected', paired: true, connected: true }
        : { ...unpaired, status: 'pairing', pairingCode: '096351' },
    }),
  })
  try {
    assert.equal(page.el('done').hidden, true)
    assert.equal(page.el('code').textContent, '096 351')
    approved = true
    await page.tick()
    assert.equal(page.el('done').hidden, false)
    assert.equal(page.el('step-pair').dataset.state, 'done')
    assert.equal(page.el('code').hidden, true)
    assert.equal(page.el('status').textContent, '已连接 Emperor')
  } finally {
    page.restore()
  }
})

test('says how to fix it when Emperor cannot be reached', async () => {
  const page = await openWelcome({
    worker: ({ kind }) =>
      kind === 'pair'
        ? { ok: false, message: 'Native host disconnected' }
        : { ok: true, value: unpaired },
  })
  try {
    page.el('allow').listeners.get('click')()
    await settle()
    assert.match(page.el('message').textContent, /打开 Emperor/)
    // Sites are allowed now; connecting again is one click away.
    assert.equal(page.el('pair').hidden, false)
  } finally {
    page.restore()
  }
})

test('a refused site prompt does not start pairing', async () => {
  const page = await openWelcome({
    grant: false,
    worker: () => ({ ok: true, value: unpaired }),
  })
  try {
    page.el('allow').listeners.get('click')()
    await settle()
    assert.ok(!page.sent.includes('pair'))
    assert.match(page.el('message').textContent, /允许访问网站/)
    assert.equal(page.el('step-sites').dataset.state, 'now')
  } finally {
    page.restore()
  }
})

test('with sites already allowed, connecting again is a single button', async () => {
  const page = await openWelcome({
    sites: true,
    worker: ({ kind }) => ({
      ok: true,
      value:
        kind === 'pair'
          ? { ...unpaired, status: 'pairing', pairingCode: '123456' }
          : { ...unpaired, detail: 'Emperor 不再认识这个配对，请重新连接' },
    }),
  })
  try {
    assert.equal(page.el('allow').hidden, true)
    assert.equal(page.el('pair').hidden, false)
    assert.match(page.el('message').textContent, /重新连接/)
    await page.el('pair').listeners.get('click')()
    await settle()
    assert.ok(page.sent.includes('pair'))
    assert.equal(page.el('code').textContent, '123 456')
  } finally {
    page.restore()
  }
})
