<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { cloneJson } from '../../api/http'
import type { ModelConfigPayload, ModelConfigRaw, ProviderOption } from '../../types'
import { actionAssets, brandAssets } from '../../assets'

const props = defineProps<{ payload: ModelConfigPayload | null }>()
const emit = defineEmits<{ save: [config: ModelConfigRaw]; error: [message: string] }>()

const selectedProvider = ref('deepseek')
const draft = reactive({
  model: 'deepseek-v4-flash',
  apiBase: '',
  apiKey: '',
  temperature: 0.1,
  maxTokens: 20000,
  reasoningEffort: '',
  contextWindowTokens: 200000,
  extraHeaders: '',
  extraBody: '',
})

const options = computed(() => props.payload?.providerOptions || [])
const current = computed(() => props.payload?.current)

function optionLabel(option: ProviderOption) {
  return `${option.displayName || option.display_name || option.name} · ${option.backend || 'provider'}`
}

function formatOptionalJson(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  return JSON.stringify(value, null, 2)
}

function hydrate() {
  const defaults = props.payload?.config?.agents?.defaults || {}
  selectedProvider.value = defaults.provider || props.payload?.current?.provider || 'deepseek'
  draft.model = defaults.model || props.payload?.current?.model || 'deepseek-v4-flash'
  draft.temperature = Number(defaults.temperature ?? props.payload?.current?.temperature ?? 0.1)
  draft.maxTokens = Number(defaults.maxTokens ?? props.payload?.current?.maxTokens ?? 20000)
  draft.reasoningEffort = defaults.reasoningEffort || props.payload?.current?.reasoningEffort || ''
  draft.contextWindowTokens = Number(defaults.contextWindowTokens ?? props.payload?.current?.contextWindowTokens ?? 200000)
  hydrateProvider()
}

function hydrateProvider() {
  const provider = props.payload?.config?.providers?.[selectedProvider.value] || {}
  draft.apiBase = String(provider.apiBase || props.payload?.current?.apiBase || '')
  draft.apiKey = String(provider.apiKey || '')
  draft.extraHeaders = formatOptionalJson(provider.extraHeaders)
  draft.extraBody = formatOptionalJson(provider.extraBody)
}

watch(() => props.payload, hydrate, { immediate: true, deep: true })
watch(selectedProvider, hydrateProvider)

function parseOptionalJson(raw: string, label: string) {
  const text = raw.trim()
  if (!text) return null
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  return parsed as Record<string, unknown>
}

function save() {
  try {
    const config = cloneJson<ModelConfigRaw>(props.payload?.config || {})
    config.agents ||= {}
    config.agents.defaults ||= {}
    config.providers ||= {}

    config.agents.defaults.provider = selectedProvider.value
    config.agents.defaults.model = draft.model.trim() || 'deepseek-v4-flash'
    config.agents.defaults.temperature = Number.isFinite(draft.temperature) ? Number(draft.temperature) : 0.1
    config.agents.defaults.maxTokens = Number.isFinite(draft.maxTokens) ? Number(draft.maxTokens) : 20000
    config.agents.defaults.contextWindowTokens = Number.isFinite(draft.contextWindowTokens) ? Number(draft.contextWindowTokens) : 200000
    config.agents.defaults.reasoningEffort = draft.reasoningEffort || null

    config.providers[selectedProvider.value] ||= {}
    config.providers[selectedProvider.value].apiBase = draft.apiBase.trim()
    config.providers[selectedProvider.value].apiKey = draft.apiKey
    config.providers[selectedProvider.value].extraHeaders = parseOptionalJson(draft.extraHeaders, 'Extra Headers')
    config.providers[selectedProvider.value].extraBody = parseOptionalJson(draft.extraBody, 'Extra Body')

    emit('save', config)
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="panel-content">
    <div class="panel-toolbar model-toolbar">
      <span class="status-pill"><span class="dot" />{{ current?.provider || 'provider' }} / {{ current?.model || 'model' }}</span>
      <button class="tool-button ink asset-button primary-action" @click="save">
        <img class="action-icon" :src="actionAssets.save" alt="" width="18" height="18" />
        <span>保存模型</span>
      </button>
    </div>

    <div v-if="!props.payload" class="empty-state illustrated-empty seal-empty">
      <img :src="brandAssets.logoMark" alt="" />
      <span>暂无模型配置。</span>
    </div>
    <div v-else class="model-form">
      <label>
        <span>Provider</span>
        <select v-model="selectedProvider">
          <option v-for="option in options" :key="option.name" :value="option.name">{{ optionLabel(option) }}</option>
        </select>
      </label>
      <label>
        <span>Model</span>
        <input v-model="draft.model" placeholder="deepseek-v4-flash" />
      </label>
      <label>
        <span>API Base</span>
        <input v-model="draft.apiBase" placeholder="https://api.deepseek.com" />
      </label>
      <label>
        <span>API Key</span>
        <input v-model="draft.apiKey" placeholder="明文保存在本地 model_config.json" />
      </label>
      <label>
        <span>Temperature</span>
        <input v-model.number="draft.temperature" type="number" min="0" max="2" step="0.05" />
      </label>
      <label>
        <span>Max Tokens</span>
        <input v-model.number="draft.maxTokens" type="number" min="1" step="100" />
      </label>
      <label>
        <span>Reasoning Effort</span>
        <select v-model="draft.reasoningEffort">
          <option value="">null</option>
          <option value="none">none</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
      </label>
      <label>
        <span>Context Window</span>
        <input v-model.number="draft.contextWindowTokens" type="number" min="1000" step="1000" />
      </label>
      <label class="span-2">
        <span>Extra Headers JSON</span>
        <textarea v-model="draft.extraHeaders" rows="3" placeholder='{"x-provider": "value"}' />
      </label>
      <label class="span-2">
        <span>Extra Body JSON</span>
        <textarea v-model="draft.extraBody" rows="3" placeholder='{"enable_thinking": false}' />
      </label>
      <div class="span-2 empty-note">
        <img class="note-mark" :src="brandAssets.logoMark" alt="" width="28" height="28" />
        默认推荐 <strong>deepseek / deepseek-v4-flash</strong>。主 Agent、子代理和记忆压缩共用这里的模型配置。
      </div>
    </div>
  </div>
</template>
