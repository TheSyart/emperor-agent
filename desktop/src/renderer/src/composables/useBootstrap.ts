import { ref } from 'vue'
import { core } from '../api/http'
import type { BootstrapPayload, McpConfigPayload } from '../types'

export interface BootstrapOptions {
  /**
   * The session asked for could not be bootstrapped (archived or deleted
   * elsewhere) and a plain bootstrap worked instead: move off it (FIX-03).
   */
  onSessionUnavailable?: (sessionId: string) => void
}

/**
 * The app's bootstrap payload and the actions that reload it (FIX-03):
 * only a failed first start replaces the app with the full-screen error;
 * a refresh that fails later keeps the shell and toasts. A bootstrap for a
 * session that fails is retried once without it, and the session reported
 * unavailable; 「重新连接」 (`retry`) always starts without a session.
 */
export function useBootstrap(
  showToast: (message: string) => void,
  options: BootstrapOptions = {},
) {
  const boot = ref<BootstrapPayload | null>(null)
  const loading = ref(true)
  const error = ref('')
  const configContent = ref('')
  const mcpContent = ref('')
  ;(window as any).emperor?.onPetStatus?.(
    (status: { open?: boolean; error?: string | null }) => {
      if (!boot.value?.desktopPet) return
      boot.value.desktopPet.running = Boolean(status?.open)
      boot.value.desktopPet.lastError = status?.error || null
    },
  )

  async function fetchBootstrap(sessionId: string): Promise<void> {
    const payload = await core('bootstrap', {
      sessionId: sessionId || null,
    })
    if (payload.desktopPet) {
      const status = await (window as any).emperor?.petStatus?.()
      payload.desktopPet.running = Boolean(status?.open)
      payload.desktopPet.lastError = status?.error || null
    }
    boot.value = {
      ...payload,
      control: payload.control as unknown as BootstrapPayload['control'],
    }
  }

  /** Load the payload; false when it failed (shown as described above). */
  async function loadBootstrap(
    showLoading = true,
    sessionId = '',
  ): Promise<boolean> {
    const started = boot.value !== null
    try {
      if (showLoading) loading.value = true
      if (!started) error.value = ''
      try {
        await fetchBootstrap(sessionId)
      } catch (first) {
        if (!sessionId) throw first
        await fetchBootstrap('')
        options.onSessionUnavailable?.(sessionId)
      }
      error.value = ''
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (started) showToast(`刷新失败：${message}`)
      else error.value = message
      return false
    } finally {
      loading.value = false
    }
  }

  /** 「重新连接」: a plain bootstrap, never the session that failed. */
  function retry(): Promise<boolean> {
    return loadBootstrap(false, '')
  }

  async function refreshMemory(shouldToast = true) {
    if (!boot.value) return
    boot.value.memory = await core('memory.get')
    if (shouldToast) showToast('记忆与 Token 统计已刷新')
  }

  async function startProfileInterview() {
    const result = await core('onboarding.startProfileInterview')
    if (boot.value) boot.value.profileOnboarding = result.state
    return result
  }

  async function skipProfileInterview() {
    const result = await core('onboarding.skipProfileInterview')
    if (boot.value) boot.value.profileOnboarding = result.state
    showToast('已关闭个人档案访谈提醒')
    return result
  }

  async function compactMemory() {
    const data = await core('memory.compact')
    if (boot.value) {
      boot.value.memory = data.memory
      boot.value.unarchivedHistory = data.unarchivedHistory
    }
    return data
  }

  async function loadConfig() {
    const data = await core('config.get')
    configContent.value = data.content
  }

  async function saveConfig(content: string) {
    await core('config.save', { content })
    await loadBootstrap(false)
    await loadConfig()
    showToast('用户档案已保存，并刷新了 Agent 上下文')
  }

  async function loadMcpConfig() {
    const data = await core('mcp.getConfig')
    mcpContent.value = JSON.stringify(data, null, 2)
  }

  async function saveMcpConfig(content: string) {
    let parsed: McpConfigPayload
    try {
      parsed = JSON.parse(content) as McpConfigPayload
    } catch (e) {
      throw new Error(
        'JSON 格式错误：' + (e instanceof Error ? e.message : String(e)),
      )
    }
    await core('mcp.saveConfig', parsed)
    await loadBootstrap(false)
    await loadMcpConfig()
    showToast('MCP 配置已保存，工具已重新加载')
  }

  async function saveMemory(content: string) {
    await core('memory.save', content)
    await loadBootstrap(false)
    showToast('长期记忆已保存')
  }

  async function loadEpisode(date: string) {
    return core('memory.getEpisode', date)
  }

  async function saveEpisode(date: string, content: string) {
    await core('memory.saveEpisode', content, date)
    await refreshMemory(false)
    showToast(`情景记忆 ${date} 已保存`)
  }

  async function loadMemoryVersion(id: string) {
    return core('memory.getVersion', id)
  }

  async function restoreMemoryVersion(id: string) {
    const payload = await core('memory.restoreVersion', id)
    if (boot.value) boot.value.memory = payload.memory
    showToast(`已恢复 ${payload.restored.path}`)
    return payload
  }

  async function saveWatchlist(content: string) {
    const payload = await core('memory.saveWatchlist', content)
    if (boot.value?.memory) boot.value.memory.watchlist = payload
    showToast('Watchlist 已保存')
  }

  async function checkWatchlist() {
    const payload = await core('memory.checkWatchlist')
    if (boot.value?.memory) boot.value.memory.watchlist = payload.watchlist
    const action = payload.decision.action === 'run' ? '建议主动执行' : '跳过'
    showToast(`Watchlist 检查完成：${action}`)
    return payload.decision
  }

  async function setDesktopPetEnabled(enabled: boolean) {
    const payload = await core('desktopPet.setEnabled', enabled)
    const emperor = (window as any).emperor
    let windowStatus: { open?: boolean; error?: string } | undefined
    if (enabled) {
      windowStatus = await emperor?.openPet?.()
      showToast(
        windowStatus?.error
          ? `桌宠未启动：${windowStatus.error}`
          : '桌宠已启动',
      )
    } else {
      windowStatus = await emperor?.closePet?.()
      showToast('桌宠已关闭')
    }
    payload.running = Boolean(windowStatus?.open)
    payload.lastError = windowStatus?.error || null
    if (boot.value) boot.value.desktopPet = payload
    return payload
  }

  return {
    boot,
    loading,
    error,
    configContent,
    mcpContent,
    loadBootstrap,
    retry,
    refreshMemory,
    startProfileInterview,
    skipProfileInterview,
    compactMemory,
    loadConfig,
    saveConfig,
    saveMcpConfig,
    saveMemory,
    loadEpisode,
    saveEpisode,
    loadMemoryVersion,
    restoreMemoryVersion,
    saveWatchlist,
    checkWatchlist,
    setDesktopPetEnabled,
  }
}
