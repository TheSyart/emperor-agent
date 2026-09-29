import {
  HOST_NAME,
  MAX_JSON_BYTES,
  PROTOCOL,
  error,
  isObject,
  randomBytes,
  safeOrigin,
  toBase64Url,
  validFrame,
} from './protocol.js'
import {
  authenticationProof,
  createPairOffer,
  createTraffic,
  equalToken,
  finishPairOffer,
  open,
  pairingProof,
  seal,
} from './crypto.js'

let port = null
let traffic = null
let pairing = null
let pendingPair = null
let status = 'starting'
let detail = ''
let requestId = 0
let workerEpoch = 0
let generation = 0
let generationWrite = Promise.resolve()
let initializing = null
let retryTimer = null
let retryDelay = 1_000
let inboundQueue = Promise.resolve()
let outboundQueue = Promise.resolve()
const attachQueues = new Map()
const pending = new Map()
const targets = new Map()
const byTab = new Map()

async function uiStatus(tabId) {
  if (Number.isSafeInteger(tabId) && byTab.has(tabId)) {
    const target = targets.get(byTab.get(tabId))
    if (target) await currentTarget(target)
    else byTab.delete(tabId)
  }
  return {
    status,
    detail,
    pairingCode: pendingPair?.code || null,
    paired: !!pairing,
    connected: !!traffic,
    attached: targets.size,
    currentTabAttached: Number.isSafeInteger(tabId) && byTab.has(tabId),
  }
}

function setStatus(next, message = '') {
  status = next
  detail = message
  void chrome.action
    .setBadgeText({
      text: next === 'connected' ? 'ON' : next === 'pairing' ? '6' : '',
    })
    .catch(() => {})
  void chrome.action
    .setBadgeBackgroundColor({
      color: next === 'connected' ? '#0b7a4b' : '#a06b00',
    })
    .catch(() => {})
}

async function nextGeneration() {
  const issued = ++generation
  const write = generationWrite
    .catch(() => {})
    .then(() => chrome.storage.local.set({ generation: issued }))
  generationWrite = write
  await write
  return issued
}

async function initialize() {
  if (initializing) return initializing
  initializing = (async () => {
    // Chrome normally exposes storage.local to content scripts. The pairing
    // secret must only be readable by the service worker and extension UI.
    await chrome.storage.local.setAccessLevel({
      accessLevel: 'TRUSTED_CONTEXTS',
    })
    const stored = await chrome.storage.local.get(['pairing', 'generation'])
    pairing = validPairing(stored.pairing) ? stored.pairing : null
    generation = Number.isSafeInteger(stored.generation) ? stored.generation : 0
    workerEpoch = await nextGeneration()
    setStatus(pairing ? 'disconnected' : 'unpaired')
    if (pairing) connect()
  })().catch(() => setStatus('error', 'Extension storage is unavailable'))
  return initializing
}

function validPairing(value) {
  return (
    isObject(value) &&
    typeof value.pairingId === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(value.pairingId) &&
    typeof value.secret === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.secret)
  )
}

function connect() {
  if (port) return
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  try {
    const next = chrome.runtime.connectNative(HOST_NAME)
    port = next
    traffic = null
    setStatus(pairing ? 'authenticating' : 'unpaired')
    next.onMessage.addListener((message) => {
      inboundQueue = inboundQueue
        .then(() => receive(message, next))
        .catch(() => {
          if (port === next) disconnect('Protocol error')
        })
    })
    next.onDisconnect.addListener(() => {
      if (port !== next) return
      disconnect(
        chrome.runtime.lastError?.message || 'Native host disconnected',
        true,
      )
    })
    if (pairing)
      void authenticate().catch(() => disconnect('Authentication failed'))
  } catch {
    setStatus(
      'disconnected',
      'Native host is not installed or Emperor is not running',
    )
  }
}

function disconnect(message, retry = false) {
  const previous = port
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  port = null
  traffic = null
  pendingPair = null
  targets.clear()
  byTab.clear()
  attachQueues.clear()
  for (const item of pending.values())
    item.reject(new Error('Native host disconnected'))
  pending.clear()
  outboundQueue = Promise.resolve()
  if (previous)
    try {
      previous.disconnect()
    } catch {
      /* already closed */
    }
  setStatus('disconnected', message)
  if (retry && pairing) {
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30_000)
  }
}

function sendRaw(frame) {
  if (!port) throw new Error('Native host unavailable')
  if (new TextEncoder().encode(JSON.stringify(frame)).length > MAX_JSON_BYTES)
    throw new Error('Frame too large')
  port.postMessage(frame)
}

function rawRequest(method, params, timeoutMs = 15_000) {
  const id = ++requestId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Native host timed out'))
    }, timeoutMs)
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      reject: (cause) => {
        clearTimeout(timer)
        reject(cause)
      },
    })
    try {
      sendRaw({ type: 'request', id, method, params, deadlineMs: timeoutMs })
    } catch (cause) {
      pending.delete(id)
      clearTimeout(timer)
      reject(cause)
    }
  })
}

function sendSecure(frame) {
  if (!traffic || !pairing) throw new Error('Not authenticated')
  const currentPort = port
  const currentTraffic = traffic
  const pairingId = pairing.pairingId
  const task = outboundQueue
    .catch(() => {})
    .then(async () => {
      try {
        if (port !== currentPort || traffic !== currentTraffic)
          throw new Error('Connection changed')
        const encrypted = await seal(currentTraffic, pairingId, frame)
        if (port !== currentPort || traffic !== currentTraffic)
          throw new Error('Connection changed')
        sendRaw(encrypted)
      } catch (error) {
        // A failed write may already have advanced the AEAD counter. Retire
        // this connection and every target rather than resume with a gap.
        if (port === currentPort && traffic === currentTraffic)
          disconnect('Native host write failed', true)
        throw error
      }
    })
  outboundQueue = task
  return task
}

async function authenticate() {
  if (!pairing || !port) return
  const extensionNonce = toBase64Url(randomBytes(16))
  const answer = await rawRequest('auth.begin', {
    protocol: PROTOCOL,
    pairingId: pairing.pairingId,
    nonce: extensionNonce,
  })
  if (typeof answer?.nonce !== 'string' || typeof answer?.proof !== 'string')
    throw new Error('Invalid authentication response')
  const expected = await authenticationProof(
    pairing.secret,
    extensionNonce,
    answer.nonce,
    'main',
  )
  if (!equalToken(expected, answer.proof))
    throw new Error('Main authentication proof mismatch')
  const proof = await authenticationProof(
    pairing.secret,
    extensionNonce,
    answer.nonce,
    'extension',
  )
  const final = await rawRequest('auth.finish', {
    pairingId: pairing.pairingId,
    proof,
  })
  if (final?.accepted !== true) throw new Error('Authentication rejected')
  traffic = await createTraffic(pairing.secret, extensionNonce, answer.nonce)
  retryDelay = 1_000
  setStatus('connected')
  await sendSecure({
    type: 'event',
    name: 'bridge.ready',
    data: { protocol: PROTOCOL, extensionId: chrome.runtime.id, workerEpoch },
  })
}

async function beginPairing() {
  await initialize()
  if (pairing) throw new Error('Already paired; disconnect first')
  connect()
  if (!port) throw new Error('Native host unavailable')
  const offer = await createPairOffer(chrome.runtime.id)
  const answer = await rawRequest('pair.begin', {
    protocol: PROTOCOL,
    extensionId: offer.extensionId,
    publicKey: offer.publicKey,
    nonce: offer.nonce,
  })
  pendingPair = await finishPairOffer(offer, answer)
  setStatus('pairing', 'Compare this code with Emperor, then confirm there')
  sendRaw({
    type: 'event',
    name: 'pair.displayed',
    data: { pairingId: pendingPair.pairingId },
  })
  return uiStatus()
}

async function receive(message, sourcePort) {
  if (
    sourcePort !== port ||
    new TextEncoder().encode(JSON.stringify(message)).length > MAX_JSON_BYTES
  )
    throw new Error('Oversized native message')
  if (message?.type === 'secure') {
    if (!traffic || !pairing)
      throw new Error('Encrypted message before authentication')
    const frame = await open(traffic, pairing.pairingId, message)
    if (!validFrame(frame)) throw new Error('Invalid decrypted message')
    await receiveFrame(frame, true)
    return
  }
  if (!validFrame(message)) throw new Error('Invalid native message')
  await receiveFrame(message, false)
}

async function receiveFrame(frame, secure) {
  if (frame.type === 'response') {
    if (secure) throw new Error('Unexpected secure response')
    const item = pending.get(frame.id)
    if (!item) return
    pending.delete(frame.id)
    if (frame.ok) item.resolve(frame.result)
    else item.reject(new Error(frame.error?.code || 'Native request failed'))
    return
  }
  if (!secure && frame.type === 'event' && frame.name === 'pair.approved') {
    if (
      !pendingPair ||
      frame.data.pairingId !== pendingPair.pairingId ||
      pairing
    )
      throw new Error('Unexpected pair approval')
    const expected = await pairingProof(
      pendingPair.secret,
      pendingPair.transcript,
      'main-approved',
    )
    if (!equalToken(expected, frame.data.proof))
      throw new Error('Pair approval proof mismatch')
    pairing = { pairingId: pendingPair.pairingId, secret: pendingPair.secret }
    await chrome.storage.local.set({ pairing })
    const proof = await pairingProof(
      pairing.secret,
      pendingPair.transcript,
      'extension-ready',
    )
    pendingPair = null
    sendRaw({
      type: 'event',
      name: 'pair.ready',
      data: { pairingId: pairing.pairingId, proof },
    })
    void authenticate().catch(() => disconnect('Authentication failed'))
    return
  }
  if (!secure && frame.type === 'event' && frame.name === 'pair.rejected') {
    pendingPair = null
    setStatus('unpaired', 'Pairing rejected in Emperor')
    return
  }
  if (!secure) throw new Error('Unencrypted command rejected')
  if (frame.type === 'ping') {
    await sendSecure({ type: 'pong', seq: frame.seq })
    return
  }
  if (frame.type !== 'request') return
  let timer
  const cancellation = new AbortController()
  const result = await Promise.race([
    handleRequest(frame.method, frame.params, cancellation.signal).catch(() =>
      failure('DRIVER_UNAVAILABLE', 'Browser operation failed', true),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        cancellation.abort()
        resolve(
          failure(
            frame.method === 'target.act'
              ? 'OUTCOME_UNKNOWN'
              : 'DRIVER_UNAVAILABLE',
            'Request timed out; observe before retry',
            true,
          ),
        )
      }, frame.deadlineMs)
    }),
  ])
  clearTimeout(timer)
  await sendSecure(
    result.ok
      ? { type: 'response', id: frame.id, ok: true, result: result.value }
      : { type: 'response', id: frame.id, ok: false, error: result.error },
  )
}

function failure(code, message, retryable = false) {
  return { ok: false, error: error(code, message, retryable) }
}
function success(value) {
  return { ok: true, value }
}

async function invalidate(target, reason) {
  if (!target || targets.get(target.targetId) !== target) return
  targets.delete(target.targetId)
  if (byTab.get(target.tabId) === target.targetId) byTab.delete(target.tabId)
  if (traffic)
    await sendSecure({
      type: 'event',
      name: 'target.lost',
      data: {
        targetId: target.targetId,
        generation: target.generation,
        reason,
      },
    })
}

async function currentTarget(params) {
  const target = targets.get(params?.targetId)
  if (!target || target.generation !== params?.generation) return null
  let tab
  try {
    tab = await chrome.tabs.get(target.tabId)
  } catch {
    await invalidate(target, 'tab-closed')
    return null
  }
  const origin = safeOrigin(tab.url)
  if (
    tab.windowId !== target.windowId ||
    origin !== target.origin ||
    tab.url !== target.url
  ) {
    await invalidate(target, 'identity-changed')
    return null
  }
  if (!(await chrome.permissions.contains({ origins: [origin + '/*'] }))) {
    await invalidate(target, 'permission-revoked')
    return null
  }
  let identity
  try {
    identity = await chrome.tabs.sendMessage(target.tabId, {
      channel: 'emperor-content-v1',
      method: 'identity',
    })
  } catch {
    await invalidate(target, 'document-unavailable')
    return null
  }
  if (!identity?.ok || identity.documentId !== target.documentId) {
    await invalidate(target, 'document-changed')
    return null
  }
  return targets.get(target.targetId) === target ? target : null
}

async function contentCall(target, method, params, signal) {
  if (signal?.aborted) throw new Error('Request timed out')
  const requestTraffic = traffic
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    files: ['content-script.js'],
  })
  if (
    signal?.aborted ||
    (target.targetId &&
      (targets.get(target.targetId) !== target || traffic !== requestTraffic))
  )
    throw new Error('Target changed during script injection')
  return chrome.tabs.sendMessage(target.tabId, {
    ...params,
    channel: 'emperor-content-v1',
    method,
  })
}

async function handleRequest(method, params, signal) {
  if (signal?.aborted) throw new Error('Request timed out')
  if (!isObject(params))
    return failure('INVALID_ARGUMENT', 'Parameters must be an object')
  if (method === 'tabs.discover') {
    const tabs = await chrome.tabs.query({})
    return success({
      tabs: tabs
        .filter((tab) => Number.isSafeInteger(tab.id) && safeOrigin(tab.url))
        .map((tab) => ({
          tabId: tab.id,
          windowId: tab.windowId,
          origin: safeOrigin(tab.url),
          attached: byTab.has(tab.id),
        })),
    })
  }
  if (method === 'target.list') {
    const live = []
    for (const attached of [...targets.values()]) {
      const target = await currentTarget(attached)
      if (!target) continue
      const { targetId, tabId, windowId, origin, generation, revision } = target
      live.push({ targetId, tabId, windowId, origin, generation, revision })
    }
    return success({ targets: live })
  }
  if (method === 'target.detach') {
    const target = targets.get(params.targetId)
    if (!target || target.generation !== params.generation)
      return failure('STALE_TARGET', 'Target has changed')
    await invalidate(target, 'released')
    return success({ released: true })
  }
  if (method === 'target.observe') {
    const target = await currentTarget(params)
    if (!target) return failure('STALE_TARGET', 'Target has changed')
    const nextRevision = target.revision + 1
    try {
      const observation = await contentCall(
        target,
        'observe',
        {
          revision: nextRevision,
          maxElements: params.budget?.maxElements,
        },
        signal,
      )
      if (!observation?.ok)
        return failure('DRIVER_UNAVAILABLE', 'Content observation failed', true)
      if (signal?.aborted || !(await currentTarget(params)))
        return failure('STALE_TARGET', 'Target changed during observation')
      if (target.documentId !== observation.documentId) {
        await invalidate(target, 'document-changed')
        return failure(
          'STALE_TARGET',
          'Document changed; connect the tab again',
        )
      }
      target.revision = nextRevision
      target.observation = {
        documentId: observation.documentId,
        mutationVersion: observation.mutationVersion,
      }
      return success({
        targetId: target.targetId,
        generation: target.generation,
        revision: nextRevision,
        origin: target.origin,
        viewport: observation.viewport,
        elements: observation.elements,
        truncated: observation.truncated,
        redactions: observation.redactions,
        notes: ['Main frame only; input values and page text are omitted'],
      })
    } catch {
      return failure(
        'DRIVER_UNAVAILABLE',
        'Content script is unavailable',
        true,
      )
    }
  }
  if (method === 'target.act') {
    const target = await currentTarget(params)
    if (!target) return failure('STALE_TARGET', 'Target has changed')
    if (params.expectedRevision !== target.revision || !target.observation)
      return failure('STALE_ELEMENT', 'Observe the target again')
    const action = params.action
    if (
      !isObject(action) ||
      !['click', 'fill'].includes(action.kind) ||
      typeof action.ref !== 'string' ||
      !/^r\d+\.\d+$/.test(action.ref)
    )
      return failure(
        'CAPABILITY_DISABLED',
        'Only fixed click and fill actions are available',
      )
    if (
      action.kind === 'fill' &&
      (typeof action.text !== 'string' || action.text.length > 16_384)
    )
      return failure('INVALID_ARGUMENT', 'Invalid non-secret input')
    try {
      const outcome = await contentCall(
        target,
        'act',
        {
          kind: action.kind,
          ref: action.ref,
          button: action.button,
          count: action.count,
          text: action.text,
          revision: target.revision,
          ...target.observation,
        },
        signal,
      )
      target.observation = null
      if (!outcome?.ok)
        return failure(
          outcome?.error || 'OUTCOME_UNKNOWN',
          'Action was not confirmed; observe before any retry',
        )
      return success({
        dispatched: true,
        outcome: 'unknown',
        valuePresent: outcome.valuePresent,
      })
    } catch {
      target.observation = null
      return failure(
        'OUTCOME_UNKNOWN',
        'Action may have run; observe before any retry',
      )
    }
  }
  return failure('CAPABILITY_DISABLED', 'Unsupported fixed method')
}

async function attachTabOnce(tabId, currentTraffic) {
  if (!traffic || traffic !== currentTraffic)
    throw new Error('Connection changed while connecting tab')
  if (!Number.isSafeInteger(tabId)) throw new Error('Invalid tab')
  const tab = await chrome.tabs.get(tabId)
  const origin = safeOrigin(tab.url)
  if (
    !origin ||
    !(await chrome.permissions.contains({ origins: [origin + '/*'] }))
  )
    throw new Error('Site permission is required')
  const identity = await contentCall({ tabId }, 'identity', {})
  if (!identity?.ok || typeof identity.documentId !== 'string')
    throw new Error('Tab document is unavailable')
  const issuedGeneration = await nextGeneration()
  const current = await chrome.tabs.get(tabId)
  const currentIdentity = await contentCall({ tabId }, 'identity', {})
  const stillPermitted = await chrome.permissions.contains({
    origins: [origin + '/*'],
  })
  if (traffic !== currentTraffic)
    throw new Error('Connection changed while connecting tab')
  if (
    current.windowId !== tab.windowId ||
    current.url !== tab.url ||
    !currentIdentity?.ok ||
    currentIdentity.documentId !== identity.documentId ||
    !stillPermitted
  )
    throw new Error('Tab changed while connecting')
  const existing = byTab.get(tabId)
  if (existing) await invalidate(targets.get(existing), 'rebound')
  if (traffic !== currentTraffic)
    throw new Error('Connection changed while connecting tab')
  const target = {
    targetId: crypto.randomUUID(),
    tabId,
    windowId: tab.windowId,
    origin,
    url: tab.url,
    generation: issuedGeneration,
    revision: 0,
    documentId: identity.documentId,
    observation: null,
  }
  targets.set(target.targetId, target)
  byTab.set(tabId, target.targetId)
  await sendSecure({
    type: 'event',
    name: 'target.attached',
    data: {
      targetId: target.targetId,
      tabId,
      windowId: tab.windowId,
      origin,
      generation: target.generation,
    },
  })
  return { targetId: target.targetId, origin, generation: target.generation }
}

function attachTab(tabId) {
  if (!Number.isSafeInteger(tabId))
    return Promise.reject(new Error('Invalid tab'))
  if (!traffic)
    return Promise.reject(new Error('Pair and connect to Emperor first'))
  const currentTraffic = traffic
  const previous = attachQueues.get(tabId) ?? Promise.resolve()
  const task = previous
    .catch(() => {})
    .then(() => attachTabOnce(tabId, currentTraffic))
  attachQueues.set(tabId, task)
  void task.then(
    () => {
      if (attachQueues.get(tabId) === task) attachQueues.delete(tabId)
    },
    () => {
      if (attachQueues.get(tabId) === task) attachQueues.delete(tabId)
    },
  )
  return task
}

function invalidateTab(tabId, reason) {
  const target = targets.get(byTab.get(tabId))
  if (target)
    void invalidate(target, reason).catch(() =>
      disconnect('Target event failed'),
    )
}

chrome.tabs.onRemoved.addListener((tabId) => invalidateTab(tabId, 'tab-closed'))
chrome.tabs.onReplaced.addListener((_added, removed) =>
  invalidateTab(removed, 'tab-replaced'),
)
chrome.tabs.onDetached.addListener((tabId) =>
  invalidateTab(tabId, 'window-transfer'),
)
chrome.tabs.onAttached.addListener((tabId) =>
  invalidateTab(tabId, 'window-transfer'),
)
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'loading' || typeof changes.url === 'string')
    invalidateTab(tabId, 'navigation')
})
chrome.permissions.onRemoved.addListener(() => {
  for (const target of targets.values())
    void currentTarget({
      targetId: target.targetId,
      generation: target.generation,
    })
})

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('popup.html') ||
    !isObject(message)
  )
    return
  void (async () => {
    await initialize()
    if (message.kind === 'status') return uiStatus(message.tabId)
    if (message.kind === 'connect') {
      connect()
      return uiStatus()
    }
    if (message.kind === 'pair') return beginPairing()
    if (message.kind === 'attach') return attachTab(message.tabId)
    if (message.kind === 'forget') {
      if (traffic && pairing)
        await sendSecure({
          type: 'event',
          name: 'pair.revoked',
          data: { pairingId: pairing.pairingId },
        })
      disconnect('Pairing removed by user')
      pairing = null
      await chrome.storage.local.remove('pairing')
      setStatus('unpaired')
      return uiStatus()
    }
    if (message.kind === 'disconnect') {
      disconnect('Disconnected by user')
      return uiStatus()
    }
    throw new Error('Unsupported popup command')
  })()
    .then((value) => respond({ ok: true, value }))
    .catch((cause) => respond({ ok: false, message: cause.message }))
  return true
})

chrome.runtime.onStartup.addListener(() => {
  void initialize()
})
void initialize()
