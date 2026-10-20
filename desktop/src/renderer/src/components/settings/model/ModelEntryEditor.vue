<script setup lang="ts">
/**
 * ModelEntryEditor — edits one saved model in place under its row (MOD-05;
 * new models come from AddModelDialog). Only what is usually changed shows:
 * 显示名, 上下文, 每次输出, 思考强度 and the three capabilities; each number
 * says where it came from (手动 / 官方接口 / 内置目录 / 推断). The connection
 * is read-only here — its 「编辑地址」 opens the card's dialog, and the key
 * is changed for the whole connection from the card's 「⋯」. 温度 and 单价
 * wait behind 「高级」, with 接口 for a DeepSeek entry on the official host
 * (Messages by default, chat-completions as the fallback; KRN-07).
 *
 * Saving sends only the model's own fields (`model.saveEntry`), the
 * temperature as `sampling`, and the fields the user changed as
 * `lockFields`, so a later metadata refresh keeps them.
 *
 * Props: entry (the saved model), providerOptions.
 * Emits: saved(payload, label), cancel, editAddress.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { resolveModelProfilePreview, saveModelEntry } from '../../../api/model'
import { providerDisplayName } from '../../../model/providerGroups'
import type {
  ModelConfigPayload,
  ModelEntry,
  ModelEntrySaveInput,
  ModelMetadataField,
  ModelPricing,
  ProviderOption,
  ResolvedModelProfile,
} from '../../../types'
import Button from '../../ui/Button.vue'
import { useDirtyGuard } from '../../ui/useDirtyGuard'
import {
  Field,
  Segmented,
  Select,
  TextField,
  settingsId,
  type SegmentedOption,
  type SelectOption,
} from '../ui'
import {
  CAPABILITY_OPTIONS,
  CAPABILITY_ROWS,
  INPUT_TOKEN_PRESETS,
  INTERFACE_OPTIONS,
  OUTPUT_TOKEN_PRESETS,
  capabilityControlValue,
  capabilityStatus,
  deepseekInterface,
  entryInterfaceLabel,
  formatTokenCount,
  formatTokenPreset,
  modelEntryLabel,
  reasoningChoices,
  reasoningHint,
  type CapabilityControl,
} from './modelFormModel'
import { hostOf, keyTail, valueSource } from './modelListModel'

const props = defineProps<{
  entry: ModelEntry
  providerOptions: readonly ProviderOption[]
}>()
const emit = defineEmits<{
  saved: [payload: ModelConfigPayload, label: string]
  cancel: []
  editAddress: []
}>()

type CapabilityKey = (typeof CAPABILITY_ROWS)[number]['key']

interface Draft {
  displayName: string
  contextWindowTokens: number
  maxTokens: number
  reasoningEffort: string
  capabilities: Record<CapabilityKey, CapabilityControl>
  temperature: string
  /** USD per million tokens as typed; empty means unknown. */
  pricing: Record<keyof ModelPricing, string>
  /** '' = the provider's default interface (KRN-07). */
  transport: '' | 'chat-completions'
}

function priceText(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

function draftOf(entry: ModelEntry): Draft {
  const overrides = entry.capabilityOverrides ?? {}
  return {
    displayName: entry.displayName ?? '',
    contextWindowTokens: Number(entry.contextWindowTokens || 128_000),
    maxTokens: Number(entry.maxTokens || 8_000),
    reasoningEffort: entry.reasoningEffort ?? '',
    capabilities: {
      toolCall: capabilityControlValue(overrides.toolCall),
      vision: capabilityControlValue(overrides.vision),
      reasoning: capabilityControlValue(overrides.reasoning),
    },
    temperature:
      entry.sampling?.temperature === undefined
        ? ''
        : String(entry.sampling.temperature),
    pricing: {
      inputUsdPerMillionTokens: priceText(
        entry.pricing?.inputUsdPerMillionTokens,
      ),
      outputUsdPerMillionTokens: priceText(
        entry.pricing?.outputUsdPerMillionTokens,
      ),
      cacheReadUsdPerMillionTokens: priceText(
        entry.pricing?.cacheReadUsdPerMillionTokens,
      ),
      cacheWriteUsdPerMillionTokens: priceText(
        entry.pricing?.cacheWriteUsdPerMillionTokens,
      ),
    },
    transport: entry.transport ?? '',
  }
}

const uid = settingsId('model-editor')
const opened = draftOf(props.entry)
const draft = ref<Draft>(draftOf(props.entry))
const profile = ref<ResolvedModelProfile | undefined>(
  props.entry.resolvedProfile,
)
const advanced = ref(false)
const saving = ref(false)
const error = ref('')
const root = ref<HTMLElement | null>(null)

const label = computed(() => modelEntryLabel(props.entry))
useDirtyGuard(
  label,
  () =>
    !saving.value &&
    (changedFields().length > 0 || draft.value.transport !== opened.transport),
)

const provider = computed(() =>
  props.providerOptions.find((item) => item.name === props.entry.provider),
)
/** A DeepSeek entry on the official host can pick its interface. */
const interfaceChoice = computed(() => deepseekInterface(props.entry) !== null)
const effortHint = computed(() => reasoningHint(props.entry))
const connection = computed(() =>
  [
    providerDisplayName(props.entry.provider, provider.value),
    entryInterfaceLabel(props.entry),
    hostOf(props.entry.apiBase),
    keyTail([props.entry]),
  ]
    .filter(Boolean)
    .join(' · '),
)

const acceptsTemperature = computed(
  () => props.entry.detected?.acceptsTemperature !== false,
)

const contextLimit = computed(() => props.entry.limits?.maxInputTokens)
const outputLimit = computed(() => props.entry.limits?.maxOutputTokens)

function presetOptions(values: readonly number[], limit?: number) {
  return values
    .filter((value) => !limit || value <= limit)
    .map((value) => ({ value, label: formatTokenPreset(value) }))
}
const contextPresets = computed<SegmentedOption<number>[]>(() =>
  presetOptions(INPUT_TOKEN_PRESETS, contextLimit.value),
)
const outputPresets = computed<SegmentedOption<number>[]>(() =>
  presetOptions(OUTPUT_TOKEN_PRESETS, outputLimit.value),
)

function numberModel(key: 'contextWindowTokens' | 'maxTokens') {
  return computed({
    get: () =>
      Number.isFinite(draft.value[key]) ? String(draft.value[key]) : '',
    set: (text: string | number) => {
      draft.value[key] = String(text).trim() === '' ? Number.NaN : Number(text)
    },
  })
}
const contextText = numberModel('contextWindowTokens')
const outputText = numberModel('maxTokens')

const reasoningOptions = computed<SelectOption[]>(() => {
  const choices = reasoningChoices(profile.value?.reasoningEfforts)
  const current = draft.value.reasoningEffort
  const all =
    current && !choices.includes(current) ? [...choices, current] : choices
  return [
    {
      value: '',
      label: all.length ? '跟随默认' : '当前模型不支持或尚未识别',
    },
    ...all.map((effort) => ({ value: effort, label: effort })),
  ]
})

type PricingKey = keyof ModelPricing
const PRICING_FIELDS: { key: PricingKey; label: string }[] = [
  { key: 'inputUsdPerMillionTokens', label: '普通输入' },
  { key: 'outputUsdPerMillionTokens', label: '模型输出' },
  { key: 'cacheReadUsdPerMillionTokens', label: '缓存读取' },
  { key: 'cacheWriteUsdPerMillionTokens', label: '缓存写入' },
]

function sourceOf(
  field: 'contextWindowTokens' | 'maxTokens' | 'reasoningEffort',
): string {
  return changedFields().includes(field)
    ? '手动'
    : valueSource(props.entry, field)
}

/** The fields this edit changed, in metadata-field order. */
function changedFields(): ModelMetadataField[] {
  const now = draft.value
  const fields: ModelMetadataField[] = []
  if (now.contextWindowTokens !== opened.contextWindowTokens)
    fields.push('contextWindowTokens')
  if (now.maxTokens !== opened.maxTokens) fields.push('maxTokens')
  if (JSON.stringify(now.pricing) !== JSON.stringify(opened.pricing))
    fields.push('pricing')
  if (JSON.stringify(now.capabilities) !== JSON.stringify(opened.capabilities))
    fields.push('capabilities')
  if (now.reasoningEffort !== opened.reasoningEffort)
    fields.push('reasoningEffort')
  if (now.displayName.trim() !== opened.displayName.trim())
    fields.push('displayName')
  return fields
}

function temperatureValue(): number | null | 'invalid' {
  const text = draft.value.temperature.trim()
  if (!text) return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : 'invalid'
}

/** Input and output prices make a price (cache prices default to 0). */
function pricingValue(): ModelPricing | null | 'invalid' | 'partial' {
  const text = draft.value.pricing
  const values = Object.fromEntries(
    Object.entries(text).map(([key, value]) => [
      key,
      String(value).trim() === '' ? null : Number(value),
    ]),
  ) as Record<keyof ModelPricing, number | null>
  if (
    Object.values(values).some(
      (value) => value !== null && (!Number.isFinite(value) || value < 0),
    )
  )
    return 'invalid'
  if (Object.values(values).every((value) => value === null)) return null
  if (
    values.inputUsdPerMillionTokens === null ||
    values.outputUsdPerMillionTokens === null
  )
    return 'partial'
  return {
    inputUsdPerMillionTokens: values.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: values.outputUsdPerMillionTokens,
    cacheReadUsdPerMillionTokens: values.cacheReadUsdPerMillionTokens ?? 0,
    cacheWriteUsdPerMillionTokens: values.cacheWriteUsdPerMillionTokens ?? 0,
  }
}

function validate(): string {
  const { contextWindowTokens, maxTokens } = draft.value
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 1)
    return '上下文需要是正整数'
  if (!Number.isInteger(maxTokens) || maxTokens < 1)
    return '每次输出需要是正整数'
  if (maxTokens > contextWindowTokens) return '每次输出不能超过上下文'
  if (temperatureValue() === 'invalid') return '温度需要在 0 到 2 之间'
  const price = pricingValue()
  if (price === 'invalid') return '单价需要是非负数'
  if (price === 'partial') return '单价至少要填普通输入和模型输出'
  return ''
}

function saveInput(): ModelEntrySaveInput {
  const now = draft.value
  const overrides: ModelEntrySaveInput['capabilityOverrides'] = {}
  for (const row of CAPABILITY_ROWS) {
    const control = now.capabilities[row.key]
    if (control !== 'auto') overrides[row.key] = control === 'on'
  }
  const temperature = temperatureValue()
  const openedTemperature = opened.temperature.trim()
  const input: ModelEntrySaveInput = {
    entryId: props.entry.entryId,
    displayName: now.displayName.trim(),
    capabilityOverrides: overrides,
    contextWindowTokens: now.contextWindowTokens,
    maxTokens: now.maxTokens,
    reasoningEffort: now.reasoningEffort || null,
    pricing: (() => {
      const price = pricingValue()
      return price && typeof price === 'object' ? price : null
    })(),
  }
  if (now.temperature.trim() !== openedTemperature && temperature !== 'invalid')
    input.sampling = { temperature }
  if (now.transport !== opened.transport)
    input.transport = now.transport || null
  const locked = changedFields()
  if (locked.length) input.lockFields = locked
  return input
}

async function refreshProfile(): Promise<void> {
  const overrides = saveInput().capabilityOverrides
  try {
    profile.value = await resolveModelProfilePreview({
      provider: props.entry.provider,
      protocol: props.entry.protocol,
      modelId: props.entry.modelId,
      capabilityOverrides: overrides,
      contextWindowTokens: draft.value.contextWindowTokens,
      maxTokens: draft.value.maxTokens,
    })
  } catch {
    // Keep the saved profile; the options stay as they were.
  }
}

watch(
  () => JSON.stringify(draft.value.capabilities),
  () => void refreshProfile(),
)

async function save(): Promise<void> {
  if (saving.value) return
  error.value = validate()
  if (error.value) return
  saving.value = true
  try {
    const payload = await saveModelEntry(saveInput())
    emit('saved', payload, draft.value.displayName.trim() || label.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  root.value
    ?.querySelector<HTMLElement>('input:not(:disabled)')
    ?.focus({ preventScroll: true })
})
</script>

<template>
  <div ref="root" class="model-editor" data-testid="model-editor">
    <div class="connection" data-testid="model-editor-connection">
      <span class="connection-text">{{ connection }}</span>
      <Button size="sm" variant="ghost" @click="emit('editAddress')"
        >编辑地址</Button
      >
    </div>

    <Field label="显示名" hint="留空时用厂商给的名称">
      <TextField
        v-model="draft.displayName"
        :placeholder="entry.metadata?.name || entry.modelId"
      />
    </Field>

    <div class="limits">
      <Field label="上下文">
        <TextField
          v-model="contextText"
          type="number"
          min="1"
          step="1000"
          inputmode="numeric"
        />
        <template #hint>
          <span data-source="contextWindowTokens"
            >来源：{{ sourceOf('contextWindowTokens') }}</span
          >
          <span v-if="contextLimit">
            · 上限 {{ formatTokenCount(contextLimit) }}</span
          >
        </template>
        <Segmented
          :model-value="draft.contextWindowTokens"
          :options="contextPresets"
          aria-label="上下文预设"
          @update:model-value="
            (value) => (draft.contextWindowTokens = Number(value))
          "
        />
      </Field>
      <Field label="每次输出">
        <TextField
          v-model="outputText"
          type="number"
          min="1"
          step="1000"
          inputmode="numeric"
        />
        <template #hint>
          <span data-source="maxTokens">来源：{{ sourceOf('maxTokens') }}</span>
          <span v-if="outputLimit">
            · 上限 {{ formatTokenCount(outputLimit) }}</span
          >
        </template>
        <Segmented
          :model-value="draft.maxTokens"
          :options="outputPresets"
          aria-label="每次输出预设"
          @update:model-value="(value) => (draft.maxTokens = Number(value))"
        />
      </Field>
    </div>

    <Field label="思考强度" :hint="effortHint">
      <Select
        v-model="draft.reasoningEffort"
        :options="reasoningOptions"
        :disabled="reasoningOptions.length === 1"
        block
      />
    </Field>

    <div class="grid-3">
      <Field
        v-for="row in CAPABILITY_ROWS"
        :key="row.key"
        :label="row.label"
        :hint="capabilityStatus(profile, row.key)"
      >
        <Select
          :model-value="draft.capabilities[row.key]"
          :options="CAPABILITY_OPTIONS"
          size="sm"
          block
          @update:model-value="
            (value) =>
              (draft.capabilities[row.key] = value as CapabilityControl)
          "
        />
      </Field>
    </div>

    <button
      type="button"
      class="advanced-toggle"
      :aria-expanded="advanced"
      :aria-controls="`${uid}-advanced`"
      @click="advanced = !advanced"
    >
      高级
    </button>
    <div v-if="advanced" :id="`${uid}-advanced`" class="advanced">
      <Field
        v-if="interfaceChoice"
        label="接口"
        hint="DeepSeek 官方地址默认走 Anthropic Messages；只有它出问题时才切回 Chat Completions"
      >
        <Select v-model="draft.transport" :options="INTERFACE_OPTIONS" block />
      </Field>
      <Field
        label="温度"
        :hint="
          acceptsTemperature
            ? '0–2；留空时不发送，由厂商决定'
            : '这个模型不接受温度参数，请求里不会带上'
        "
      >
        <TextField
          v-model="draft.temperature"
          type="number"
          min="0"
          max="2"
          step="0.1"
          inputmode="decimal"
          placeholder="不发送"
          :disabled="!acceptsTemperature"
        />
      </Field>
      <span class="pricing-title"
        >单价 <small>USD / 每百万 tokens；留空表示未知</small></span
      >
      <div class="grid-2">
        <Field
          v-for="field in PRICING_FIELDS"
          :key="field.key"
          :label="field.label"
        >
          <TextField
            v-model="draft.pricing[field.key]"
            type="number"
            min="0"
            step="0.01"
            inputmode="decimal"
            size="sm"
          />
        </Field>
      </div>
      <p class="note">
        缺少单价代表未知，不代表免费；成本上限不覆盖没有单价的模型。
      </p>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="actions">
      <Button size="sm" variant="secondary" @click="emit('cancel')"
        >取消</Button
      >
      <Button size="sm" variant="primary" :disabled="saving" @click="save">{{
        saving ? '保存中…' : '保存'
      }}</Button>
    </div>
  </div>
</template>

<style scoped>
.model-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--radius-cell);
  background: rgb(var(--surface-raised));
}

.connection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.connection-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.limits {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

@container (max-width: 520px) {
  .grid-2,
  .grid-3 {
    grid-template-columns: minmax(0, 1fr);
  }
}

.advanced-toggle {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
  cursor: pointer;
}

.advanced-toggle::after {
  content: ' ›';
}

.advanced-toggle[aria-expanded='true']::after {
  content: ' ⌄';
}

.advanced-toggle:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
  border-radius: var(--r-xs);
}

.advanced {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pricing-title {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
}

.pricing-title small {
  font-weight: 400;
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}

.note {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.error {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--state-error-label));
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
