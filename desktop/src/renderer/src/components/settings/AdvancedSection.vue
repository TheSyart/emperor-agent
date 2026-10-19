<script setup lang="ts">
/**
 * Settings › 高级 — settings most people leave alone.
 *
 * 网络工具 (KRN-08, settings.json › webTools): the Agent's two web tools.
 * - 网页读取 (`web_fetch`): public pages as Markdown through main's public
 *   HTTP client; on by default.
 * - 网页搜索 (`web_search`): DeepSeek's official Search API, so it follows
 *   the current model — off and disabled, with the reason, on any other
 *   provider.
 * Switching one off takes the tool out of the Agent's tool list and out of
 * 能力 › 工具: after a change the bootstrap tool list (what that page shows)
 * is reloaded. A failed save leaves the switch where it was and says why.
 */
import type { CoreOperationResult } from '@emperor/core/api'
import { computed, onMounted, ref } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import {
  refreshAction,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Switch,
  useSettingsHeader,
} from './ui'

type NetworkTools = CoreOperationResult<'tools.networkSettings'>
type Tool = 'webFetch' | 'webSearch'

const ctx = useAppContext()
const status = ref<NetworkTools | null>(null)
const busy = ref<Tool | null>(null)
const error = ref('')

const fetchAvailable = computed(() => status.value?.webFetch.available === true)
const fetchOn = computed(
  () => fetchAvailable.value && status.value?.webFetch.enabled === true,
)
const searchAvailable = computed(
  () => status.value?.webSearch.available === true,
)
const searchOn = computed(
  () => searchAvailable.value && status.value?.webSearch.enabled === true,
)

const fetchDescription = computed(() =>
  status.value && !fetchAvailable.value
    ? '当前运行环境没有可用的网络客户端。'
    : 'Agent 用 web_fetch 读取公开网页，转成 Markdown 后交给模型。不带 Cookie 和登录状态，拒绝本机与内网地址，单页最多读取 10 MB；网页内容按不可信内容处理。',
)

const searchDescription = computed(() => {
  const search = status.value?.webSearch
  if (!search) return ''
  if (!search.available)
    return `需要模型使用 DeepSeek 官方 API（api.deepseek.com）才能搜索${
      search.model ? `；当前模型「${search.model}」不提供` : ''
    }。`
  if (search.provider === 'deepseek')
    return 'Agent 用 web_search 通过 DeepSeek 官方 Search API 搜索，使用当前模型的 API Key，按次计费；切换到其他供应商的模型时自动停用。'
  return 'Agent 用 web_search 通过应用提供的搜索服务查找网页。'
})

async function load(): Promise<void> {
  try {
    status.value = await core('tools.networkSettings')
    error.value = ''
  } catch (cause) {
    error.value = `读取网络工具设置失败：${message(cause)}`
  }
}

async function set(tool: Tool, enabled: boolean): Promise<void> {
  if (busy.value !== null || !status.value) return
  busy.value = tool
  try {
    status.value = await core('tools.setNetworkSettings', { [tool]: enabled })
    error.value = ''
    await reloadTools()
  } catch (cause) {
    error.value = `保存失败：${message(cause)}`
  } finally {
    busy.value = null
  }
}

/** 能力 › 工具 reads the bootstrap list. */
async function reloadTools(): Promise<void> {
  try {
    const tools = await core('skills.tools')
    if (ctx.boot.value) ctx.boot.value.tools = tools
  } catch {
    // The page reloads its list when it is opened again.
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

useSettingsHeader({
  actions: () => [refreshAction(() => load(), { label: '刷新网络工具状态' })],
})

onMounted(() => void load())
</script>

<template>
  <SettingsSection>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <SettingsGroup
      title="网络工具"
      description="关闭后，对应工具不再出现在 Agent 的工具列表和「能力 › 工具」里。"
      data-group="network-tools"
    >
      <SettingsRow
        title="网页读取"
        :description="fetchDescription"
        label-for="web-tools-fetch"
      >
        <Switch
          id="web-tools-fetch"
          data-tool="web_fetch"
          :model-value="fetchOn"
          :disabled="!fetchAvailable || busy !== null"
          @update:model-value="(value: boolean) => set('webFetch', value)"
        />
      </SettingsRow>
      <SettingsRow
        title="网页搜索"
        :description="searchDescription"
        label-for="web-tools-search"
      >
        <Switch
          id="web-tools-search"
          data-tool="web_search"
          :model-value="searchOn"
          :disabled="!searchAvailable || busy !== null"
          @update:model-value="(value: boolean) => set('webSearch', value)"
        />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.error {
  margin: 0 0 var(--space-3);
  font: var(--font-sm);
  color: rgb(var(--state-error-label));
}
</style>
