import { safeOrigin } from './protocol.js'

const $ = (id) => document.getElementById(id)
let currentTab = null

async function command(kind, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ kind, ...extra })
  if (!reply?.ok) throw new Error(reply?.message || '操作失败')
  return reply.value
}

function render(state) {
  const statusText =
    {
      connected: '已连接 Emperor',
      pairing: '等待 Emperor 确认配对',
      authenticating: '正在验证连接',
      disconnected: '未连接 Emperor',
      unpaired: '尚未配对',
      starting: '正在启动',
      error: '扩展不可用',
    }[state.status] || state.status
  $('status').textContent =
    state.connected && state.attached > 0
      ? `${statusText} · ${state.attached} 个标签页`
      : statusText
  $('pairing').hidden = !state.pairingCode
  $('code').textContent = state.pairingCode || ''
  $('connect').hidden = state.connected || state.status === 'pairing'
  $('pair').hidden = state.paired || state.status === 'pairing'
  $('attach').hidden = !state.connected || !currentTab?.origin
  $('attach').textContent = state.currentTabAttached
    ? '重新连接当前标签页'
    : '连接当前标签页'
  $('disconnect').hidden = !state.connected
  $('forget').hidden = !state.paired
  $('origin').textContent = currentTab?.origin
    ? `当前网站：${currentTab.origin}${state.currentTabAttached ? ' · 标签页已连接' : ' · 标签页未连接'}`
    : '当前标签页不支持连接'
  $('message').textContent = state.detail || ''
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTab =
    tab?.id && safeOrigin(tab.url)
      ? { id: tab.id, origin: safeOrigin(tab.url) }
      : null
  render(await command('status', { tabId: currentTab?.id }))
}

async function run(button, action, success = '') {
  button.disabled = true
  $('message').textContent = ''
  try {
    await action()
    await refresh()
    if (success) $('message').textContent = success
  } catch (cause) {
    const message = cause.message || '操作失败'
    try {
      await refresh()
    } catch {
      /* Preserve the action error when status is also unavailable. */
    }
    $('message').textContent = message
  } finally {
    button.disabled = false
  }
}

$('connect').addEventListener('click', () =>
  run($('connect'), () => command('connect')),
)
$('pair').addEventListener('click', () => run($('pair'), () => command('pair')))
$('disconnect').addEventListener('click', () =>
  run($('disconnect'), () => command('disconnect')),
)
$('forget').addEventListener('click', () =>
  run($('forget'), () => command('forget')),
)
$('attach').addEventListener('click', () =>
  run(
    $('attach'),
    async () => {
      if (!currentTab) throw new Error('当前标签页不支持连接')
      // Exact site origin, requested from this explicit user gesture.
      const granted = await chrome.permissions.request({
        origins: [currentTab.origin + '/*'],
      })
      if (!granted) throw new Error('当前网站权限未获授权')
      await command('attach', { tabId: currentTab.id })
    },
    '当前标签页已连接',
  ),
)

void refresh().catch((cause) => {
  $('message').textContent = cause.message || '扩展不可用'
})

// Pairing is approved in Emperor, outside this popup. Keep an open popup current.
setInterval(() => {
  void refresh().catch(() => {
    // A transient worker restart should not replace the last known status.
  })
}, 2_000)
