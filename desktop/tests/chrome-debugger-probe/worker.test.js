import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { setImmediate } from 'node:timers'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8')

test('debugger probe has no host grants or content injection', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'),
  )
  assert.deepEqual(manifest.permissions, ['activeTab', 'debugger', 'storage'])
  assert.equal(manifest.host_permissions, undefined)
  assert.equal(manifest.optional_host_permissions, undefined)
  assert.equal(manifest.content_scripts, undefined)
  assert.equal(source.includes('sendCommand'), false)
})

function fixture(url, failStorageSet = false, detachDuringStorage = false) {
  const calls = []
  const saved = {}
  let onMessage
  let onDetach
  const chrome = {
    tabs: { query: async () => [{ id: 17, url }] },
    storage: {
      session: {
        get: async () => ({ ...saved }),
        set: async (value) => {
          if (failStorageSet) throw new Error('storage unavailable')
          if (detachDuringStorage && Number.isInteger(value.tabId)) {
            onDetach({ tabId: value.tabId }, 'canceled_by_user')
            await new Promise((resolve) => setImmediate(resolve))
          }
          Object.assign(saved, value)
        },
        remove: async (key) => {
          delete saved[key]
        },
      },
    },
    debugger: {
      attach: async (target, version) => {
        calls.push(['attach', target.tabId, version])
      },
      detach: async (target) => {
        calls.push(['detach', target.tabId])
      },
      onDetach: {
        addListener: (listener) => {
          onDetach = listener
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (listener) => {
          onMessage = listener
        },
      },
    },
  }
  runInNewContext(source, { chrome, URL })
  return {
    calls,
    saved,
    onDetach: (...args) => onDetach(...args),
    request: (type) =>
      new Promise((resolve) => onMessage({ type }, {}, resolve)),
  }
}

test('debugger probe refuses every non-fixture origin before attaching', async () => {
  const probe = fixture('https://example.com/')
  const result = await probe.request('attach')
  assert.equal(result.error, '只允许本机测试页')
  assert.deepEqual(probe.calls, [])
})

test('debugger probe attaches only to the fixture tab and can detach', async () => {
  const probe = fixture('http://127.0.0.1:8765/index.html')
  assert.equal((await probe.request('attach')).attached, true)
  assert.deepEqual(probe.calls, [['attach', 17, '1.3']])
  assert.equal((await probe.request('detach')).attached, false)
  assert.deepEqual(probe.calls, [
    ['attach', 17, '1.3'],
    ['detach', 17],
  ])
})

test('debugger probe detaches if it cannot remember an attached tab', async () => {
  const probe = fixture('http://127.0.0.1:8765/', true)
  const result = await probe.request('attach')
  assert.equal(result.error, 'storage unavailable')
  assert.deepEqual(probe.calls, [
    ['attach', 17, '1.3'],
    ['detach', 17],
  ])
})

test('debugger probe clears its session when Chrome cancels the attachment', async () => {
  const probe = fixture('http://127.0.0.1:8765/')
  await probe.request('attach')
  probe.onDetach({ tabId: 17 }, 'canceled_by_user')
  await new Promise((resolve) => setImmediate(resolve))
  const status = await probe.request('status')
  assert.equal(status.attached, false)
  assert.equal(status.tabId, null)
  assert.equal(status.lastDetachReason, 'canceled_by_user')
})

test('debugger probe does not retain an attachment cancelled before session storage completes', async () => {
  const probe = fixture('http://127.0.0.1:8765/', false, true)
  const result = await probe.request('attach')
  assert.equal(result.attached, false)
  assert.equal(result.lastDetachReason, 'canceled_by_user')
  assert.equal((await probe.request('status')).attached, false)
})
