import { ref } from 'vue'
import { api, cloneJson } from '../api/http'
import type { BootstrapPayload, CompactResult, DesktopPetPayload, MemoryPayload, MemoryVersionDetail, ModelConfigPayload, ModelConfigRaw, McpConfigPayload, SkillInfo, WatchlistDecision, WatchlistPayload } from '../types'

export function useBootstrap(showToast: (message: string) => void) {
  const boot = ref<BootstrapPayload | null>(null)
  const loading = ref(true)
  const error = ref('')
  const modelDraftProvider = ref<string | null>(null)
  const activeSkill = ref<string | null>(null)
  const skillContent = ref('')
  const configContent = ref('')
  const mcpContent = ref('')

  async function loadBootstrap(showLoading = true) {
    try {
      if (showLoading) loading.value = true
      error.value = ''
      boot.value = await api<BootstrapPayload>('/api/bootstrap')
      modelDraftProvider.value = boot.value.modelConfig?.config?.agents?.defaults?.provider || null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function refreshMemory(shouldToast = true) {
    if (!boot.value) return
    boot.value.memory = await api<MemoryPayload>('/api/memory')
    if (shouldToast) showToast('记忆与 Token 统计已刷新')
  }

  async function refreshModelConfig() {
    if (!boot.value) return
    boot.value.modelConfig = await api<ModelConfigPayload>('/api/model-config')
    boot.value.model = boot.value.modelConfig.current?.model || boot.value.model
    boot.value.provider = boot.value.modelConfig.current?.provider || boot.value.provider
    modelDraftProvider.value = boot.value.modelConfig.config?.agents?.defaults?.provider || null
  }

  async function saveModelConfig(config: ModelConfigRaw) {
    const data = await api<ModelConfigPayload>('/api/model-config', {
      method: 'POST',
      body: JSON.stringify({ config }),
    })
    if (boot.value) {
      boot.value.modelConfig = data
      boot.value.model = data.current?.model || boot.value.model
      boot.value.provider = data.current?.provider || boot.value.provider
      boot.value.providerLabel = data.current?.providerLabel || boot.value.providerLabel
    }
    modelDraftProvider.value = data.config?.agents?.defaults?.provider || null
    const label = data.current?.entryLabel || data.current?.entryName
    const provider = data.current?.provider || boot.value?.provider || 'provider'
    const model = data.current?.model || boot.value?.model || 'model'
    if (label) {
      showToast(`已切换到「${label}」· ${provider}/${model}`)
    } else {
      showToast(`已切换到 ${provider} / ${model}`)
    }
  }

  async function compactMemory() {
    const data = await api<CompactResult>('/api/compact', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    if (boot.value) {
      boot.value.memory = data.memory
      boot.value.unarchivedHistory = data.unarchivedHistory
    }
    return data
  }

  async function loadSkill(name: string) {
    const data = await api<{ name: string; content: string }>('/api/skill?name=' + encodeURIComponent(name))
    activeSkill.value = data.name
    skillContent.value = data.content
  }

  function startNewSkill(name: string) {
    activeSkill.value = name
    skillContent.value = `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n\n## When to use\n\nUse this skill when...\n`
  }

  async function saveSkill(content: string) {
    if (!activeSkill.value) return
    await api<SkillInfo>('/api/skill', {
      method: 'POST',
      body: JSON.stringify({ name: activeSkill.value, content }),
    })
    await loadBootstrap(false)
    await loadSkill(activeSkill.value)
    showToast('Skill 已保存，并刷新了 Agent 上下文')
  }

  async function deleteSkill(name: string) {
    await api<{ deleted: string }>('/api/skill?name=' + encodeURIComponent(name), {
      method: 'DELETE',
    })
    if (activeSkill.value === name) {
      activeSkill.value = null
      skillContent.value = ''
    }
    await loadBootstrap(false)
    showToast(`Skill「${name}」已删除`)
  }

  async function importSkill(formData: FormData) {
    const data = await api<{ imported: string }>('/api/skills/import', {
      method: 'POST',
      body: formData,
    })
    await loadBootstrap(false)
    showToast(`Skill「${data.imported}」已导入`)
    return data.imported
  }

  async function loadConfig() {
    const data = await api<{ path: string; content: string }>('/api/config')
    configContent.value = data.content
  }

  async function saveConfig(content: string) {
    await api<{ path: string; content: string }>('/api/config', {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    await loadBootstrap(false)
    await loadConfig()
    showToast('配置已保存，并刷新了 Agent 上下文')
  }

  async function loadMcpConfig() {
    const data = await api<McpConfigPayload>('/api/mcp-config')
    mcpContent.value = JSON.stringify(data, null, 2)
  }

  async function saveMcpConfig(content: string) {
    let parsed: McpConfigPayload
    try {
      parsed = JSON.parse(content) as McpConfigPayload
    } catch (e) {
      throw new Error('JSON 格式错误：' + (e instanceof Error ? e.message : String(e)))
    }
    await api<{ saved: boolean }>('/api/mcp-config', {
      method: 'POST',
      body: JSON.stringify(parsed),
    })
    await loadBootstrap(false)
    await loadMcpConfig()
    showToast('MCP 配置已保存，工具已重新加载')
  }

  async function saveMemory(content: string) {
    await api<{ path: string; content: string }>('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    await loadBootstrap(false)
    showToast('长期记忆已保存')
  }

  async function loadEpisode(date: string) {
    return api<{ date: string; content: string }>('/api/memory/episode?date=' + encodeURIComponent(date))
  }

  async function saveEpisode(date: string, content: string) {
    await api<{ date: string; content: string }>('/api/memory/episode', {
      method: 'POST',
      body: JSON.stringify({ date, content }),
    })
    await refreshMemory(false)
    showToast(`情景记忆 ${date} 已保存`)
  }

  async function loadMemoryVersion(id: string) {
    return api<MemoryVersionDetail>('/api/memory/versions/' + encodeURIComponent(id))
  }

  async function restoreMemoryVersion(id: string) {
    const payload = await api<{ restored: { path: string; content: string }; memory: MemoryPayload }>(
      '/api/memory/versions/' + encodeURIComponent(id) + '/restore',
      { method: 'POST', body: JSON.stringify({}) },
    )
    if (boot.value) boot.value.memory = payload.memory
    showToast(`已恢复 ${payload.restored.path}`)
    return payload
  }

  async function saveWatchlist(content: string) {
    const payload = await api<WatchlistPayload>('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    if (boot.value?.memory) boot.value.memory.watchlist = payload
    showToast('Watchlist 已保存')
  }

  async function checkWatchlist() {
    const payload = await api<{ decision: WatchlistDecision; watchlist: WatchlistPayload }>('/api/watchlist/check', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    if (boot.value?.memory) boot.value.memory.watchlist = payload.watchlist
    const action = payload.decision.action === 'run' ? '建议主动执行' : '跳过'
    showToast(`Watchlist 检查完成：${action}`)
    return payload.decision
  }

  async function setDesktopPetEnabled(enabled: boolean) {
    const payload = await api<DesktopPetPayload>('/api/desktop-pet', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    })
    if (boot.value) boot.value.desktopPet = payload
    if (payload.running) {
      showToast('桌宠已启动')
    } else if (payload.enabled && payload.lastError) {
      showToast('桌宠未启动：请先安装 Electron 依赖')
    } else {
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
