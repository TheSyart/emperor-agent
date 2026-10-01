// Onboarding page: opened once the extension is loaded (and again when
// Emperor no longer knows its pairing). Step 1 asks for every site in the
// click itself; step 2 starts pairing and shows the code to compare in
// Emperor, where the user clicks 允许.
import { SITE_ORIGINS } from './protocol.js'

const $ = (id) => document.getElementById(id)
const EMPTY = { status: 'starting', paired: false, connected: false }
let sites = false
let latest = EMPTY
let failure = ''

async function command(kind) {
  const reply = await chrome.runtime.sendMessage({ kind })
  if (!reply?.ok) throw new Error(reply?.message || '操作失败')
  return reply.value
}

/** A worker error, in words the user can act on. */
function explain(message) {
  if (/native host|not running|not installed/i.test(message))
    return '连不上 Emperor：请打开 Emperor，并在「设置 › 电脑操作 › Chrome 和 Edge」点过「安装扩展程序」，再点「连接 Emperor」。'
  if (/already paired/i.test(message)) return ''
  return message || '操作失败'
}

/** The worker's own note, when it is meant for the user. */
function detailText(detail) {
  if (!detail) return ''
  if (detail === 'Pairing rejected in Emperor')
    return 'Emperor 拒绝了这次配对；需要时再点「连接 Emperor」。'
  if (/native host/i.test(detail)) return explain(detail)
  return /[一-鿿]/.test(detail) ? detail : ''
}

function formatCode(code) {
  return typeof code === 'string' && code.length === 6
    ? `${code.slice(0, 3)} ${code.slice(3)}`
    : ''
}

function statusText(state) {
  if (state.connected) return '已连接 Emperor'
  if (state.pairingCode) return '等待你在 Emperor 中点「允许」'
  if (state.status === 'authenticating') return '正在连接 Emperor…'
  if (state.paired) return '已配对，等 Emperor 打开后自动连接'
  return ''
}

function render(state) {
  latest = state
  const connected = state.connected === true
  const waiting = Boolean(state.pairingCode) || state.status === 'pairing'
  $('step-sites').dataset.state = sites ? 'done' : 'now'
  $('step-pair').dataset.state = connected ? 'done' : sites ? 'now' : 'todo'
  $('allow').hidden = sites
  $('code').textContent = formatCode(state.pairingCode)
  $('code').hidden = connected || !state.pairingCode
  $('pair').hidden = !sites || state.paired === true || waiting
  $('done').hidden = !connected
  $('status').textContent = statusText(state)
  $('message').textContent = connected
    ? ''
    : failure || (waiting ? '' : detailText(state.detail))
}

async function refresh() {
  render(await command('status'))
}

async function startPairing() {
  failure = ''
  $('pair').disabled = true
  try {
    render(await command('pair'))
  } catch (cause) {
    failure = explain(cause?.message || '')
    await refresh().catch(() => render(latest))
  } finally {
    $('pair').disabled = false
  }
}

$('allow').addEventListener('click', () => {
  // The browser shows its prompt only for a request made inside the click.
  const asked = chrome.permissions.request({ origins: SITE_ORIGINS })
  $('allow').disabled = true
  failure = ''
  return asked
    .then(async (granted) => {
      if (!granted) {
        failure = '没有获得访问网站的权限；需要时再点「允许访问网站」。'
        render(latest)
        return
      }
      sites = true
      await startPairing()
    })
    .catch((cause) => {
      failure = cause?.message || '无法申请访问网站的权限'
      render(latest)
    })
    .finally(() => {
      $('allow').disabled = false
    })
})

$('pair').addEventListener('click', () => startPairing())

async function start() {
  sites = await chrome.permissions
    .contains({ origins: SITE_ORIGINS })
    .catch(() => false)
  await refresh()
}

void start().catch((cause) => {
  $('message').textContent = cause?.message || '扩展不可用'
})

// Pairing is approved in Emperor; keep this page current while it waits.
setInterval(() => {
  void refresh().catch(() => {
    // A worker restart should not replace the last known state.
  })
}, 1_000)
