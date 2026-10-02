// A scripted Emperor main process on the far side of connectNative, and the
// chrome.* surface the service worker uses. Shared by the worker lifecycle
// tests; not a test file itself (node --test runs *.test.js only).
import { authenticationProof, pairingProof } from '../crypto.js'
import { fromBase64Url, toBase64Url } from '../protocol.js'

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
export const PAIRING_ID = 'pairing_12345678'
const LABEL = 'emperor-browser-pair-v1'
const encoder = new TextEncoder()

export function event() {
  const listeners = []
  return {
    addListener(fn) {
      listeners.push(fn)
    },
    fire(...args) {
      let result
      for (const listener of listeners) result = listener(...args)
      return result
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

export async function waitUntil(predicate, what = 'condition') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A fresh 32-byte pairing secret, as main's store would hold it. */
export function newSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Options:
 * - pairing: `{ pairingId, secret }` already in chrome.storage.local.
 * - authError: answer auth.begin with this error code instead of a proof.
 * - tabs: tabs that are open (`{ id, url }`), for the welcome-page lookup.
 */
export function fakeBrowser(options = {}) {
  const stored = options.pairing ? { pairing: options.pairing } : {}
  const runtimeMessages = event()
  const installed = event()
  const state = {
    stored,
    created: [],
    activated: [],
    uninstalled: [],
    reloaded: 0,
    disconnects: 0,
    pairBegin: null,
    observed: [],
    tabs: [...(options.tabs ?? [])],
  }
  let port = null
  let chain = Promise.resolve()
  let secret = options.pairing?.secret ?? null
  let transcript = ''
  let extensionNonce = ''
  let mainNonce = ''
  let decryptKey = null
  let encryptKey = null
  let sent = 0
  let received = 0
  let nextRequest = 100
  const waiting = new Map()

  function emit(frame) {
    const current = port
    queueMicrotask(() => current?.onMessage.fire(frame))
  }

  async function seal(payload) {
    const counter = ++sent
    const aad = encoder.encode(
      JSON.stringify([LABEL, PAIRING_ID, counter, 'main-to-extension']),
    )
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv(counter), additionalData: aad },
      encryptKey,
      encoder.encode(JSON.stringify(payload)),
    )
    return {
      type: 'secure',
      pairingId: PAIRING_ID,
      counter,
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    }
  }

  async function fromWorker(frame) {
    if (frame.type === 'request' && frame.method === 'pair.begin') {
      state.pairBegin = frame.params
      const keys = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      )
      const publicKey = toBase64Url(
        new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)),
      )
      const extensionPublic = await crypto.subtle.importKey(
        'raw',
        fromBase64Url(frame.params.publicKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      )
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'ECDH', public: extensionPublic },
          keys.privateKey,
          256,
        ),
      )
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
      transcript = JSON.stringify([
        LABEL,
        frame.params.extensionId,
        PAIRING_ID,
        frame.params.publicKey,
        publicKey,
        frame.params.nonce,
        nonce,
      ])
      secret = toBase64Url(
        await hkdf(shared, encoder.encode(transcript), LABEL + ':secret'),
      )
      emit({
        type: 'response',
        id: frame.id,
        ok: true,
        result: { pairingId: PAIRING_ID, publicKey, nonce },
      })
      return
    }
    if (frame.type === 'event' && frame.name === 'pair.displayed') {
      emit({
        type: 'event',
        name: 'pair.approved',
        data: {
          pairingId: PAIRING_ID,
          proof: await pairingProof(secret, transcript, 'main-approved'),
        },
      })
      return
    }
    if (frame.type === 'event' && frame.name === 'pair.ready') return
    if (frame.type === 'request' && frame.method === 'auth.begin') {
      if (options.authError) {
        emit({
          type: 'response',
          id: frame.id,
          ok: false,
          error: {
            code: options.authError,
            message: options.authError,
            retryable: false,
          },
        })
        return
      }
      extensionNonce = frame.params.nonce
      mainNonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
      emit({
        type: 'response',
        id: frame.id,
        ok: true,
        result: {
          nonce: mainNonce,
          proof: await authenticationProof(
            secret,
            extensionNonce,
            mainNonce,
            'main',
          ),
        },
      })
      return
    }
    if (frame.type === 'request' && frame.method === 'auth.finish') {
      const salt = encoder.encode(
        JSON.stringify([LABEL, 'traffic', extensionNonce, mainNonce]),
      )
      decryptKey = await crypto.subtle.importKey(
        'raw',
        await hkdf(fromBase64Url(secret), salt, LABEL + ':extension-to-main'),
        'AES-GCM',
        false,
        ['decrypt'],
      )
      encryptKey = await crypto.subtle.importKey(
        'raw',
        await hkdf(fromBase64Url(secret), salt, LABEL + ':main-to-extension'),
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
      if (frame.counter !== ++received) throw new Error('counter gap')
      const aad = encoder.encode(
        JSON.stringify([LABEL, PAIRING_ID, frame.counter, 'extension-to-main']),
      )
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv(frame.counter), additionalData: aad },
        decryptKey,
        fromBase64Url(frame.ciphertext),
      )
      const inner = JSON.parse(new TextDecoder().decode(plaintext))
      state.observed.push(inner)
      if (inner.type === 'response') waiting.get(inner.id)?.(inner)
    }
  }

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => ({ version: '0.2.0' }),
      onMessage: runtimeMessages,
      onStartup: event(),
      onInstalled: installed,
      reload() {
        state.reloaded++
      },
      connectNative() {
        const next = {
          onMessage: event(),
          onDisconnect: event(),
          postMessage(frame) {
            chain = chain.then(() => fromWorker(frame))
          },
          disconnect() {
            state.disconnects++
            if (port === next) port = null
          },
        }
        port = next
        return next
      },
    },
    management: {
      uninstallSelf: async (input) => {
        state.uninstalled.push(input ?? {})
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
          Object.assign(stored, values)
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
      onUpdated: event(),
      get: async (id) => ({ id, windowId: 1, url: 'https://example.com/' }),
      query: async () => state.tabs,
      create: async ({ url }) => {
        state.created.push(url)
        const tab = { id: 500 + state.created.length, url }
        state.tabs.push(tab)
        return tab
      },
      update: async (id, changes) => {
        state.activated.push([id, changes])
        return { id }
      },
      sendMessage: async () => ({ ok: true, documentId: 'document-1' }),
    },
    windows: { update: async () => ({}) },
    permissions: { onRemoved: event(), contains: async () => true },
    scripting: { executeScript: async () => [] },
  }

  return {
    chrome,
    state,
    installed,
    /**
     * A message from one of the extension's own pages. Like Chrome, a
     * listener that does not keep the channel open (returns true) answers
     * nothing.
     */
    page(message, path = 'popup.html') {
      return new Promise((resolve) => {
        const kept = runtimeMessages.fire(
          message,
          { id: EXTENSION_ID, url: chrome.runtime.getURL(path) },
          resolve,
        )
        if (kept !== true) resolve(undefined)
      })
    },
    get connected() {
      return port !== null
    },
    /** Main → extension request over the encrypted channel. */
    async request(method, params = {}, deadlineMs = 1000) {
      const id = ++nextRequest
      const answer = new Promise((resolve) => waiting.set(id, resolve))
      emit(await seal({ type: 'request', id, method, params, deadlineMs }))
      return answer
    },
    /** Main → extension event over the encrypted channel. */
    async event(name, data) {
      emit(await seal({ type: 'event', name, data }))
    },
  }
}

/** Installs a navigator for the worker; returns the restore function. */
export function withNavigator(value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  })
  return () => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  }
}
