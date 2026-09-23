<script setup lang="ts">
/**
 * ModelEntryEditor — the add / edit form of one model entry, rendered in
 * place inside its row card (Settings › 模型; dsh ModelsSection pattern, no
 * nested dialog). Owns the draft and every call it needs: provider profile
 * preview (reasoning choices), model discovery, the connection test (saved
 * entries only) and the save itself.
 *
 * Props:
 * - entry: the saved entry to edit, or null to add a new one.
 * - provider?: provider of a new entry (default DeepSeek, then the first).
 * - source?: new entries under an existing provider start from this saved
 *   entry's protocol / API base and reuse its key (`credentialsFrom`).
 * - providerOptions: Provider catalog from the model config payload.
 * Emits: saved(payload, label) after `model.saveEntry`; cancel.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff } from 'lucide-vue-next'
import {
  discoverProviderModels,
  resolveModelProfilePreview,
  saveModelEntry,
  testModelEntry,
} from '../../../api/model'
import type {
  DiscoveredModel,
  ModelConfigPayload,
  ModelEntry,
  ModelTestResult,
  ProviderOption,
} from '../../../types'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import ProviderLogo from '../../ui/ProviderLogo.vue'
import { DsRefresh } from '../../icons/ds'
import {
  Field,
  Segmented,
  Select,
  StatusBadge,
  Switch,
  TextField,
  settingsId,
  type SegmentedOption,
  type SelectOption,
} from '../ui'
import {
  applyProviderSelection,
  CAPABILITY_OPTIONS,
  CAPABILITY_ROWS,
  capabilityStatus,
  createModelEntryDraft,
  createSiblingEntryDraft,
  credentialsInherited,
  formatTokenPreset,
  INPUT_TOKEN_PRESETS,
  OUTPUT_TOKEN_PRESETS,
  PROTOCOL_LABELS,
  providerProtocols,
  reasoningChoices,
  toModelEntrySaveInput,
  updateModelDraftDisplayName,
  updateModelDraftId,
  validateModelDraft,
  type CapabilityControl,
  type ModelDraftErrors,
  type ModelEntryDraft,
  type ModelProtocol,
} from './modelFormModel'
import ProviderPicker from './ProviderPicker.vue'
import { providerDisplayName } from '../../../model/providerGroups'

const props = defineProps<{
  entry: ModelEntry | null
  provider?: string | null
  source?: ModelEntry | null
  providerOptions: readonly ProviderOption[]
}>()
const emit = defineEmits<{
  saved: [payload: ModelConfigPayload, label: string]
  cancel: []
}>()

const FALLBACK_PROVIDER: ProviderOption = {
  name: 'custom',
  displayName: 'Custom',
  protocols: ['openai', 'anthropic'],
  defaultProtocol: 'openai',
  apiBases: {},
  iconId: null,
}

const uid = settingsId('model-editor')

function providerFor(name?: string | null): ProviderOption {
  return (
    props.providerOptions.find((provider) => provider.name === name) ??
    props.providerOptions.find((provider) => provider.name === 'deepseek') ??
    props.providerOptions[0] ??
    FALLBACK_PROVIDER
  )
}

function initialDraft(): ModelEntryDraft {
  if (props.entry)
    return createModelEntryDraft(providerFor(props.entry.provider), props.entry)
  if (props.source)
    return createSiblingEntryDraft(
      providerFor(props.source.provider),
      props.source,
    )
  return createModelEntryDraft(providerFor(props.provider))
}

const draft = ref<ModelEntryDraft>(initialDraft())
const choosingProvider = ref(false)
const showApiKey = ref(false)
const saving = ref(false)
const attempted = ref(false)
const errors = ref<ModelDraftErrors>({})
const saveError = ref('')
const discovering = ref(false)
const discovered = ref<DiscoveredModel[]>([])
const discoveryMessage = ref('')
const discoveryFailed = ref(false)
const testing = ref<'text' | 'vision' | null>(null)
const testResult = ref<ModelTestResult | null>(null)
const root = ref<HTMLElement | null>(null)
let previewRevision = 0

const isNew = computed(() => !draft.value.entryId)

const selectedProvider = computed<ProviderOption>(
  () =>
    props.providerOptions.find(
      (provider) => provider.name === draft.value.provider,
    ) ?? FALLBACK_PROVIDER,
)

const selectedProviderLabel = computed(() =>
  providerDisplayName(draft.value.provider, selectedProvider.value),
)

const inheritsKey = computed(() => credentialsInherited(draft.value))

/** A sibling key that no longer applies because the endpoint changed. */
const inheritedKeyLost = computed(() => {
  const source = draft.value.credentialsFrom
  return Boolean(
    source &&
    source.provider === draft.value.provider &&
    !draft.value.apiKey.trim() &&
    !inheritsKey.value,
  )
})

const apiKeyPlaceholder = computed(() => {
  if (inheritsKey.value)
    return `沿用「${draft.value.credentialsFrom!.label}」的 API Key`
  return isNew.value ? '输入 API Key' : '留空保留现有凭证'
})

const apiKeyHint = computed(() => {
  if (inheritsKey.value)
    return '留空即沿用同一供应商已保存的 Key；填写则改用新的 Key'
  if (inheritedKeyLost.value)
    return '协议或 API 地址已改变，需要重新填写 API Key'
  return isNew.value ? undefined : '留空则保留已保存的凭证'
})

function pickProvider(name: string): void {
  providerName.value = name
  choosingProvider.value = false
}

const protocolOptions = computed<SegmentedOption<ModelProtocol>[]>(() =>
  providerProtocols(selectedProvider.value).map((protocol) => ({
    value: protocol,
    label: PROTOCOL_LABELS[protocol],
  })),
)

const providerName = computed({
  get: () => draft.value.provider,
  set: (name: string) => {
    if (name === draft.value.provider) return
    draft.value = applyProviderSelection(draft.value, providerFor(name))
    resetDiscovery()
  },
})

const protocol = computed({
  get: () => draft.value.protocol,
  set: (value: ModelProtocol) => {
    if (value === draft.value.protocol) return
    draft.value = applyProviderSelection(
      draft.value,
      selectedProvider.value,
      value,
    )
  },
})

const apiKey = computed({
  get: () => draft.value.apiKey,
  set: (value: string) => {
    draft.value.apiKey = value
    if (value.trim()) draft.value.clearApiKey = false
  },
})

const modelId = computed({
  get: () => draft.value.modelId,
  set: (value: string) => updateModelDraftId(draft.value, value),
})

const displayName = computed({
  get: () => draft.value.displayName,
  set: (value: string) => updateModelDraftDisplayName(draft.value, value),
})

function parseNumberInput(text: string | number): number {
  return String(text).trim() === '' ? Number.NaN : Number(text)
}

function numberText(key: 'contextWindowTokens' | 'maxTokens') {
  return computed({
    get: () =>
      Number.isFinite(draft.value[key]) ? String(draft.value[key]) : '',
    // Vue casts v-model of a type="number" input, so the value may be a number.
    set: (text: string | number) => {
      draft.value[key] = parseNumberInput(text)
    },
  })
}
const contextWindowText = numberText('contextWindowTokens')
const maxTokensText = numberText('maxTokens')

type PricingKey = keyof ModelEntryDraft['pricing']
const PRICING_FIELDS: { key: PricingKey; label: string }[] = [
  { key: 'inputUsdPerMillionTokens', label: '普通输入' },
  { key: 'outputUsdPerMillionTokens', label: '模型输出' },
  { key: 'cacheReadUsdPerMillionTokens', label: '缓存读取' },
  { key: 'cacheWriteUsdPerMillionTokens', label: '缓存写入' },
]
const pricingText = Object.fromEntries(
  PRICING_FIELDS.map(({ key }) => [
    key,
    computed({
      get: () =>
        Number.isFinite(draft.value.pricing[key])
          ? String(draft.value.pricing[key])
          : '',
      set: (text: string | number) => {
        draft.value.pricing[key] = parseNumberInput(text)
      },
    }),
  ]),
) as Record<PricingKey, ReturnType<typeof numberText>>

const supportedReasoning = computed(() => {
  const resolved = reasoningChoices(
    draft.value.resolvedProfile?.reasoningEfforts,
  )
  const current = String(draft.value.reasoningEffort || '')
  return current && !resolved.includes(current)
    ? [...resolved, current]
    : resolved
})

const reasoningOptions = computed<SelectOption[]>(() => [
  {
    value: '',
    label: supportedReasoning.value.length
      ? '不额外指定'
      : '当前模型不支持或尚未识别',
  },
  ...supportedReasoning.value.map((effort) => ({
    value: effort,
    label: effort,
  })),
])

const reasoningEffort = computed({
  get: () => draft.value.reasoningEffort ?? '',
  set: (value: string) => {
    draft.value.reasoningEffort = value || null
  },
})

const canDiscover = computed(() => {
  const mode = selectedProvider.value.modelDiscovery?.[draft.value.protocol]
  return Boolean(mode && mode !== 'unsupported')
})

const candidates = computed(() => {
  const needle = draft.value.modelId.trim().toLowerCase()
  const all = discovered.value
  if (!needle || all.some((model) => model.id.toLowerCase() === needle))
    return all
  return all.filter((model) => model.id.toLowerCase().includes(needle))
})

const apiBaseHint = computed(
  () =>
    `可填写 base URL，也可填写完整的 ${
      draft.value.protocol === 'anthropic'
        ? '/v1/messages'
        : '/chat/completions'
    } 地址。`,
)

const displayNameHint = computed(() =>
  draft.value.displayNameCustomized
    ? '自定义标识；清空可恢复自动同步'
    : '自动与模型 ID 同步，不会重复写入配置',
)

const testSummary = computed(() => {
  const result = testResult.value
  if (!result) return ''
  return result.ok
    ? `通过 · ${result.latencyMs || 0}ms`
    : result.error || '测试失败'
})

watch(
  () => {
    const current = draft.value
    return JSON.stringify({
      provider: current.provider,
      protocol: current.protocol,
      modelId: current.modelId.trim(),
      capabilityControls: current.capabilityControls,
      contextWindowTokens: current.contextWindowTokens,
      maxTokens: current.maxTokens,
    })
  },
  () => void refreshProfile(),
)

watch(
  draft,
  () => {
    if (attempted.value) errors.value = validateModelDraft(draft.value)
  },
  { deep: true },
)

const inputPresets = INPUT_TOKEN_PRESETS.map((value) => ({
  value,
  label: formatTokenPreset(value),
}))
const outputPresets = OUTPUT_TOKEN_PRESETS.map((value) => ({
  value,
  label: formatTokenPreset(value),
}))

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (
      /(auto|scroll)/.test(overflowY) &&
      node.scrollHeight > node.clientHeight
    )
      return node
  }
  return null
}

/** Bring the card that hosts the editor into view when its head is hidden. */
function revealHost(): void {
  const editor = root.value
  const card =
    editor?.closest<HTMLElement>('[data-editor-host]') ?? editor ?? null
  const scroller = card ? scrollParent(card) : null
  if (!card || !scroller) return
  const top = card.getBoundingClientRect().top
  const box = scroller.getBoundingClientRect()
  if (top < box.top || top > box.bottom - 120)
    card.scrollIntoView?.({ block: 'start' })
}

onMounted(() => {
  revealHost()
  root.value
    ?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')
    ?.focus({ preventScroll: true })
})

async function refreshProfile(): Promise<void> {
  const current = draft.value
  const id = current.modelId.trim()
  const revision = ++previewRevision
  if (!id) {
    current.resolvedProfile = undefined
    current.reasoningEffort = null
    return
  }
  const preview = toModelEntrySaveInput(current)
  try {
    const resolved = await resolveModelProfilePreview({
      provider: current.provider,
      protocol: current.protocol,
      modelId: id,
      capabilityOverrides: preview.capabilityOverrides,
      contextWindowTokens: preview.contextWindowTokens,
      maxTokens: preview.maxTokens,
    })
    if (revision !== previewRevision || draft.value !== current) return
    current.resolvedProfile = resolved
    const choices = reasoningChoices(resolved.reasoningEfforts)
    if (current.reasoningEffort && !choices.includes(current.reasoningEffort))
      current.reasoningEffort = null
  } catch {
    if (revision !== previewRevision || draft.value !== current) return
    current.resolvedProfile = undefined
    current.reasoningEffort = null
  }
}

function resetDiscovery(): void {
  discovered.value = []
  discoveryMessage.value = ''
  discoveryFailed.value = false
}

async function discoverModels(): Promise<void> {
  if (discovering.value) return
  const current = draft.value
  discovering.value = true
  resetDiscovery()
  try {
    const credentialEntryId =
      current.entryId ||
      (credentialsInherited(current) ? current.credentialsFrom!.entryId : '')
    const result = await discoverProviderModels({
      ...(credentialEntryId ? { entryId: credentialEntryId } : {}),
      provider: current.provider,
      protocol: current.protocol,
      apiBase: current.apiBase,
      ...(current.apiKey.trim() ? { apiKey: current.apiKey.trim() } : {}),
    })
    discovered.value = result.models ?? []
    discoveryFailed.value = !result.ok
    discoveryMessage.value = result.ok
      ? discovered.value.length
        ? `已获取 ${discovered.value.length} 个模型`
        : '接口未返回模型，可继续手动填写'
      : result.message || '获取模型失败'
  } catch (error) {
    discoveryFailed.value = true
    discoveryMessage.value =
      error instanceof Error ? error.message : String(error)
  } finally {
    discovering.value = false
  }
}

function pickCandidate(id: string): void {
  updateModelDraftId(draft.value, id)
}

function setCapability(
  key: (typeof CAPABILITY_ROWS)[number]['key'],
  value: CapabilityControl,
): void {
  draft.value.capabilityControls[key] = value
}

async function runTest(kind: 'text' | 'vision'): Promise<void> {
  const entryId = draft.value.entryId
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

async function save(): Promise<void> {
  if (saving.value) return
  attempted.value = true
  errors.value = validateModelDraft(draft.value)
  if (Object.keys(errors.value).length) {
    saveError.value = '请先修正标记的字段'
    return
  }
  saving.value = true
  saveError.value = ''
  try {
    const payload = await saveModelEntry(toModelEntrySaveInput(draft.value))
    emit(
      'saved',
      payload,
      draft.value.displayName.trim() || draft.value.modelId.trim(),
    )
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

function cancel(): void {
  if (!saving.value) emit('cancel')
}
</script>

<template>
  <div ref="root" class="model-editor" data-testid="model-editor">
    <section class="block">
      <h4 class="block-title">连接</h4>
      <Field label="供应商" :error="errors.provider">
        <div class="provider-row" data-testid="model-editor-provider">
          <ProviderLogo
            :icon-id="selectedProvider.iconId || draft.provider"
            :label="selectedProviderLabel"
            size="sm"
          />
          <span class="provider-name">{{ selectedProviderLabel }}</span>
          <Button
            size="sm"
            variant="outline"
            :aria-expanded="choosingProvider"
            aria-label="更换供应商"
            @click="choosingProvider = !choosingProvider"
          >
            {{ choosingProvider ? '收起' : '更换' }}
          </Button>
        </div>
      </Field>
      <ProviderPicker
        v-if="choosingProvider"
        :options="providerOptions"
        :selected="draft.provider"
        @pick="pickProvider"
      />
      <Field label="协议">
        <Segmented
          v-if="protocolOptions.length > 1"
          v-model="protocol"
          :options="protocolOptions"
          aria-label="模型协议"
          block
        />
        <span v-else class="static-value">
          {{ PROTOCOL_LABELS[draft.protocol] }}
        </span>
      </Field>
      <Field label="API 地址" :hint="apiBaseHint" :error="errors.apiBase">
        <TextField
          v-model="draft.apiBase"
          type="url"
          monospace
          spellcheck="false"
          placeholder="https://api.example.com/v1"
        />
      </Field>
      <Field label="API Key" :hint="apiKeyHint">
        <TextField
          v-model="apiKey"
          :type="showApiKey ? 'text' : 'password'"
          autocomplete="off"
          :disabled="draft.clearApiKey"
          :placeholder="apiKeyPlaceholder"
        >
          <template #trailing>
            <IconButton
              :label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
              class="eye"
              @click="showApiKey = !showApiKey"
            >
              <EyeOff v-if="showApiKey" :size="14" aria-hidden="true" />
              <Eye v-else :size="14" aria-hidden="true" />
            </IconButton>
          </template>
        </TextField>
      </Field>
      <div v-if="!isNew" class="inline-toggle">
        <Switch
          :id="`${uid}-clear-key`"
          v-model="draft.clearApiKey"
          aria-label="清除已保存的 API Key"
        />
        <label :for="`${uid}-clear-key`">清除已保存的 API Key</label>
      </div>
    </section>

    <section class="block">
      <h4 class="block-title">模型</h4>
      <Field label="模型 ID" :error="errors.modelId">
        <div class="with-action">
          <TextField
            v-model="modelId"
            monospace
            spellcheck="false"
            autocomplete="off"
            placeholder="例如 gpt-5、claude-sonnet-4-5"
          />
          <Button
            size="sm"
            variant="outline"
            :disabled="!canDiscover || discovering"
            :title="
              canDiscover ? undefined : '当前 Provider 不支持获取模型列表'
            "
            @click="discoverModels"
          >
            <template #icon>
              <DsRefresh :size="14" :class="{ spinning: discovering }" />
            </template>
            {{ discovering ? '获取中…' : '获取模型' }}
          </Button>
        </div>
        <template #hint>
          <span :class="{ 'hint-warn': discoveryFailed }">
            {{ discoveryMessage || '获取列表或直接输入模型 ID' }}
          </span>
        </template>
      </Field>
      <div
        v-if="candidates.length"
        class="candidates"
        role="group"
        aria-label="候选模型"
      >
        <button
          v-for="model in candidates"
          :key="model.id"
          type="button"
          class="candidate"
          :aria-pressed="model.id === draft.modelId"
          @click="pickCandidate(model.id)"
        >
          {{ model.id }}
        </button>
      </div>
      <Field label="标识" :hint="displayNameHint">
        <TextField
          v-model="displayName"
          :placeholder="draft.modelId || '输入模型 ID 后自动同步'"
        />
      </Field>
    </section>

    <section class="block">
      <h4 class="block-title">
        能力
        <span class="block-note">默认自动识别，也可以显式覆盖</span>
      </h4>
      <div class="grid-3">
        <Field
          v-for="row in CAPABILITY_ROWS"
          :key="row.key"
          :label="row.label"
          :hint="capabilityStatus(draft.resolvedProfile, row.key)"
        >
          <Select
            :model-value="draft.capabilityControls[row.key]"
            :options="CAPABILITY_OPTIONS"
            size="sm"
            block
            @update:model-value="
              (value) => setCapability(row.key, value as CapabilityControl)
            "
          />
        </Field>
      </div>
    </section>

    <section class="block">
      <h4 class="block-title">容量与思考强度</h4>
      <div class="grid-2">
        <Field label="输入上限" :error="errors.contextWindowTokens">
          <TextField
            v-model="contextWindowText"
            type="number"
            min="1"
            step="1000"
            inputmode="numeric"
          />
          <Segmented
            :model-value="draft.contextWindowTokens"
            :options="inputPresets"
            aria-label="输入上限预设"
            block
            @update:model-value="
              (value) => (draft.contextWindowTokens = Number(value))
            "
          />
        </Field>
        <Field label="输出上限" :error="errors.maxTokens">
          <TextField
            v-model="maxTokensText"
            type="number"
            min="1"
            step="1000"
            inputmode="numeric"
          />
          <Segmented
            :model-value="draft.maxTokens"
            :options="outputPresets"
            aria-label="输出上限预设"
            block
            @update:model-value="(value) => (draft.maxTokens = Number(value))"
          />
        </Field>
      </div>
      <Field label="思考强度">
        <Select
          v-model="reasoningEffort"
          :options="reasoningOptions"
          :disabled="supportedReasoning.length === 0"
          block
        />
      </Field>
    </section>

    <section class="block">
      <div class="block-head">
        <h4 class="block-title">
          成本单价
          <span class="block-note">USD / 每百万 tokens</span>
        </h4>
        <Switch
          v-model="draft.pricingEnabled"
          aria-label="为此模型配置成本单价"
        />
      </div>
      <template v-if="draft.pricingEnabled">
        <div class="grid-2">
          <Field
            v-for="field in PRICING_FIELDS"
            :key="field.key"
            :label="field.label"
          >
            <TextField
              v-model="pricingText[field.key].value"
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              size="sm"
            />
          </Field>
        </div>
        <p v-if="errors.pricing" class="block-error" role="alert">
          {{ errors.pricing }}
        </p>
      </template>
      <p class="block-hint">
        不内置厂商价格；缺失代表未知，不代表免费。Provider 改价后请手动更新。
      </p>
    </section>

    <section v-if="!isNew" class="block" data-testid="model-connection-test">
      <h4 class="block-title">
        连通测试
        <span class="block-note">使用已保存配置发送最小请求</span>
      </h4>
      <div class="test-row">
        <Button
          size="sm"
          variant="outline"
          :disabled="Boolean(testing)"
          @click="runTest('text')"
        >
          {{ testing === 'text' ? '测试中…' : '测试文本' }}
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="Boolean(testing)"
          @click="runTest('vision')"
        >
          {{ testing === 'vision' ? '测试中…' : '测试图片' }}
        </Button>
        <StatusBadge
          v-if="testResult?.ok"
          tone="ok"
          dot
          role="status"
          data-testid="model-test-result"
        >
          {{ testSummary }}
        </StatusBadge>
      </div>
      <p
        v-if="testResult && !testResult.ok"
        class="block-error"
        role="status"
        data-testid="model-test-result"
      >
        {{ testSummary }}
      </p>
    </section>

    <div class="editor-footer">
      <p v-if="saveError" class="footer-error" role="alert">{{ saveError }}</p>
      <Button size="sm" variant="outline" :disabled="saving" @click="cancel">
        取消
      </Button>
      <Button size="sm" variant="primary" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存模型' }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.model-editor {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.block-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 600;
  color: rgb(var(--label-secondary));
}

.block-note {
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.block-hint,
.block-error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.block-error {
  color: rgb(var(--state-error-label));
}

.static-value {
  display: flex;
  align-items: center;
  min-height: var(--space-7);
  padding: 0 var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--selector-fill));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.eye {
  margin-right: calc(var(--space-1-5) * -1);
}

.inline-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
}

.provider-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: var(--space-8);
}

.provider-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.with-action {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.with-action > :first-child {
  flex: 1;
}

.with-action > :last-child {
  flex: none;
}

.hint-warn {
  color: rgb(var(--state-warn-label));
}

.spinning {
  animation: model-editor-spin 0.9s linear infinite;
}

@keyframes model-editor-spin {
  to {
    transform: rotate(360deg);
  }
}

.candidates {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  max-height: calc(var(--space-7) * 4);
  margin-top: calc(var(--space-1) * -1);
  overflow-y: auto;
}

.candidate {
  max-width: 100%;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-sm);
  background: transparent;
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
  text-align: left;
  cursor: pointer;
}

.candidate:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.candidate[aria-pressed='true'] {
  border-color: rgb(var(--accent-fill));
  color: rgb(var(--label-primary));
}

.candidate:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 1px;
}

.grid-2,
.grid-3 {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}

.grid-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.test-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l2);
}

.footer-error {
  flex: 1 1 200px;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

@container (max-width: 459px) {
  .grid-2,
  .grid-3 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
