import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticationProof, pairingProof } from '../crypto.js'
import { fromBase64Url, toBase64Url } from '../protocol.js'

const encoder = new TextEncoder()
const label = 'emperor-browser-pair-v1'

function event() {
  let listener
  return {
    addListener(fn) {
      listener = fn
    },
    fire(...args) {
      return listener?.(...args)
    },
  }
}

async function hkdf(raw, salt, info) {
  const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, [
    'deriveBits',
  ])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      key,
      256,
    ),
  )
}

function iv(counter) {
  const bytes = new Uint8Array(12)
  new DataView(bytes.buffer).setBigUint64(4, BigInt(counter))
  return bytes
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for worker')
}

test('worker pairs, authenticates, handles a fixed observation and invalidates on navigation', async () => {
  const stored = {}
  const runtimeMessages = event()
  const tabUpdated = event()
  const observed = []
  let port
  let chain = Promise.resolve()
  let mainSecret
  let transcript
  let extensionNonce
  let mainNonce
  let decryptKey
  let encryptKey
  let sent = 0
  let received = 0
  let nextMainRequest = 20
  let tabUrl = 'https://example.com/path?secret=hidden'
  let tabDocumentId = 'document-1'
  let contentActions = 0
  let holdNextIdentity = false
  let identityWaiting = false
  let releaseIdentity
  let holdGenerationWrites = false
  const generationWrites = []
  let failNextNativePost = false
  let holdNextScript = false
  let scriptWaiting = false
  let releaseScript
  const waiting = new Map()

  function emit(frame) {
    queueMicrotask(() => port.onMessage.fire(frame))
  }
  async function mainSeal(payload) {
    const counter = ++sent
    const aad = encoder.encode(
      JSON.stringify([label, 'pairing_12345678', counter, 'main-to-extension']),
    )
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv(counter), additionalData: aad },
      encryptKey,
      encoder.encode(JSON.stringify(payload)),
    )
    return {
      type: 'secure',
      pairingId: 'pairing_12345678',
      counter,
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    }
  }
  async function mainRequest(method, params, deadlineMs = 1000) {
    const id = ++nextMainRequest
    const result = new Promise((resolve) => waiting.set(id, resolve))
    emit(await mainSeal({ type: 'request', id, method, params, deadlineMs }))
    return result
  }
  async function handleFromWorker(frame) {
    if (frame.type === 'request' && frame.method === 'pair.begin') {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      )
      const publicKey = toBase64Url(
        new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
      )
      const extPublic = await crypto.subtle.importKey(
        'raw',
        fromBase64Url(frame.params.publicKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      )
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: extPublic },
          pair.privateKey,
          256,
        ),
      )
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
      transcript = JSON.stringify([
        label,
        frame.params.extensionId,
        'pairing_12345678',
        frame.params.publicKey,
        publicKey,
        frame.params.nonce,
        nonce,
      ])
      mainSecret = toBase64Url(
        await hkdf(shared, encoder.encode(transcript), label + ':secret'),
      )
      emit({
        type: 'response',
        id: frame.id,
        ok: true,
        result: { pairingId: 'pairing_12345678', publicKey, nonce },
      })
      return
    }
    if (frame.type === 'event' && frame.name === 'pair.displayed') {
      emit({
        type: 'event',
        name: 'pair.approved',
        data: {
          pairingId: 'pairing_12345678',
          proof: await pairingProof(mainSecret, transcript, 'main-approved'),
        },
      })
      return
    }
    if (frame.type === 'event' && frame.name === 'pair.ready') {
      assert.equal(
        frame.data.proof,
        await pairingProof(mainSecret, transcript, 'extension-ready'),
      )
      return
    }
    if (frame.type === 'request' && frame.method === 'auth.begin') {
      extensionNonce = frame.params.nonce
      mainNonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
      emit({
        type: 'response',
        id: frame.id,
        ok: true,
        result: {
          nonce: mainNonce,
          proof: await authenticationProof(
            mainSecret,
            extensionNonce,
            mainNonce,
            'main',
          ),
        },
      })
      return
    }
    if (frame.type === 'request' && frame.method === 'auth.finish') {
      assert.equal(
        frame.params.proof,
        await authenticationProof(
          mainSecret,
          extensionNonce,
          mainNonce,
          'extension',
        ),
      )
      const salt = encoder.encode(
        JSON.stringify([label, 'traffic', extensionNonce, mainNonce]),
      )
      decryptKey = await crypto.subtle.importKey(
        'raw',
        await hkdf(
          fromBase64Url(mainSecret),
          salt,
          label + ':extension-to-main',
        ),
        'AES-GCM',
        false,
        ['decrypt'],
      )
      encryptKey = await crypto.subtle.importKey(
        'raw',
        await hkdf(
          fromBase64Url(mainSecret),
          salt,
          label + ':main-to-extension',
        ),
        'AES-GCM',
        false,
        ['encrypt'],
      )
      sent = 0
      received = 0
      emit({
        type: 'response',
        id: frame.id,
        ok: true,
        result: { accepted: true },
      })
      return
    }
    if (frame.type === 'secure') {
      assert.equal(frame.counter, ++received)
      const aad = encoder.encode(
        JSON.stringify([
          label,
          'pairing_12345678',
          frame.counter,
          'extension-to-main',
        ]),
      )
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv(frame.counter), additionalData: aad },
        decryptKey,
        fromBase64Url(frame.ciphertext),
      )
      const inner = JSON.parse(new TextDecoder().decode(plaintext))
      observed.push(inner)
      if (inner.type === 'response') waiting.get(inner.id)?.(inner)
    }
  }

  globalThis.chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (path) =>
        `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      onMessage: runtimeMessages,
      onStartup: event(),
      connectNative() {
        port = {
          onMessage: event(),
          onDisconnect: event(),
          postMessage(frame) {
            if (failNextNativePost) {
              failNextNativePost = false
              throw new Error('Native port write failed')
            }
            chain = chain.then(() => handleFromWorker(frame))
          },
          disconnect() {},
        }
        return port
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async (keys) =>
          Object.fromEntries(keys.map((key) => [key, stored[key]])),
        set: async (values) => {
          if (holdGenerationWrites && 'generation' in values) {
            await new Promise((resolve) =>
              generationWrites.push(() => {
                Object.assign(stored, values)
                resolve()
              }),
            )
          } else {
            Object.assign(stored, values)
          }
        },
        remove: async (key) => {
          delete stored[key]
        },
      },
    },
    tabs: {
      onRemoved: event(),
      onReplaced: event(),
      onDetached: event(),
      onAttached: event(),
      onUpdated: tabUpdated,
      get: async (id) => ({
        id,
        windowId: 3,
        url: tabUrl,
      }),
      query: async () => [{ id: 7, windowId: 3, url: tabUrl }],
      sendMessage: async (_id, request) => {
        if (request.method === 'act') contentActions++
        if (request.method === 'identity' && holdNextIdentity) {
          holdNextIdentity = false
          identityWaiting = true
          await new Promise((resolve) => {
            releaseIdentity = resolve
          })
        }
        return request.method === 'identity'
          ? { ok: true, documentId: tabDocumentId }
          : request.method === 'observe'
            ? {
                ok: true,
                documentId: tabDocumentId,
                mutationVersion: 0,
                viewport: { width: 800, height: 600, scale: 1 },
                elements: [
                  {
                    ref: `r${request.revision}.1`,
                    role: 'button',
                    name: 'Go',
                    actions: ['click'],
                  },
                ],
                truncated: false,
                redactions: 0,
              }
            : { ok: true, dispatched: true }
      },
    },
    permissions: { onRemoved: event(), contains: async () => true },
    scripting: {
      executeScript: async () => {
        if (holdNextScript) {
          holdNextScript = false
          scriptWaiting = true
          await new Promise((resolve) => {
            releaseScript = resolve
          })
        }
        return []
      },
    },
  }

  await import('../service-worker.js?worker-test')
  const popup = (message) =>
    new Promise((resolve) =>
      runtimeMessages.fire(
        message,
        { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') },
        resolve,
      ),
    )
  await waitUntil(
    async () => (await popup({ kind: 'status' }))?.value?.status === 'unpaired',
  )
  const pairing = await popup({ kind: 'pair' })
  assert.equal(pairing.ok, true)
  assert.match(pairing.value.pairingCode, /^\d{6}$/)
  await waitUntil(
    async () => (await popup({ kind: 'status' }))?.value?.connected,
  )
  const attached = await popup({ kind: 'attach', tabId: 7 })
  assert.equal(attached.ok, true)
  assert.equal(
    (await popup({ kind: 'status', tabId: 7 })).value.currentTabAttached,
    true,
  )
  const staleTarget = attached.value
  // Simulate a missed Chrome navigation event. A fresh target.list must not
  // allow main to claim the cached target for a different document.
  tabUrl = 'https://example.com/other-document'
  const listedAfterMissedEvent = await mainRequest('target.list', {})
  assert.equal(listedAfterMissedEvent.ok, true)
  assert.deepEqual(listedAfterMissedEvent.result.targets, [])
  assert.equal(
    observed.some(
      (item) =>
        item.type === 'event' &&
        item.name === 'target.lost' &&
        item.data.targetId === staleTarget.targetId,
    ),
    true,
  )
  assert.equal(
    (
      await mainRequest('target.observe', {
        targetId: staleTarget.targetId,
        generation: staleTarget.generation,
      })
    ).error.code,
    'STALE_TARGET',
  )
  tabUrl = 'https://example.com/path?secret=hidden'
  const reattached = await popup({ kind: 'attach', tabId: 7 })
  assert.equal(reattached.ok, true)
  const target = reattached.value
  const result = await mainRequest('target.observe', {
    targetId: target.targetId,
    generation: target.generation,
  })
  assert.equal(result.ok, true)
  assert.equal(result.result.elements[0].name, 'Go')
  assert.equal(JSON.stringify(observed).includes('secret=hidden'), false)
  // Chrome may recycle the numeric tab ID while retaining the same window and
  // URL. If the removal event was missed, the old document identity must still
  // prevent the old target from being listed or used.
  tabDocumentId = 'document-2'
  const reusedStatus = await popup({ kind: 'status', tabId: 7 })
  assert.equal(reusedStatus.value.currentTabAttached, false)
  assert.equal(reusedStatus.value.attached, 0)
  const staleAction = await mainRequest('target.act', {
    targetId: target.targetId,
    generation: target.generation,
    expectedRevision: result.result.revision,
    action: { kind: 'click', ref: 'r1.1' },
  })
  assert.equal(staleAction.error.code, 'STALE_TARGET')
  assert.equal(contentActions, 0)
  const listedAfterIdReuse = await mainRequest('target.list', {})
  assert.equal(listedAfterIdReuse.ok, true)
  assert.deepEqual(listedAfterIdReuse.result.targets, [])
  assert.equal(
    (
      await mainRequest('target.observe', {
        targetId: target.targetId,
        generation: target.generation,
      })
    ).error.code,
    'STALE_TARGET',
  )
  const newTabTarget = (await popup({ kind: 'attach', tabId: 7 })).value
  holdNextIdentity = true
  const pendingAction = mainRequest('target.act', {
    targetId: newTabTarget.targetId,
    generation: newTabTarget.generation,
    expectedRevision: 0,
    action: { kind: 'click', ref: 'r0.1' },
  })
  await waitUntil(() => identityWaiting)
  tabUpdated.fire(7, { status: 'loading' })
  releaseIdentity()
  assert.equal((await pendingAction).error.code, 'STALE_TARGET')
  await waitUntil(() =>
    observed.some(
      (item) => item.type === 'event' && item.name === 'target.lost',
    ),
  )
  assert.equal(
    (await popup({ kind: 'status', tabId: 7 })).value.currentTabAttached,
    false,
  )
  assert.equal(
    (
      await mainRequest('target.observe', {
        targetId: newTabTarget.targetId,
        generation: newTabTarget.generation,
      })
    ).error.code,
    'STALE_TARGET',
  )

  // Two popup requests can attach different tabs while storage writes are
  // pending. They must receive distinct generations, and the persisted value
  // must be the greatest issued generation.
  holdGenerationWrites = true
  const concurrent = Promise.all([
    popup({ kind: 'attach', tabId: 7 }),
    popup({ kind: 'attach', tabId: 8 }),
  ])
  await waitUntil(() => generationWrites.length >= 1)
  generationWrites[0]()
  await waitUntil(() => generationWrites.length >= 2)
  generationWrites[1]()
  holdGenerationWrites = false
  const [first, second] = await concurrent
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.value.generation, second.value.generation)
  assert.equal(
    stored.generation,
    Math.max(first.value.generation, second.value.generation),
  )

  holdGenerationWrites = true
  const sameTab = Promise.all([
    popup({ kind: 'attach', tabId: 7 }),
    popup({ kind: 'attach', tabId: 7 }),
  ])
  await waitUntil(() => generationWrites.length >= 3)
  generationWrites[2]()
  await waitUntil(() => generationWrites.length >= 4)
  generationWrites[3]()
  holdGenerationWrites = false
  const [older, newer] = await sameTab
  assert.equal(older.ok, true)
  assert.equal(newer.ok, true)
  const afterConcurrentReattach = await mainRequest('target.list', {})
  assert.equal(afterConcurrentReattach.ok, true)
  assert.deepEqual(
    afterConcurrentReattach.result.targets
      .filter((item) => item.tabId === 7)
      .map((item) => item.targetId),
    [newer.value.targetId],
  )
  assert.equal(
    (
      await mainRequest('target.observe', {
        targetId: older.value.targetId,
        generation: older.value.generation,
      })
    ).error.code,
    'STALE_TARGET',
  )

  holdGenerationWrites = true
  const changedDuringAttach = popup({ kind: 'attach', tabId: 10 })
  await waitUntil(() => generationWrites.length >= 5)
  tabDocumentId = 'document-changed-during-attach'
  generationWrites[4]()
  holdGenerationWrites = false
  assert.equal((await changedDuringAttach).ok, false)
  const afterChangedDocument = await mainRequest('target.list', {})
  assert.equal(afterChangedDocument.ok, true)
  assert.equal(
    afterChangedDocument.result.targets.some((item) => item.tabId === 10),
    false,
  )

  failNextNativePost = true
  const failedAttach = await popup({ kind: 'attach', tabId: 9 })
  assert.equal(failedAttach.ok, false)
  const afterFailedPost = await popup({ kind: 'status', tabId: 9 })
  assert.equal(afterFailedPost.value.connected, false)
  assert.equal(afterFailedPost.value.attached, 0)
  await popup({ kind: 'disconnect' })

  await popup({ kind: 'connect' })
  await waitUntil(
    async () => (await popup({ kind: 'status' }))?.value?.connected,
  )
  holdGenerationWrites = true
  let queuedSettled = false
  const queuedBeforeDisconnect = Promise.all([
    popup({ kind: 'attach', tabId: 11 }),
    popup({ kind: 'attach', tabId: 11 }),
  ]).then((results) => {
    queuedSettled = true
    return results
  })
  await waitUntil(() => generationWrites.length >= 6)
  await popup({ kind: 'disconnect' })
  await popup({ kind: 'connect' })
  await waitUntil(
    async () => (await popup({ kind: 'status' }))?.value?.connected,
  )
  generationWrites[5]()
  await waitUntil(() => generationWrites.length >= 7 || queuedSettled)
  generationWrites[6]?.()
  holdGenerationWrites = false
  const [interrupted, queued] = await queuedBeforeDisconnect
  assert.equal(interrupted.ok, false)
  assert.equal(queued.ok, false)
  assert.equal((await popup({ kind: 'status' })).value.attached, 0)

  // A timed-out request must not send its click after main has received the
  // unknown-outcome response, even if script injection eventually finishes.
  const expiredTarget = (await popup({ kind: 'attach', tabId: 7 })).value
  const expiredObservation = await mainRequest('target.observe', {
    targetId: expiredTarget.targetId,
    generation: expiredTarget.generation,
  })
  assert.equal(expiredObservation.ok, true)
  holdNextScript = true
  scriptWaiting = false
  const expiredAction = mainRequest(
    'target.act',
    {
      targetId: expiredTarget.targetId,
      generation: expiredTarget.generation,
      expectedRevision: expiredObservation.result.revision,
      action: {
        kind: 'click',
        ref: `r${expiredObservation.result.revision}.1`,
      },
    },
    20,
  )
  await waitUntil(() => scriptWaiting)
  assert.equal((await expiredAction).error.code, 'OUTCOME_UNKNOWN')
  releaseScript()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(contentActions, 0)

  // Disconnect after a target has passed identity checks but before content
  // script injection completes. No old click may be sent after the lease dies.
  const delayedTarget = (await popup({ kind: 'attach', tabId: 7 })).value
  const delayedObservation = await mainRequest('target.observe', {
    targetId: delayedTarget.targetId,
    generation: delayedTarget.generation,
  })
  assert.equal(delayedObservation.ok, true)
  holdNextScript = true
  void mainRequest('target.act', {
    targetId: delayedTarget.targetId,
    generation: delayedTarget.generation,
    expectedRevision: delayedObservation.result.revision,
    action: {
      kind: 'click',
      ref: `r${delayedObservation.result.revision}.1`,
    },
  })
  await waitUntil(() => scriptWaiting)
  await popup({ kind: 'disconnect' })
  releaseScript()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(contentActions, 0)
  delete globalThis.chrome
})
