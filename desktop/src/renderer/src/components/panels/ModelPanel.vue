<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  Eye,
  EyeOff,
  LoaderCircle,
  RotateCw,
  Search,
  X,
} from 'lucide-vue-next'
import {
  activateModelEntry,
  deleteModelEntry,
  discoverProviderModels,
  saveModelEntry,
  testModelEntry,
} from '../../api/model'
import type {
  DiscoveredModel,
  ModelConfigPayload,
  ModelEntry,
  ModelTestResult,
  ProviderOption,
} from '../../types'
import BrandMark from '../brand/BrandMark.vue'
import ModelEntryList from './model/ModelEntryList.vue'
import {
  applyProviderSelection,
  createModelEntryDraft,
  reasoningChoices,
  toModelEntrySaveInput,
  type CapabilityControl,
  type ModelEntryDraft,
} from './model/modelFormModel'

const props = defineProps<{ payload: ModelConfigPayload | null }>()
const emit = defineEmits<{
  updated: [payload: ModelConfigPayload]
  error: [message: string]
}>()

const entries = computed(() => props.payload?.models ?? [])
const providerOptions = computed(() => props.payload?.providerOptions ?? [])
const activeModelId = computed(() => props.payload?.activeModelId ?? null)

const dialogOpen = ref(false)
const editing = ref<ModelEntryDraft | null>(null)
const providerSearch = ref('')
const providerResultsOpen = ref(false)
const showApiKey = ref(false)
const saving = ref(false)
const activatingId = ref<string | null>(null)
const deletingId = ref<string | null>(null)
const discovering = ref(false)
const discoveredModels = ref<DiscoveredModel[]>([])
const discoveryMessage = ref('')
const testing = ref<'text' | 'vision' | null>(null)
const testResult = ref<ModelTestResult | null>(null)
const firstField = ref<HTMLInputElement | null>(null)
const dialog = ref<HTMLElement | null>(null)

const fallbackProvider: ProviderOption = {
  name: 'custom',
  displayName: 'Custom',
  protocols: ['openai', 'anthropic'],
  defaultProtocol: 'openai',
  apiBases: {},
  iconId: null,
}

const selectedProvider = computed<ProviderOption>(() => {
  if (!editing.value) return fallbackProvider
  return (
    providerOptions.value.find(
      (provider) => provider.name === editing.value?.provider,
    ) ?? fallbackProvider
  )
})

const providerProtocols = computed<readonly ('openai' | 'anthropic')[]>(() => {
  const protocols = selectedProvider.value.protocols
  return protocols?.length
    ? protocols
    : [selectedProvider.value.defaultProtocol ?? 'openai']
})

const filteredProviders = computed(() => {
  const needle = providerSearch.value.trim().toLowerCase()
  if (!needle) return providerOptions.value
  return providerOptions.value.filter((provider) =>
    `${provider.name} ${provider.displayName || ''}`
      .toLowerCase()
      .includes(needle),
  )
})

const supportedReasoning = computed(() => {
  const resolved = reasoningChoices(
    editing.value?.resolvedProfile?.reasoningEfforts,
  )
  const current = String(editing.value?.reasoningEffort || '')
  return current && !resolved.includes(current)
    ? [...resolved, current]
    : resolved
})

const canDiscover = computed(() => {
  if (!editing.value) return false
  const mode = selectedProvider.value.modelDiscovery
  if (!mode) return false
  const protocolMode = mode[editing.value.protocol]
  return Boolean(protocolMode && protocolMode !== 'unsupported')
})

const capabilityRows = [
  { key: 'toolCall', label: '工具调用' },
  { key: 'vision', label: '图片输入' },
  { key: 'reasoning', label: '思考模式' },
] as const

const capabilityOptions: Array<{ value: CapabilityControl; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'on', label: '强制开启' },
  { value: 'off', label: '强制关闭' },
]

const inputTokenPresets = [32_000, 64_000, 128_000, 256_000]
const outputTokenPresets = [8_000, 16_000, 32_000, 64_000]

function providerForEntry(entry?: ModelEntry | null): ProviderOption {
  return (
    providerOptions.value.find(
      (provider) => provider.name === entry?.provider,
    ) ??
    providerOptions.value.find((provider) => provider.name === 'deepseek') ??
    providerOptions.value[0] ??
    fallbackProvider
  )
}

async function focusDialog(): Promise<void> {
  await nextTick()
  firstField.value?.focus()
}

function resetTransientState(): void {
  providerSearch.value = ''
  providerResultsOpen.value = false
  showApiKey.value = false
  discoveredModels.value = []
  discoveryMessage.value = ''
  testResult.value = null
  testing.value = null
}

function openAdd(): void {
  resetTransientState()
  editing.value = createModelEntryDraft(providerForEntry())
  dialogOpen.value = true
  void focusDialog()
}

function openEdit(entry: ModelEntry): void {
  resetTransientState()
  editing.value = createModelEntryDraft(providerForEntry(entry), entry)
  dialogOpen.value = true
  void focusDialog()
}

function closeDialog(): void {
  if (saving.value) return
  dialogOpen.value = false
  editing.value = null
}

function keepFocusInDialog(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ),
  ).filter((element) => element.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function selectProvider(provider: ProviderOption): void {
  if (!editing.value) return
  editing.value = applyProviderSelection(editing.value, provider)
  providerSearch.value = provider.displayName || provider.name
  providerResultsOpen.value = false
  discoveredModels.value = []
  discoveryMessage.value = ''
}

function selectProtocol(protocol: 'openai' | 'anthropic'): void {
  if (!editing.value) return
  editing.value = applyProviderSelection(
    editing.value,
    selectedProvider.value,
    protocol,
  )
}

function capabilityStatus(
  key: (typeof capabilityRows)[number]['key'],
): string {
  const profile = editing.value?.resolvedProfile
  if (!profile) return '保存后识别'
  const enabled = profile[key]
  const source = profile.sources[key]
  const sourceLabel =
    source === 'override' ? '已覆盖' : source === 'inferred' ? '已识别' : '默认'
  return `${enabled ? '支持' : '不支持'} · ${sourceLabel}`
}

function formatTokenPreset(value: number): string {
  return `${value / 1000}K`
}

function validateDraft(draft: ModelEntryDraft): void {
  if (!draft.provider.trim()) throw new Error('请选择 Provider')
  if (!draft.apiBase.trim()) throw new Error('请填写 API 地址')
  if (!draft.modelId.trim()) throw new Error('请填写模型 ID')
  if (draft.contextWindowTokens < 1) throw new Error('输入上限必须大于 0')
  if (draft.maxTokens < 1) throw new Error('输出上限必须大于 0')
}

async function save(): Promise<void> {
  if (!editing.value || saving.value) return
  saving.value = true
  try {
    validateDraft(editing.value)
    const payload = await saveModelEntry(toModelEntrySaveInput(editing.value))
    emit('updated', payload)
    dialogOpen.value = false
    editing.value = null
  } catch (error) {
    emit('error', error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}

async function activate(entryId: string): Promise<void> {
  if (activatingId.value) return
  activatingId.value = entryId
  try {
    emit('updated', await activateModelEntry(entryId))
  } catch (error) {
    emit('error', error instanceof Error ? error.message : String(error))
  } finally {
    activatingId.value = null
  }
}

async function remove(entryId: string): Promise<void> {
  const entry = entries.value.find((candidate) => candidate.entryId === entryId)
  const label = entry?.displayName || entry?.modelId || '此模型'
  const activeHint =
    entryId === activeModelId.value
      ? ' 删除后会自动激活剩余列表中的第一条模型。'
      : ''
  if (!window.confirm(`确定删除「${label}」吗？${activeHint}`)) return
  deletingId.value = entryId
  try {
    emit('updated', await deleteModelEntry(entryId))
  } catch (error) {
    emit('error', error instanceof Error ? error.message : String(error))
  } finally {
    deletingId.value = null
  }
}

async function discoverModels(): Promise<void> {
  if (!editing.value || discovering.value) return
  discovering.value = true
  discoveryMessage.value = ''
  try {
    const result = await discoverProviderModels({
      ...(editing.value.entryId ? { entryId: editing.value.entryId } : {}),
      provider: editing.value.provider,
      protocol: editing.value.protocol,
      apiBase: editing.value.apiBase,
      ...(editing.value.apiKey.trim()
        ? { apiKey: editing.value.apiKey.trim() }
        : {}),
    })
    discoveredModels.value = result.models ?? []
    discoveryMessage.value = result.ok
      ? result.models.length
        ? `已获取 ${result.models.length} 个模型`
        : '接口未返回模型，可继续手动填写'
      : result.message || '获取模型失败'
  } catch (error) {
    discoveredModels.value = []
    discoveryMessage.value =
      error instanceof Error ? error.message : String(error)
  } finally {
    discovering.value = false
  }
}

async function runTest(kind: 'text' | 'vision'): Promise<void> {
  const entryId = editing.value?.entryId
  if (!entryId || testing.value) return
  testing.value = kind
  testResult.value = null
  try {
    testResult.value = await testModelEntry(entryId, kind)
  } catch (error) {
    testResult.value = {
      ok: false,
      kind,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    testing.value = null
  }
}
</script>

<template>
  <div class="model-panel-shell">
    <div v-if="!payload" class="model-loading">
      <LoaderCircle :size="18" class="spin" aria-hidden="true" />
      正在读取模型配置…
    </div>

    <template v-else>
      <div class="model-route-note">
        <BrandMark :size="30" />
        <div>
          <strong>单模型运行</strong>
          <span>对话、构建、自动任务与子代理统一使用当前激活模型。</span>
        </div>
      </div>
      <ModelEntryList
        :entries="entries"
        :provider-options="providerOptions"
        :active-model-id="activeModelId"
        :activating-id="activatingId"
        :deleting-id="deletingId"
        @add="openAdd"
        @edit="openEdit"
        @activate="activate"
        @delete="remove"
      />

      <div
        v-if="dialogOpen && editing"
        class="model-dialog-backdrop"
        @mousedown.self="closeDialog"
        @keydown.esc="closeDialog"
      >
        <section
          ref="dialog"
          class="model-editor-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="editing.entryId ? 'edit-model-title' : 'add-model-title'"
          @keydown="keepFocusInDialog"
        >
          <header class="dialog-head">
            <div>
              <h2 :id="editing.entryId ? 'edit-model-title' : 'add-model-title'">
                {{ editing.entryId ? '编辑模型' : '添加模型' }}
              </h2>
              <p>每条配置只对应一个模型，保存后可在列表中切换。</p>
            </div>
            <button
              type="button"
              class="icon-button"
              aria-label="关闭模型编辑弹窗"
              @click="closeDialog"
            >
              <X :size="18" aria-hidden="true" />
            </button>
          </header>

          <div class="dialog-body">
            <section class="form-section">
              <div class="form-section-title">
                <span>Provider 与协议</span>
                <small>仅支持两种标准接口格式</small>
              </div>

              <div class="field span-2 provider-field">
                <label for="provider-search">Provider</label>
                <div class="search-input-wrap">
                  <Search :size="15" aria-hidden="true" />
                  <input
                    id="provider-search"
                    ref="firstField"
                    v-model="providerSearch"
                    type="search"
                    autocomplete="off"
                    :placeholder="selectedProvider.displayName || selectedProvider.name"
                    @click="providerResultsOpen = true"
                    @input="providerResultsOpen = true"
                  />
                </div>
                <div v-if="providerResultsOpen" class="provider-results">
                  <button
                    v-for="provider in filteredProviders"
                    :key="provider.name"
                    type="button"
                    :class="{ selected: provider.name === editing.provider }"
                    @click="selectProvider(provider)"
                  >
                    <span>{{ provider.displayName || provider.name }}</span>
                    <code>{{ provider.name }}</code>
                  </button>
                  <span v-if="!filteredProviders.length" class="no-results">
                    没有匹配的 Provider
                  </span>
                </div>
              </div>

              <div class="field span-2">
                <span class="field-label">协议</span>
                <div
                  class="protocol-tabs"
                  :class="{ single: providerProtocols.length === 1 }"
                  role="radiogroup"
                  aria-label="模型协议"
                >
                  <button
                    v-for="protocol in providerProtocols"
                    :key="protocol"
                    type="button"
                    role="radio"
                    :aria-checked="editing.protocol === protocol"
                    :class="{ active: editing.protocol === protocol }"
                    @click="selectProtocol(protocol)"
                  >
                    {{
                      protocol === 'anthropic'
                        ? 'Anthropic Messages'
                        : 'OpenAI Chat Completions'
                    }}
                  </button>
                </div>
              </div>

              <label class="field span-2">
                <span>API 地址</span>
                <input
                  v-model="editing.apiBase"
                  type="url"
                  spellcheck="false"
                  placeholder="https://api.example.com/v1"
                />
                <small>
                  可填写 base URL，也可填写完整的
                  {{
                    editing.protocol === 'anthropic'
                      ? '/v1/messages'
                      : '/chat/completions'
                  }}
                  地址。
                </small>
              </label>

              <div class="field span-2">
                <label for="model-api-key">API Key</label>
                <div class="secret-input-wrap">
                  <input
                    id="model-api-key"
                    v-model="editing.apiKey"
                    :type="showApiKey ? 'text' : 'password'"
                    autocomplete="off"
                    :disabled="editing.clearApiKey"
                    :placeholder="editing.entryId ? '留空保留现有凭证' : '输入 API Key'"
                  />
                  <button
                    type="button"
                    :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
                    @click="showApiKey = !showApiKey"
                  >
                    <EyeOff v-if="showApiKey" :size="16" aria-hidden="true" />
                    <Eye v-else :size="16" aria-hidden="true" />
                  </button>
                </div>
                <label v-if="editing.entryId" class="clear-key-control">
                  <input v-model="editing.clearApiKey" type="checkbox" />
                  清除已保存的 API Key
                </label>
              </div>
            </section>

            <section class="form-section">
              <div class="form-section-title">
                <span>模型</span>
                <small>获取列表或直接输入模型 ID</small>
              </div>
              <div class="field span-2">
                <label for="model-id">模型 ID</label>
                <div class="model-id-row">
                  <input
                    id="model-id"
                    v-model="editing.modelId"
                    list="discovered-models"
                    spellcheck="false"
                    placeholder="例如 gpt-5、claude-sonnet-4-5"
                  />
                  <button
                    type="button"
                    class="secondary-button"
                    :disabled="!canDiscover || discovering"
                    @click="discoverModels"
                  >
                    <RotateCw
                      :size="15"
                      :class="{ spin: discovering }"
                      aria-hidden="true"
                    />
                    {{ discovering ? '获取中…' : '获取模型' }}
                  </button>
                </div>
                <datalist id="discovered-models">
                  <option
                    v-for="model in discoveredModels"
                    :key="model.id"
                    :value="model.id"
                  />
                </datalist>
                <small v-if="discoveryMessage">{{ discoveryMessage }}</small>
              </div>
              <label class="field span-2">
                <span>显示名称（可选）</span>
                <input
                  v-model="editing.displayName"
                  placeholder="例如 工作账号 GPT-5"
                />
              </label>
            </section>

            <section class="form-section">
              <div class="form-section-title">
                <span>能力</span>
                <small>默认自动识别，也可以显式覆盖</small>
              </div>
              <div class="capability-grid span-2">
                <label v-for="row in capabilityRows" :key="row.key">
                  <span>{{ row.label }}</span>
                  <select v-model="editing.capabilityControls[row.key]">
                    <option
                      v-for="option in capabilityOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                  <small>{{ capabilityStatus(row.key) }}</small>
                </label>
              </div>
            </section>

            <section class="form-section">
              <div class="form-section-title">
                <span>容量与思考强度</span>
                <small>用于上下文压缩与生成上限</small>
              </div>
              <div class="field">
                <label for="context-window">输入上限</label>
                <input
                  id="context-window"
                  v-model.number="editing.contextWindowTokens"
                  type="number"
                  min="1"
                  step="1000"
                />
                <div class="token-presets">
                  <button
                    v-for="preset in inputTokenPresets"
                    :key="preset"
                    type="button"
                    :class="{ active: editing.contextWindowTokens === preset }"
                    @click="editing.contextWindowTokens = preset"
                  >
                    {{ formatTokenPreset(preset) }}
                  </button>
                </div>
              </div>
              <div class="field">
                <label for="output-limit">输出上限</label>
                <input
                  id="output-limit"
                  v-model.number="editing.maxTokens"
                  type="number"
                  min="1"
                  step="1000"
                />
                <div class="token-presets">
                  <button
                    v-for="preset in outputTokenPresets"
                    :key="preset"
                    type="button"
                    :class="{ active: editing.maxTokens === preset }"
                    @click="editing.maxTokens = preset"
                  >
                    {{ formatTokenPreset(preset) }}
                  </button>
                </div>
              </div>
              <label class="field span-2">
                <span>思考强度</span>
                <select
                  v-model="editing.reasoningEffort"
                  :disabled="supportedReasoning.length === 0"
                >
                  <option :value="null">
                    {{
                      supportedReasoning.length
                        ? '不额外指定'
                        : '当前模型不支持或尚未识别'
                    }}
                  </option>
                  <option
                    v-for="effort in supportedReasoning"
                    :key="effort"
                    :value="effort"
                  >
                    {{ effort }}
                  </option>
                </select>
              </label>
            </section>

            <section v-if="editing.entryId" class="form-section connection-test">
              <div class="form-section-title">
                <span>连通测试</span>
                <small>使用已保存配置发送最小请求</small>
              </div>
              <div class="test-actions span-2">
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="Boolean(testing)"
                  @click="runTest('text')"
                >
                  {{ testing === 'text' ? '测试中…' : '测试文本' }}
                </button>
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="Boolean(testing)"
                  @click="runTest('vision')"
                >
                  {{ testing === 'vision' ? '测试中…' : '测试图片' }}
                </button>
                <span
                  v-if="testResult"
                  class="test-result"
                  :class="{ ok: testResult.ok, fail: !testResult.ok }"
                >
                  {{
                    testResult.ok
                      ? `通过 · ${testResult.latencyMs || 0}ms`
                      : testResult.error || '测试失败'
                  }}
                </span>
              </div>
            </section>
          </div>

          <footer class="dialog-actions">
            <button type="button" class="secondary-button" @click="closeDialog">
              取消
            </button>
            <button
              type="button"
              class="primary-button"
              :disabled="saving"
              @click="save"
            >
              {{ saving ? '保存中…' : '保存模型' }}
            </button>
          </footer>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.model-panel-shell {
  position: relative;
  display: grid;
  gap: 20px;
  min-height: 260px;
}

.model-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  gap: 8px;
  color: rgb(var(--fg-muted));
  font-size: 12px;
}

.model-route-note {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 13px;
  border: 1px solid rgb(var(--border));
  border-radius: 9px;
  background: rgb(var(--bg-elevated) / 0.44);
}

.model-route-note > div {
  display: grid;
  gap: 2px;
}

.model-route-note strong {
  color: rgb(var(--fg));
  font-size: 11px;
}

.model-route-note span {
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.model-dialog-backdrop {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.64);
  backdrop-filter: blur(2px);
}

.model-editor-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(720px, 100%);
  max-height: min(860px, calc(100vh - 48px));
  overflow: hidden;
  border: 1px solid rgb(var(--border-strong));
  border-radius: 12px;
  background: rgb(var(--bg));
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.42);
}

.dialog-head,
.dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
}

.dialog-head {
  border-bottom: 1px solid rgb(var(--border));
}

.dialog-head h2 {
  margin: 0;
  color: rgb(var(--fg));
  font-size: 16px;
  font-weight: 680;
}

.dialog-head p {
  margin: 4px 0 0;
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.icon-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: rgb(var(--fg-muted));
  cursor: pointer;
}

.icon-button:hover {
  background: rgb(var(--bg-elevated));
  color: rgb(var(--fg));
}

.dialog-body {
  display: grid;
  gap: 12px;
  overflow: auto;
  padding: 16px 18px 24px;
}

.form-section {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px;
  padding: 15px;
  border: 1px solid rgb(var(--border));
  border-radius: 10px;
  background: rgb(var(--bg-elevated) / 0.46);
}

.form-section-title {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 2px;
}

.form-section-title span {
  color: rgb(var(--fg));
  font-size: 12px;
  font-weight: 650;
}

.form-section-title small,
.field small {
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.field {
  position: relative;
  display: grid;
  align-content: start;
  gap: 6px;
}

.span-2 {
  grid-column: 1 / -1;
}

.field > label,
.field > span:first-child,
.field-label {
  color: rgb(var(--fg-muted));
  font-size: 11px;
  font-weight: 550;
}

.field input,
.field select,
.capability-grid select,
.search-input-wrap {
  width: 100%;
  min-height: 35px;
  border: 1px solid rgb(var(--border));
  border-radius: 7px;
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
  font: inherit;
  font-size: 12px;
}

.field input,
.field select,
.capability-grid select {
  padding: 0 10px;
}

.field input:focus,
.field select:focus,
.capability-grid select:focus,
.search-input-wrap:focus-within {
  border-color: rgb(var(--accent) / 0.75);
  outline: 0;
  box-shadow: 0 0 0 3px rgb(var(--accent) / 0.14);
}

.search-input-wrap,
.secret-input-wrap,
.model-id-row {
  display: flex;
  align-items: center;
}

.search-input-wrap {
  padding-left: 10px;
  color: rgb(var(--fg-subtle));
}

.search-input-wrap input {
  min-width: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.provider-results {
  position: absolute;
  z-index: 4;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  display: grid;
  max-height: 210px;
  overflow: auto;
  padding: 5px;
  border: 1px solid rgb(var(--border-strong));
  border-radius: 8px;
  background: rgb(var(--bg));
  box-shadow: 0 14px 36px rgb(0 0 0 / 0.28);
}

.provider-results button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 32px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--fg));
  font-size: 11px;
  cursor: pointer;
}

.provider-results button:hover,
.provider-results button.selected {
  background: rgb(var(--accent) / 0.11);
}

.provider-results code,
.no-results {
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.no-results {
  padding: 10px;
  text-align: center;
}

.protocol-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.protocol-tabs.single {
  grid-template-columns: 1fr;
}

.protocol-tabs button,
.token-presets button {
  border: 1px solid rgb(var(--border));
  border-radius: 7px;
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg-muted));
  cursor: pointer;
}

.protocol-tabs button {
  min-height: 35px;
  font-size: 11px;
}

.protocol-tabs button.active,
.token-presets button.active {
  border-color: rgb(var(--accent) / 0.65);
  background: rgb(var(--accent) / 0.12);
  color: rgb(var(--accent));
}

.secret-input-wrap {
  position: relative;
}

.secret-input-wrap input {
  padding-right: 40px;
}

.secret-input-wrap button {
  position: absolute;
  right: 3px;
  display: grid;
  place-items: center;
  width: 31px;
  height: 29px;
  border: 0;
  background: transparent;
  color: rgb(var(--fg-subtle));
  cursor: pointer;
}

.clear-key-control {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.clear-key-control input {
  width: 13px;
  min-height: auto;
  height: 13px;
  margin: 0;
}

.model-id-row {
  gap: 8px;
}

.model-id-row input {
  min-width: 0;
}

.secondary-button,
.primary-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  gap: 7px;
  padding: 0 12px;
  border-radius: 7px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.secondary-button {
  border: 1px solid rgb(var(--border));
  background: rgb(var(--bg-elevated));
  color: rgb(var(--fg));
}

.primary-button {
  border: 1px solid rgb(var(--accent));
  background: rgb(var(--accent));
  color: rgb(var(--accent-fg));
}

.secondary-button:disabled,
.primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}

.capability-grid label {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid rgb(var(--border));
  border-radius: 8px;
  background: rgb(var(--bg-inset));
}

.capability-grid label > span {
  color: rgb(var(--fg));
  font-size: 11px;
  font-weight: 600;
}

.capability-grid small {
  color: rgb(var(--fg-subtle));
  font-size: 9px;
}

.token-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
}

.token-presets button {
  min-height: 25px;
  font-size: 9px;
}

.test-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.test-result {
  overflow: hidden;
  max-width: 360px;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.test-result.ok {
  color: rgb(var(--ok));
}

.test-result.fail {
  color: rgb(var(--danger));
}

.dialog-actions {
  justify-content: flex-end;
  border-top: 1px solid rgb(var(--border));
  background: rgb(var(--bg-elevated) / 0.55);
}

.spin {
  animation: model-spin 800ms linear infinite;
}

@keyframes model-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .model-dialog-backdrop {
    padding: 0;
  }

  .model-editor-dialog {
    width: 100%;
    max-height: 100vh;
    border-radius: 0;
  }

  .form-section {
    grid-template-columns: 1fr;
  }

  .span-2 {
    grid-column: 1;
  }

  .capability-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
