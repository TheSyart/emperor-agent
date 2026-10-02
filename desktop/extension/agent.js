// The Agent's own browsing in Chrome or Edge (PLAN-CAP-001 RV-09):
// - `tab.open` opens a tab in the background, in the tab group "Emperor",
//   and makes it a target;
// - `target.navigate` goes to a URL the Agent asked for;
// - a target whose page moves by itself waits: the worker reports the new
//   origin (`target.navigated`, never the path) and Emperor answers with
//   `target.follow` (carry on under a new generation) or `target.detach`;
// - a download from a tab the Agent just worked in is held in
//   onDeterminingFilename (pause comes too late for small files) until
//   Emperor answers `download.resolve`;
// - `history.search` (RV-10) returns web pages of the browsing history;
//   Emperor decides beforehand whether the user is asked.
//
// Download items carry no tab id. A download counts as the Agent's when the
// page that started it (its referrer, or the origin inside a blob: URL) is
// a target's origin and the Agent observed, acted or navigated there in the
// last minute. Limits: a download from another tab of the same site in that
// minute counts too (it asks or follows the rule rather than slipping
// through); one with no referrer and no blob origin (a data: URL, a
// stripped referrer) cannot be told apart and is left to the browser.
import { error, isObject, safeOrigin } from './protocol.js'

export const GROUP_TITLE = 'Emperor'
export const DOWNLOAD_WINDOW_MS = 60_000
export const DOWNLOAD_DECISION_MS = 10 * 60_000
const MAX_URL = 2_048

function failure(code, message, retryable = false) {
  return { ok: false, error: error(code, message, retryable) }
}
function success(value) {
  return { ok: true, value }
}

/** The file name of a download path (either separator). */
export function basename(path) {
  return typeof path === 'string'
    ? (path.split(/[\\/]/).pop() ?? '').slice(0, 200)
    : ''
}

/** Chrome or Edge, from the browser's own brand list. */
export function browserBrand(nav = globalThis.navigator) {
  const brands = nav?.userAgentData?.brands
  if (
    Array.isArray(brands) &&
    brands.some((item) => /edge/i.test(String(item?.brand ?? '')))
  )
    return 'edge'
  return /\bEdg\//.test(String(nav?.userAgent ?? '')) ? 'edge' : 'chrome'
}

function blobOrigin(url) {
  return typeof url === 'string' && url.startsWith('blob:')
    ? safeOrigin(url.slice(5))
    : null
}

/** The target a download came from, or null when it is the user's own. */
export function downloadSource(
  item,
  targets,
  now = Date.now(),
  windowMs = DOWNLOAD_WINDOW_MS,
) {
  const from =
    safeOrigin(item?.referrer) ??
    blobOrigin(item?.url) ??
    blobOrigin(item?.finalUrl)
  if (!from) return null
  const started = Date.parse(item?.startTime ?? '')
  const at = Number.isFinite(started) ? started : now
  let best = null
  for (const target of targets) {
    const active = target.lastActiveAt
    if (target.origin !== from || !(active > 0)) continue
    if (at - active > windowMs || at < active - 5_000) continue
    if (!best || active > best.lastActiveAt) best = target
  }
  return best
}

function webUrl(value) {
  return typeof value === 'string' && value.length <= MAX_URL
    ? safeOrigin(value)
    : null
}

/**
 * deps: { chrome, targets, byTab, connected(), sendEvent(name, data),
 * nextGeneration(), identify(tabId) → documentId | null,
 * invalidate(target, reason), currentTarget(params) → target | null,
 * now?() }
 */
export function createAgentFeatures(deps) {
  const { chrome, targets, byTab } = deps
  const now = deps.now ?? (() => Date.now())
  const loadWaiters = new Map()
  const heldDownloads = new Map()
  const allowedDownloads = new Map()

  const permitted = (origin) =>
    chrome.permissions.contains({ origins: [origin + '/*'] })

  /**
   * Resolves with the tab once its page finished loading: after a fresh
   * load (`loading` → `complete`), or at once for a same-document move.
   * `fresh`: a tab just created, whose load may already be over.
   */
  function waitForLoad(tabId, signal, fresh = false) {
    return new Promise((resolve, reject) => {
      const waiter = {
        loading: fresh,
        update(changes, tab) {
          if (changes.status === 'loading') waiter.loading = true
          else if (
            (changes.status === 'complete' && waiter.loading) ||
            (typeof changes.url === 'string' && tab?.status === 'complete')
          )
            finish(null, tab)
        },
      }
      const finish = (cause, tab) => {
        const list = loadWaiters.get(tabId)
        list?.delete(waiter)
        if (list?.size === 0) loadWaiters.delete(tabId)
        signal?.removeEventListener('abort', abort)
        if (cause) reject(cause)
        else resolve(tab)
      }
      const abort = () => finish(new Error('Navigation timed out'))
      waiter.cancel = () => finish(new Error('The connection ended'))
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (!loadWaiters.has(tabId)) loadWaiters.set(tabId, new Set())
      loadWaiters.get(tabId).add(waiter)
      if (fresh)
        void chrome.tabs.get(tabId).then(
          (tab) => {
            if (tab.status === 'complete' && safeOrigin(tab.url))
              finish(null, tab)
          },
          () => finish(new Error('Tab closed')),
        )
    })
  }

  async function group(tab) {
    try {
      const [existing] = await chrome.tabGroups.query({
        windowId: tab.windowId,
        title: GROUP_TITLE,
      })
      if (existing) {
        await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] })
        return
      }
      const groupId = await chrome.tabs.group({
        tabIds: [tab.id],
        createProperties: { windowId: tab.windowId },
      })
      await chrome.tabGroups.update(groupId, {
        title: GROUP_TITLE,
        color: 'purple',
      })
    } catch {
      // A tab outside the group works the same.
    }
  }

  function touch(target) {
    target.lastActiveAt = now()
  }

  async function openTab(params, signal) {
    const url = typeof params.url === 'string' ? params.url : ''
    const destination = webUrl(url)
    if (!destination)
      return failure('INVALID_ARGUMENT', 'Only http(s) addresses can be opened')
    if (!(await permitted(destination)))
      return failure(
        'PERMISSION_REQUIRED',
        'Allow the extension to read this site first',
      )
    if (signal?.aborted)
      return failure('TIMEOUT_NO_EFFECT', 'Cancelled before opening')
    const created = await chrome.tabs.create({ url, active: false })
    if (!Number.isSafeInteger(created?.id))
      return failure('DRIVER_UNAVAILABLE', 'The browser did not open a tab')
    const loaded = waitForLoad(created.id, signal, true)
    await group(created)
    let tab
    try {
      tab = await loaded
    } catch {
      return failure(
        'OUTCOME_UNKNOWN',
        'The tab opened but did not finish loading',
      )
    }
    const origin = safeOrigin(tab?.url)
    if (!origin) return failure('STALE_TARGET', 'The page left the web')
    if (!(await permitted(origin)))
      return failure(
        'PERMISSION_REQUIRED',
        'Allow the extension to read this site first',
      )
    const documentId = await deps.identify(created.id).catch(() => null)
    if (!documentId)
      return failure('DRIVER_UNAVAILABLE', 'The page cannot be read', true)
    const generation = await deps.nextGeneration()
    const target = {
      targetId: crypto.randomUUID(),
      tabId: created.id,
      windowId: tab.windowId,
      origin,
      url: tab.url,
      generation,
      revision: 0,
      documentId,
      observation: null,
      lastActiveAt: now(),
    }
    targets.set(target.targetId, target)
    byTab.set(target.tabId, target.targetId)
    return success({
      targetId: target.targetId,
      tabId: target.tabId,
      windowId: target.windowId,
      origin,
      generation,
    })
  }

  /** The tab finished loading `pendingOrigin`: the target goes on there. */
  async function finishNavigation(target) {
    const origin = target.pendingOrigin
    const tab = await chrome.tabs.get(target.tabId)
    if (
      safeOrigin(tab.url) !== origin ||
      tab.windowId !== target.windowId ||
      tab.status !== 'complete'
    )
      return failure('STALE_TARGET', 'The tab changed again')
    if (!(await permitted(origin))) {
      await deps.invalidate(target, 'permission-required')
      return failure(
        'PERMISSION_REQUIRED',
        'Allow the extension to read this site first',
      )
    }
    const documentId = await deps.identify(target.tabId).catch(() => null)
    const unchanged = () =>
      targets.get(target.targetId) === target && target.pendingOrigin === origin
    if (!documentId || !unchanged())
      return failure('STALE_TARGET', 'The tab changed during navigation')
    const generation = await deps.nextGeneration()
    if (!unchanged())
      return failure('STALE_TARGET', 'The tab changed during navigation')
    target.origin = origin
    target.url = tab.url
    target.documentId = documentId
    target.generation = generation
    target.observation = null
    target.navigating = false
    target.pendingOrigin = null
    target.agentNavigation = false
    return success({
      targetId: target.targetId,
      generation,
      origin,
      revision: target.revision,
    })
  }

  async function navigate(params, signal) {
    const target = await deps.currentTarget(params)
    if (!target) return failure('STALE_TARGET', 'Target has changed')
    const destination = webUrl(params.url)
    if (!destination)
      return failure('INVALID_ARGUMENT', 'Only http(s) addresses can be opened')
    if (!(await permitted(destination)))
      return failure(
        'PERMISSION_REQUIRED',
        'Allow the extension to read this site first',
      )
    target.navigating = true
    target.agentNavigation = true
    target.observation = null
    target.pendingOrigin = null
    touch(target)
    const loaded = waitForLoad(target.tabId, signal)
    let tab
    try {
      await chrome.tabs.update(target.tabId, { url: params.url })
      tab = await loaded
    } catch {
      target.agentNavigation = false
      return failure(
        'OUTCOME_UNKNOWN',
        'The navigation may have happened; observe again',
      )
    }
    target.agentNavigation = false
    if (targets.get(target.targetId) !== target)
      return failure('STALE_TARGET', 'Target has changed')
    const origin = safeOrigin(tab?.url)
    if (!origin) {
      await deps.invalidate(target, 'navigated-away')
      return failure('STALE_TARGET', 'The page left the web')
    }
    target.pendingOrigin = origin
    if (origin === destination) return finishNavigation(target)
    // Redirected to another site: Emperor decides, as for a page that
    // moved by itself.
    return success({
      targetId: target.targetId,
      generation: target.generation,
      origin,
      pending: true,
    })
  }

  async function follow(params) {
    const target = targets.get(params.targetId)
    if (
      !target ||
      target.generation !== params.generation ||
      !target.navigating ||
      target.agentNavigation ||
      !target.pendingOrigin ||
      target.pendingOrigin !== params.origin
    )
      return failure('STALE_TARGET', 'Target has changed')
    return finishNavigation(target)
  }

  async function reportNavigation(target) {
    if (target.reporting) return
    target.reporting = true
    try {
      const tab = await chrome.tabs.get(target.tabId)
      if (targets.get(target.targetId) !== target || !target.navigating) return
      if (target.agentNavigation || tab.status !== 'complete') return
      const origin = safeOrigin(tab.url)
      if (!origin) return void (await deps.invalidate(target, 'navigated-away'))
      if (tab.windowId !== target.windowId)
        return void (await deps.invalidate(target, 'window-transfer'))
      if (target.pendingOrigin === origin) return
      target.pendingOrigin = origin
      await deps.sendEvent('target.navigated', {
        targetId: target.targetId,
        generation: target.generation,
        origin,
      })
    } catch {
      await deps.invalidate(target, 'tab-closed').catch(() => {})
    } finally {
      target.reporting = false
    }
  }

  /** 历史记录 (RV-10): web pages of the history, newest first, bounded. */
  async function searchHistory(params) {
    if (typeof params.text !== 'string')
      return failure('INVALID_ARGUMENT', 'Invalid history search')
    const wanted = Number.isSafeInteger(params.maxResults)
      ? Math.min(Math.max(params.maxResults, 1), 100)
      : 20
    // Chrome looks back only one day unless told otherwise.
    const startTime =
      Number.isFinite(params.startTime) && params.startTime >= 0
        ? params.startTime
        : 0
    // A little more than asked: other schemes are dropped below.
    const items = await chrome.history.search({
      text: params.text.slice(0, 200),
      startTime,
      maxResults: wanted * 2,
    })
    return success({
      items: (Array.isArray(items) ? items : [])
        .filter(
          (item) =>
            typeof item?.url === 'string' &&
            item.url.length <= MAX_URL &&
            safeOrigin(item.url),
        )
        .slice(0, wanted)
        .map((item) => ({
          url: item.url,
          title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
          lastVisitTime: Number.isFinite(item.lastVisitTime)
            ? Math.round(item.lastVisitTime)
            : 0,
          visitCount:
            Number.isSafeInteger(item.visitCount) && item.visitCount >= 0
              ? item.visitCount
              : 0,
        })),
    })
  }

  /** Answer a held download once; a refusal cancels it. */
  function decide(id, allow) {
    const entry = heldDownloads.get(id)
    if (!entry) return false
    heldDownloads.delete(id)
    clearTimeout(entry.timer)
    if (allow) allowedDownloads.set(id, entry.targetId)
    else void Promise.resolve(chrome.downloads.cancel(id)).catch(() => {})
    try {
      entry.suggest()
    } catch {
      // the browser already gave up on it
    }
    return true
  }

  return {
    methods: [
      'tab.open',
      'target.navigate',
      'target.follow',
      'download.resolve',
      'history.search',
    ],

    handles(method) {
      return this.methods.includes(method)
    },

    async request(method, params, signal) {
      if (!isObject(params))
        return failure('INVALID_ARGUMENT', 'Parameters must be an object')
      if (method === 'tab.open') return openTab(params, signal)
      if (method === 'target.navigate') return navigate(params, signal)
      if (method === 'target.follow') return follow(params)
      if (method === 'history.search') return searchHistory(params)
      if (method === 'download.resolve') {
        if (
          !Number.isSafeInteger(params.downloadId) ||
          typeof params.allow !== 'boolean'
        )
          return failure('INVALID_ARGUMENT', 'Invalid download answer')
        return decide(params.downloadId, params.allow)
          ? success({ resolved: true })
          : failure('STALE_TARGET', 'No such download is waiting')
      }
      return failure('CAPABILITY_DISABLED', 'Unsupported fixed method')
    },

    /** The Agent worked in this target (downloads there are its own). */
    touch,

    /** chrome.tabs.onUpdated; true when a target followed the change. */
    onTabUpdated(tabId, changes, tab) {
      for (const waiter of [...(loadWaiters.get(tabId) ?? [])])
        waiter.update(changes, tab)
      const target = targets.get(byTab.get(tabId))
      if (!target) return false
      const moved =
        changes.status === 'loading' ||
        (typeof changes.url === 'string' && changes.url !== target.url)
      if (moved) {
        target.navigating = true
        target.observation = null
        target.pendingOrigin = null
      }
      if (
        target.navigating &&
        !target.agentNavigation &&
        (changes.status === 'complete' ||
          (typeof changes.url === 'string' && tab?.status === 'complete'))
      )
        void reportNavigation(target)
      return true
    },

    /** chrome.downloads.onDeterminingFilename: hold the Agent's downloads. */
    onDeterminingFilename(item, suggest) {
      if (!deps.connected()) return undefined
      const target = downloadSource(item, [...targets.values()], now())
      if (!target || !Number.isSafeInteger(item?.id)) return undefined
      const timer = setTimeout(
        () => decide(item.id, false),
        DOWNLOAD_DECISION_MS,
      )
      heldDownloads.set(item.id, { suggest, timer, targetId: target.targetId })
      void Promise.resolve(
        deps.sendEvent('download.pending', {
          downloadId: item.id,
          targetId: target.targetId,
          generation: target.generation,
          origin: safeOrigin(item.finalUrl || item.url) ?? '',
          filename: basename(item.filename) || 'download',
          mimeType:
            typeof item.mime === 'string' ? item.mime.slice(0, 200) : '',
          bytes:
            Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0
              ? item.totalBytes
              : -1,
          browser: browserBrand(),
        }),
      ).catch(() => decide(item.id, false))
      return true
    },

    /** chrome.downloads.onChanged: report how an allowed download ended. */
    onDownloadChanged(delta) {
      const state = delta?.state?.current
      if (!allowedDownloads.has(delta?.id)) return
      if (state !== 'complete' && state !== 'interrupted') return
      allowedDownloads.delete(delta.id)
      void Promise.resolve(chrome.downloads.search({ id: delta.id }))
        .then(([item] = []) =>
          deps.sendEvent('download.done', {
            downloadId: delta.id,
            state,
            filename: basename(item?.filename) || 'download',
            bytes: Number.isSafeInteger(item?.bytesReceived)
              ? item.bytesReceived
              : 0,
          }),
        )
        .catch(() => {})
    },

    /** The connection ended: refuse what waits, forget the rest. */
    reset() {
      for (const id of [...heldDownloads.keys()]) decide(id, false)
      allowedDownloads.clear()
      for (const list of [...loadWaiters.values()])
        for (const waiter of [...list]) waiter.cancel()
    },
  }
}
