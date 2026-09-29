import assert from 'node:assert/strict'
import test from 'node:test'

test('popup shows attached tabs and refreshes stale state after an action fails', async () => {
  const elements = new Map()
  for (const id of [
    'status',
    'pairing',
    'code',
    'connect',
    'pair',
    'attach',
    'disconnect',
    'forget',
    'origin',
    'message',
  ])
    elements.set(id, {
      textContent: '',
      hidden: false,
      disabled: false,
      listeners: new Map(),
      addEventListener(kind, listener) {
        this.listeners.set(kind, listener)
      },
    })
  const previousDocument = globalThis.document
  const previousChrome = globalThis.chrome
  const previousSetInterval = globalThis.setInterval
  let attached = 0
  let disconnected = false
  const permissions = []
  globalThis.document = {
    getElementById: (id) => elements.get(id),
  }
  globalThis.setInterval = () => 1
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 7, url: 'http://127.0.0.1:8765/' }],
    },
    permissions: {
      request: async (scope) => {
        permissions.push(scope)
        return true
      },
    },
    runtime: {
      sendMessage: async (message) => {
        if (disconnected && message.kind === 'attach')
          return { ok: false, message: 'Pair and connect to Emperor first' }
        if (disconnected && message.kind === 'status')
          return {
            ok: true,
            value: {
              status: 'disconnected',
              connected: false,
              paired: true,
              attached: 0,
              currentTabAttached: false,
            },
          }
        if (message.kind === 'attach') attached += 1
        return {
          ok: true,
          value: {
            status: 'connected',
            connected: true,
            paired: true,
            attached,
            currentTabAttached: attached > 0,
          },
        }
      },
    },
  }
  try {
    await import(`../popup.js?test=${Date.now()}`)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(
      elements.get('origin').textContent,
      '当前网站：http://127.0.0.1:8765 · 标签页未连接',
    )
    await elements.get('attach').listeners.get('click')()
    assert.deepEqual(permissions, [{ origins: ['http://127.0.0.1:8765/*'] }])
    assert.equal(
      elements.get('status').textContent,
      '已连接 Emperor · 1 个标签页',
    )
    assert.equal(elements.get('message').textContent, '当前标签页已连接')
    assert.equal(
      elements.get('origin').textContent,
      '当前网站：http://127.0.0.1:8765 · 标签页已连接',
    )
    assert.equal(elements.get('attach').textContent, '重新连接当前标签页')

    disconnected = true
    await elements.get('attach').listeners.get('click')()
    assert.equal(elements.get('status').textContent, '未连接 Emperor')
    assert.equal(elements.get('attach').hidden, true)
    assert.equal(
      elements.get('message').textContent,
      'Pair and connect to Emperor first',
    )
  } finally {
    globalThis.document = previousDocument
    globalThis.chrome = previousChrome
    globalThis.setInterval = previousSetInterval
  }
})

test('popup shows a pairing approved in Emperor while it stays open', async () => {
  const elements = new Map()
  for (const id of [
    'status',
    'pairing',
    'code',
    'connect',
    'pair',
    'attach',
    'disconnect',
    'forget',
    'origin',
    'message',
  ])
    elements.set(id, { textContent: '', hidden: false, addEventListener() {} })

  const previousDocument = globalThis.document
  const previousChrome = globalThis.chrome
  const previousSetInterval = globalThis.setInterval
  let tick
  let approved = false
  globalThis.setInterval = (callback) => {
    tick = callback
    return 1
  }
  globalThis.document = { getElementById: (id) => elements.get(id) }
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 7, url: 'http://127.0.0.1:8765/' }] },
    runtime: {
      sendMessage: async () => ({
        ok: true,
        value: approved
          ? {
              status: 'connected',
              connected: true,
              paired: true,
              attached: 0,
              currentTabAttached: false,
            }
          : {
              status: 'pairing',
              connected: false,
              paired: false,
              attached: 0,
              pairingCode: '096351',
              currentTabAttached: false,
            },
      }),
    },
  }
  try {
    await import(`../popup.js?test=${Date.now()}-approval`)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(elements.get('status').textContent, '等待 Emperor 确认配对')
    approved = true
    if (tick) await tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(elements.get('status').textContent, '已连接 Emperor')
    assert.equal(elements.get('pairing').hidden, true)
    assert.equal(elements.get('attach').hidden, false)
  } finally {
    globalThis.document = previousDocument
    globalThis.chrome = previousChrome
    globalThis.setInterval = previousSetInterval
  }
})
