/* global chrome */

const FIXTURE_ORIGIN = 'http://127.0.0.1:8765'
const PROTOCOL_VERSION = '1.3'
let pendingAttach = null

async function fixtureTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!Number.isInteger(tab?.id) || !tab.url) {
    throw new Error('请先切到本机测试页')
  }
  let origin
  try {
    origin = new URL(tab.url).origin
  } catch {
    throw new Error('请先切到本机测试页')
  }
  if (origin !== FIXTURE_ORIGIN) throw new Error('只允许本机测试页')
  return tab.id
}

async function state() {
  const saved = await chrome.storage.session.get(['tabId', 'lastDetachReason'])
  return {
    attached: Number.isInteger(saved.tabId),
    tabId: saved.tabId ?? null,
    lastDetachReason: saved.lastDetachReason ?? null,
  }
}

async function handle(type) {
  if (type === 'status') return await state()
  if (type === 'attach') {
    const current = await state()
    if (current.attached) throw new Error('请先结束上一条调试连接')
    const tabId = await fixtureTabId()
    pendingAttach = { tabId, detachReason: null }
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
      if (pendingAttach.detachReason) {
        await chrome.storage.session.set({
          lastDetachReason: pendingAttach.detachReason,
        })
        return await state()
      }
      await chrome.storage.session.set({ tabId, lastDetachReason: null })
      if (pendingAttach.detachReason) {
        await chrome.storage.session.set({
          lastDetachReason: pendingAttach.detachReason,
        })
        await chrome.storage.session.remove('tabId')
      }
      return await state()
    } catch (error) {
      await chrome.debugger.detach({ tabId }).catch(() => undefined)
      throw error
    } finally {
      pendingAttach = null
    }
  }
  if (type === 'detach') {
    const current = await state()
    if (!current.attached) return current
    try {
      await chrome.debugger.detach({ tabId: current.tabId })
    } finally {
      await chrome.storage.session.remove('tabId')
    }
    return await state()
  }
  throw new Error('未知实验命令')
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handle(message?.type).then(
    (result) => sendResponse(result),
    (error) => sendResponse({ error: error?.message ?? String(error) }),
  )
  return true
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === pendingAttach?.tabId) {
    pendingAttach.detachReason = reason
    return
  }
  void chrome.storage.session.get('tabId').then(async ({ tabId }) => {
    if (source.tabId !== tabId) return
    await chrome.storage.session.set({ lastDetachReason: reason })
    await chrome.storage.session.remove('tabId')
  })
})
