import { ref } from 'vue'
import { cloneJson, core } from '../api/http'
import type {
  BootstrapPayload,
  ModelConfigRaw,
  McpConfigPayload,
} from '../types'

export function useBootstrap(showToast: (message: string) => void) {
  const boot = ref<BootstrapPayload | null>(null)
  const loading = ref(true)
  const error = ref('')
  const modelDraftProvider = ref<string | null>(null)
  const activeSkill = ref<string | null>(null)
  const skillContent = ref('')
  const configContent = ref('')
  const mcpContent = ref('')

  async function loadBootstrap(showLoading = true, sessionId = '') {
    try {
      if (showLoading) loading.value = true
      error.value = ''
      const payload = await core('bootstrap', {
        sessionId: sessionId || null,
      })
      boot.value = payload
      modelDraftProvider.value =
        payload.modelConfig?.config?.agents?.defaults?.provider || null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function refreshMemory(shouldToast = true) {
    if (!boot.value) return
    boot.value.memory = await core('memory.get')
    if (shouldToast) showToast('记忆与 Token 统计已刷新')
  }

  async function refreshModelConfig() {
    if (!boot.value) return
    boot.value.modelConfig = await core('model.getConfig')
    boot.value.model = boot.value.modelConfig.current?.model || boot.value.model
    boot.value.provider =
      boot.value.modelConfig.current?.provider || boot.value.provider
    modelDraftProvider.value =
      boot.value.modelConfig.config?.agents?.defaults?.provider || null
  }

  async function saveModelConfig(config: ModelConfigRaw) {
    const data = await core('model.saveConfig', { config })
    if (boot.value) {
      boot.value.modelConfig = data
      boot.value.model = data.current?.model || boot.value.model
      boot.value.provider = data.current?.provider || boot.value.provider
      boot.value.providerLabel =
        data.current?.providerLabel || boot.value.providerLabel
    }
    modelDraftProvider.value = data.config?.agents?.defaults?.provider || null
    const label = data.current?.entryLabel || data.current?.entryName
    const provider =
      data.current?.provider || boot.value?.provider || 'provider'
    const model = data.current?.model || boot.value?.model || 'model'
    if (label) {
      showToast(`已切换到「${label}」· ${provider}/${model}`)
    } else {
      showToast(`已切换到 ${provider} / ${model}`)
    }
  }

  async function compactMemory() {
    const data = await core('memory.compact')
    if (boot.value) {
      boot.value.memory = data.memory
      boot.value.unarchivedHistory = data.unarchivedHistory
    }
    return data
  }

  async function loadSkill(name: string) {
    const data = await core('skills.get', name)
    activeSkill.value = data.name
    skillContent.value = data.content
  }

  function startNewSkill(name: string) {
    activeSkill.value = name
    skillContent.value = `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n\n## When to use\n\nUse this skill when...\n`
  }

  async function saveSkill(content: string) {
    if (!activeSkill.value) return
    await core('skills.save', activeSkill.value, content)
    await loadBootstrap(false)
    await loadSkill(activeSkill.value)
    showToast('Skill 已保存，并刷新了 Agent 上下文')
  }

  async function deleteSkill(name: string) {
    await core('skills.delete', name)
    if (activeSkill.value === name) {
      activeSkill.value = null
      skillContent.value = ''
    }
    await loadBootstrap(false)
    showToast(`Skill「${name}」已删除`)
  }

  async function importSkill(formData: FormData) {
    const file = formData.get('file')
    if (!(file instanceof File))
      throw new Error("Expected multipart field 'file'")
    const data = await core('skills.importArchive', {
      name: file.name,
      mime: file.type || 'application/zip',
      raw: new Uint8Array(await file.arrayBuffer()),
    })
    await loadBootstrap(false)
    showToast(`Skill「${data.imported}」已导入`)
    return data.imported
  }

  async function loadConfig() {
    const data = await core('config.get')
    configContent.value = data.content
  }

  async function saveConfig(content: string) {
    await core('config.save', { content })
    await loadBootstrap(false)
    await loadConfig()
    showToast('配置已保存，并刷新了 Agent 上下文')
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
    if (boot.value) boot.value.desktopPet = payload

    // Open or close the companion pet window via main-process IPC.
    if (enabled) {
      const emperor = (window as any).emperor
      await emperor?.openPet?.()
      showToast(
        payload.lastError ? `桌宠未启动：${payload.lastError}` : '桌宠已启动',
      )
    } else {
      const emperor = (window as any).emperor
      await emperor?.closePet?.()
      showToast('桌宠已关闭')
    }
    return payload
  }

  return {
    boot,
    loading,
    error,
    modelDraftProvider,
    activeSkill,
    skillContent,
    configContent,
    mcpContent,
    loadBootstrap,
    refreshMemory,
    refreshModelConfig,
    saveModelConfig,
    compactMemory,
    loadSkill,
    startNewSkill,
    saveSkill,
    deleteSkill,
    importSkill,
    loadConfig,
    saveConfig,
    loadMcpConfig,
    saveMcpConfig,
    saveMemory,
    loadEpisode,
    saveEpisode,
    loadMemoryVersion,
    restoreMemoryVersion,
    saveWatchlist,
    checkWatchlist,
    setDesktopPetEnabled,
    cloneJson,
  }
}
