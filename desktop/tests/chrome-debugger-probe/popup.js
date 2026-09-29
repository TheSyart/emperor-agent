/* global chrome */

const status = document.querySelector('#status')
const attach = document.querySelector('#attach')
const detach = document.querySelector('#detach')

async function request(type) {
  const result = await chrome.runtime.sendMessage({ type })
  if (!result || result.error)
    throw new Error(result?.error ?? '实验扩展未响应')
  return result
}

async function refresh() {
  try {
    const state = await request('status')
    attach.disabled = state.attached
    detach.disabled = !state.attached
    status.textContent = state.attached
      ? `调试连接已附着到测试标签页 ${state.tabId}。关闭弹窗后可观察 Chrome 提示条。`
      : state.lastDetachReason
        ? `已断开；Chrome 原因：${state.lastDetachReason}`
        : '未附着'
  } catch (error) {
    status.textContent = error.message
  }
}

attach.addEventListener('click', async () => {
  try {
    await request('attach')
    await refresh()
  } catch (error) {
    status.textContent = error.message
  }
})

detach.addEventListener('click', async () => {
  try {
    await request('detach')
    await refresh()
  } catch (error) {
    status.textContent = error.message
  }
})

void refresh()
