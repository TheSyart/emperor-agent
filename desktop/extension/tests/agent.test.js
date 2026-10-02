import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOWNLOAD_WINDOW_MS,
  GROUP_TITLE,
  basename,
  createAgentFeatures,
  downloadSource,
} from '../agent.js'

function event() {
  const listeners = []
  return {
    addListener(fn) {
      listeners.push(fn)
    },
    fire(...args) {
      for (const fn of listeners) fn(...args)
    },
  }
}

async function settle() {
  for (let index = 0; index < 20; index += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** A browser with tabs that load when told to, and an Emperor connection. */
function harness(options = {}) {
  const tabs = new Map()
  const groups = []
  const grouped = []
  const sent = []
  const searched = []
  const cancelled = []
  const created = []
  const updates = []
  let nextTab = 40
  let generation = 10
  let clock = 1_000_000
  const permitted = options.permitted ?? (() => true)
  const targets = new Map()
  const byTab = new Map()
  const chrome = {
    tabs: {
      get: async (id) => {
        const tab = tabs.get(id)
        if (!tab) throw new Error('No tab')
        return { ...tab }
      },
      create: async ({ url, active }) => {
        const tab = {
          id: ++nextTab,
          windowId: 3,
          url: '',
          pendingUrl: url,
          status: 'loading',
        }
        tabs.set(tab.id, tab)
        created.push({ url, active })
        return { ...tab }
      },
      update: async (id, { url }) => {
        updates.push([id, url])
        return { ...tabs.get(id) }
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        if (groupId !== undefined) {
          grouped.push([groupId, tabIds])
          return groupId
        }
        const group = {
          id: 100 + groups.length,
          windowId: createProperties.windowId,
          title: '',
        }
        groups.push(group)
        grouped.push([group.id, tabIds])
        return group.id
      },
    },
    tabGroups: {
      query: async ({ windowId, title }) =>
        groups.filter(
          (group) => group.windowId === windowId && group.title === title,
        ),
      update: async (id, { title, color }) => {
        const group = groups.find((item) => item.id === id)
        group.title = title
        group.color = color
      },
    },
    permissions: {
      contains: async ({ origins }) => permitted(origins[0]),
    },
    downloads: {
      cancel: async (id) => {
        cancelled.push(id)
      },
      search: async ({ id }) => [
        {
          id,
          filename: '/Users/me/Downloads/report (1).pdf',
          bytesReceived: 2048,
        },
      ],
    },
    history: {
      search: async (query) => {
        searched.push(query)
        return [
          {
            id: '1',
            url: 'https://github.com/emperor/issues/7?tab=1',
            title: 'Issue 7 '.repeat(60),
            lastVisitTime: 1_700_000_000_123.4,
            visitCount: 3,
            typedCount: 1,
          },
          { id: '2', url: 'chrome://settings/', title: 'Settings' },
          { id: '3', url: 'file:///Users/me/notes.txt', title: 'notes' },
          {
            id: '4',
            url: 'https://news.example/today',
            lastVisitTime: 1_699_000_000_000,
          },
        ]
      },
    },
  }
  const agent = createAgentFeatures({
    chrome,
    targets,
    byTab,
    connected: () => options.connected ?? true,
    sendEvent: async (name, data) => {
      sent.push({ name, data })
    },
    nextGeneration: async () => ++generation,
    identify: async (tabId) =>
      tabs.has(tabId) ? `document-${tabId}-${tabs.get(tabId).url}` : null,
    invalidate: async (target, reason) => {
      targets.delete(target.targetId)
      byTab.delete(target.tabId)
      sent.push({
        name: 'target.lost',
        data: { targetId: target.targetId, reason },
      })
    },
    currentTarget: async (params) => {
      const target = targets.get(params.targetId)
      return target &&
        target.generation === params.generation &&
        !target.navigating
        ? target
        : null
    },
    now: () => clock,
  })
  /** The browser reports a tab change, as chrome.tabs.onUpdated would. */
  function change(id, changes) {
    const tab = tabs.get(id)
    Object.assign(tab, changes)
    agent.onTabUpdated(id, changes, { ...tab })
  }
  function load(id, url) {
    change(id, { status: 'loading', url })
    change(id, { status: 'complete' })
  }
  function attach(id, url) {
    tabs.set(id, { id, windowId: 3, url, status: 'complete' })
    const target = {
      targetId: `target-${id}`,
      tabId: id,
      windowId: 3,
      origin: new URL(url).origin,
      url,
      generation: 5,
      revision: 2,
      documentId: `document-${id}`,
      observation: null,
    }
    targets.set(target.targetId, target)
    byTab.set(id, target.targetId)
    return target
  }
  return {
    agent,
    searched,
    tabs,
    groups,
    grouped,
    sent,
    cancelled,
    created,
    updates,
    targets,
    byTab,
    change,
    load,
    attach,
    tick: (ms) => {
      clock += ms
    },
    get clock() {
      return clock
    },
  }
}

test('names a file and attributes a download to the tab the Agent just used', () => {
  assert.equal(basename('/Users/me/Downloads/report.pdf'), 'report.pdf')
  assert.equal(basename('C:\\Users\\me\\report.pdf'), 'report.pdf')
  assert.equal(basename(''), '')
  const now = 5_000_000
  const agentTab = {
    origin: 'https://files.example',
    lastActiveAt: now - 1_000,
  }
  const idleTab = { origin: 'https://files.example', lastActiveAt: 0 }
  const item = (fields) => ({
    startTime: new Date(now).toISOString(),
    ...fields,
  })
  assert.equal(
    downloadSource(
      item({ referrer: 'https://files.example/list?q=1' }),
      [idleTab, agentTab],
      now,
    ),
    agentTab,
  )
  // A blob made by the page carries the page's origin.
  assert.equal(
    downloadSource(
      item({ url: 'blob:https://files.example/0f1e' }),
      [agentTab],
      now,
    ),
    agentTab,
  )
  // Another site, no recent Agent work, or no way to tell: the user's own.
  assert.equal(
    downloadSource(
      item({ referrer: 'https://other.example/' }),
      [agentTab],
      now,
    ),
    null,
  )
  assert.equal(
    downloadSource(
      item({ referrer: 'https://files.example/' }),
      [idleTab],
      now,
    ),
    null,
  )
  assert.equal(
    downloadSource(
      item({ referrer: 'https://files.example/' }),
      [{ ...agentTab, lastActiveAt: now - DOWNLOAD_WINDOW_MS - 1 }],
      now,
    ),
    null,
  )
  assert.equal(
    downloadSource(item({ url: 'data:text/plain,hi' }), [agentTab], now),
    null,
  )
})

test('opens a tab in the background, in the tab group Emperor, and makes it a target', async () => {
  const h = harness()
  const opening = h.agent.request(
    'tab.open',
    { url: 'https://github.com/emperor?tab=1' },
    new AbortController().signal,
  )
  await settle()
  assert.deepEqual(h.created, [
    { url: 'https://github.com/emperor?tab=1', active: false },
  ])
  h.load(41, 'https://github.com/emperor?tab=1')
  const opened = await opening
  assert.equal(opened.ok, true)
  assert.deepEqual(Object.keys(opened.value).sort(), [
    'generation',
    'origin',
    'tabId',
    'targetId',
    'windowId',
  ])
  assert.equal(opened.value.origin, 'https://github.com')
  assert.equal(opened.value.tabId, 41)
  assert.equal(opened.value.generation, 11)
  assert.deepEqual(h.groups, [
    { id: 100, windowId: 3, title: GROUP_TITLE, color: 'purple' },
  ])
  const target = h.targets.get(opened.value.targetId)
  assert.equal(h.byTab.get(41), opened.value.targetId)
  assert.equal(target.lastActiveAt, h.clock)
  // The next tab joins the same group.
  const second = h.agent.request(
    'tab.open',
    { url: 'https://docs.github.com/' },
    new AbortController().signal,
  )
  await settle()
  h.load(42, 'https://docs.github.com/')
  assert.equal((await second).ok, true)
  assert.deepEqual(h.grouped.at(-1), [100, [42]])
  assert.equal(h.groups.length, 1)
})

test('refuses to open what it cannot read, before any tab exists', async () => {
  const h = harness({
    permitted: (origin) => origin !== 'https://bank.example/*',
  })
  const refused = await h.agent.request(
    'tab.open',
    { url: 'https://bank.example/' },
    new AbortController().signal,
  )
  assert.equal(refused.error.code, 'PERMISSION_REQUIRED')
  const invalid = await h.agent.request(
    'tab.open',
    { url: 'file:///etc/hosts' },
    new AbortController().signal,
  )
  assert.equal(invalid.error.code, 'INVALID_ARGUMENT')
  assert.deepEqual(h.created, [])
})

test('goes to a URL the Agent asked for and keeps the target under a new generation', async () => {
  const h = harness()
  const target = h.attach(7, 'https://github.com/a')
  const going = h.agent.request(
    'target.navigate',
    { targetId: target.targetId, generation: 5, url: 'https://github.com/b' },
    new AbortController().signal,
  )
  await settle()
  assert.deepEqual(h.updates, [[7, 'https://github.com/b']])
  // While it loads the target refuses work.
  assert.equal(target.navigating, true)
  h.load(7, 'https://github.com/b')
  const done = await going
  assert.equal(done.ok, true)
  assert.deepEqual(done.value, {
    targetId: target.targetId,
    generation: 11,
    origin: 'https://github.com',
    revision: 2,
  })
  assert.equal(target.navigating, false)
  assert.equal(target.url, 'https://github.com/b')
  assert.equal(target.documentId, 'document-7-https://github.com/b')
  // The page's own navigation events are not reported for this one.
  assert.equal(
    h.sent.some((item) => item.name === 'target.navigated'),
    false,
  )
})

test('leaves the decision to Emperor when the Agent’s navigation ends up elsewhere', async () => {
  const h = harness()
  const target = h.attach(7, 'https://github.com/a')
  const going = h.agent.request(
    'target.navigate',
    {
      targetId: target.targetId,
      generation: 5,
      url: 'https://short.example/x',
    },
    new AbortController().signal,
  )
  await settle()
  h.load(7, 'https://landing.example/promo?id=9')
  const pending = await going
  assert.deepEqual(pending.value, {
    targetId: target.targetId,
    generation: 5,
    origin: 'https://landing.example',
    pending: true,
  })
  assert.equal(target.navigating, true)
  const followed = await h.agent.request('target.follow', {
    targetId: target.targetId,
    generation: 5,
    origin: 'https://landing.example',
  })
  assert.equal(followed.ok, true)
  assert.equal(followed.value.generation, 11)
})

test('refuses a navigation it could not follow, before it happens', async () => {
  const h = harness({
    permitted: (origin) => origin !== 'https://bank.example/*',
  })
  const target = h.attach(7, 'https://github.com/a')
  for (const [url, code] of [
    ['https://bank.example/', 'PERMISSION_REQUIRED'],
    ['javascript:alert(1)', 'INVALID_ARGUMENT'],
  ]) {
    const result = await h.agent.request(
      'target.navigate',
      { targetId: target.targetId, generation: 5, url },
      new AbortController().signal,
    )
    assert.equal(result.error.code, code)
  }
  assert.deepEqual(h.updates, [])
  assert.equal(target.navigating, undefined)
})

test('reports a page that moved by itself with its origin only, then follows when Emperor says so', async () => {
  const h = harness()
  const target = h.attach(7, 'https://github.com/a')
  h.change(7, {
    status: 'loading',
    url: 'https://evil.example/login?token=secret',
  })
  assert.equal(target.navigating, true)
  assert.equal(h.sent.length, 0)
  h.change(7, { status: 'complete' })
  await settle()
  assert.deepEqual(h.sent, [
    {
      name: 'target.navigated',
      data: {
        targetId: target.targetId,
        generation: 5,
        origin: 'https://evil.example',
      },
    },
  ])
  assert.equal(JSON.stringify(h.sent).includes('secret'), false)
  // A stale decision (another origin) is refused.
  assert.equal(
    (
      await h.agent.request('target.follow', {
        targetId: target.targetId,
        generation: 5,
        origin: 'https://github.com',
      })
    ).error.code,
    'STALE_TARGET',
  )
  const followed = await h.agent.request('target.follow', {
    targetId: target.targetId,
    generation: 5,
    origin: 'https://evil.example',
  })
  assert.equal(followed.value.generation, 11)
  assert.equal(target.origin, 'https://evil.example')
  // Following is not Agent work: downloads there stay the user's own.
  assert.equal(target.lastActiveAt, undefined)
})

test('drops a target whose page left the web', async () => {
  const h = harness()
  const target = h.attach(7, 'https://github.com/a')
  h.load(7, 'chrome://settings')
  await settle()
  assert.equal(h.targets.has(target.targetId), false)
  assert.deepEqual(h.sent.at(-1), {
    name: 'target.lost',
    data: { targetId: target.targetId, reason: 'navigated-away' },
  })
})

test('holds a download from the Agent’s tab until Emperor decides', async () => {
  const h = harness()
  const target = h.attach(7, 'https://files.example/list')
  h.agent.touch(target)
  const suggested = []
  const held = h.agent.onDeterminingFilename(
    {
      id: 31,
      url: 'https://cdn.files.example/r.pdf?sig=secret',
      referrer: 'https://files.example/list',
      filename: '/Users/me/Downloads/r.pdf',
      mime: 'application/pdf',
      totalBytes: 2048,
      startTime: new Date(h.clock).toISOString(),
    },
    () => suggested.push(31),
  )
  assert.equal(held, true)
  await settle()
  assert.equal(h.sent.at(-1).name, 'download.pending')
  assert.deepEqual(h.sent.at(-1).data, {
    downloadId: 31,
    targetId: target.targetId,
    generation: 5,
    origin: 'https://cdn.files.example',
    filename: 'r.pdf',
    mimeType: 'application/pdf',
    bytes: 2048,
    browser: 'chrome',
  })
  assert.equal(JSON.stringify(h.sent).includes('sig=secret'), false)
  assert.deepEqual(suggested, [])
  const resolved = await h.agent.request('download.resolve', {
    downloadId: 31,
    allow: true,
  })
  assert.equal(resolved.ok, true)
  assert.deepEqual(suggested, [31])
  assert.deepEqual(h.cancelled, [])
  h.agent.onDownloadChanged({ id: 31, state: { current: 'complete' } })
  await settle()
  assert.deepEqual(h.sent.at(-1), {
    name: 'download.done',
    data: {
      downloadId: 31,
      state: 'complete',
      filename: 'report (1).pdf',
      bytes: 2048,
    },
  })
  // Answered once only.
  assert.equal(
    (await h.agent.request('download.resolve', { downloadId: 31, allow: true }))
      .error.code,
    'STALE_TARGET',
  )
})

test('cancels a refused download, and leaves the user’s own downloads alone', async () => {
  const h = harness()
  const target = h.attach(7, 'https://files.example/list')
  h.agent.touch(target)
  const suggested = []
  h.agent.onDeterminingFilename(
    {
      id: 32,
      url: 'https://files.example/setup.dmg',
      referrer: 'https://files.example/list',
      filename: 'setup.dmg',
      startTime: new Date(h.clock).toISOString(),
    },
    () => suggested.push(32),
  )
  await settle()
  await h.agent.request('download.resolve', { downloadId: 32, allow: false })
  assert.deepEqual(h.cancelled, [32])
  assert.deepEqual(suggested, [32])
  h.agent.onDownloadChanged({ id: 32, state: { current: 'interrupted' } })
  await settle()
  assert.equal(
    h.sent.some((item) => item.name === 'download.done'),
    false,
  )
  const before = h.sent.length
  assert.equal(
    h.agent.onDeterminingFilename(
      {
        id: 33,
        url: 'https://other.example/a.zip',
        referrer: 'https://other.example/',
        filename: 'a.zip',
        startTime: new Date(h.clock).toISOString(),
      },
      () => {},
    ),
    undefined,
  )
  assert.equal(h.sent.length, before)
})

test('refuses held downloads when the connection to Emperor ends', async () => {
  const h = harness()
  const target = h.attach(7, 'https://files.example/list')
  h.agent.touch(target)
  const suggested = []
  h.agent.onDeterminingFilename(
    {
      id: 34,
      url: 'https://files.example/a.csv',
      referrer: 'https://files.example/list',
      filename: 'a.csv',
      startTime: new Date(h.clock).toISOString(),
    },
    () => suggested.push(34),
  )
  await settle()
  h.agent.reset()
  assert.deepEqual(h.cancelled, [34])
  assert.deepEqual(suggested, [34])
  const offline = harness({ connected: false })
  const tab = offline.attach(7, 'https://files.example/list')
  offline.agent.touch(tab)
  assert.equal(
    offline.agent.onDeterminingFilename(
      {
        id: 35,
        url: 'https://files.example/a.csv',
        referrer: 'https://files.example/list',
        filename: 'a.csv',
        startTime: new Date(offline.clock).toISOString(),
      },
      () => {},
    ),
    undefined,
  )
})

test('searches the history for Emperor: web pages only, bounded, nothing else', async () => {
  const h = harness()
  const result = await h.agent.request('history.search', {
    text: 'issue'.repeat(100),
    startTime: 1_690_000_000_000,
    maxResults: 2,
  })
  assert.equal(result.ok, true)
  // Asks the browser for a little more, as non-web pages are dropped.
  assert.deepEqual(h.searched, [
    {
      text: 'issue'.repeat(100).slice(0, 200),
      startTime: 1_690_000_000_000,
      maxResults: 4,
    },
  ])
  assert.deepEqual(result.value.items, [
    {
      url: 'https://github.com/emperor/issues/7?tab=1',
      title: 'Issue 7 '.repeat(60).slice(0, 200),
      lastVisitTime: 1_700_000_000_123,
      visitCount: 3,
    },
    {
      url: 'https://news.example/today',
      title: '',
      lastVisitTime: 1_699_000_000_000,
      visitCount: 0,
    },
  ])
  // Defaults: from the epoch only when asked; 20 pages; at most 100.
  await h.agent.request('history.search', { text: '' })
  await h.agent.request('history.search', { text: 'x', maxResults: 5000 })
  assert.deepEqual(h.searched.slice(1), [
    { text: '', startTime: 0, maxResults: 40 },
    { text: 'x', startTime: 0, maxResults: 200 },
  ])
  assert.equal(
    (await h.agent.request('history.search', { text: 7 })).error.code,
    'INVALID_ARGUMENT',
  )
})
