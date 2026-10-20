<script setup lang="ts">
/**
 * Step 3 of the add-model dialog (MOD-04): one block per picked model —
 * context, output per request (with the model's limit), capabilities
 * (自动 / 开 / 关, saying what 自动 means and where it came from), thinking
 * (跟随默认 or an effort; no 关闭 for a model that always thinks) and, under
 * 高级, display name, temperature (off for models that refuse one) and
 * prices. Values that came from the fallback are 未知 and must be checked
 * before 添加 N 个模型 saves everything with one `model.saveEntries`.
 */
import { computed, ref } from 'vue'
import type { ModelMetadataField } from '@emperor/core/api'
import Button from '../../ui/Button.vue'
import Checkbox from '../../ui/Checkbox.vue'
import Field from '../../ui/Field.vue'
import LinkButton from '../../ui/LinkButton.vue'
import Notice from '../../ui/Notice.vue'
import Segmented from '../../ui/Segmented.vue'
import Select from '../../ui/Select.vue'
import TextField from '../../ui/TextField.vue'
import { formatTokenCount, reasoningHint } from './modelFormModel'
import {
  markEdited,
  reasoningOptions,
  sourceLabel,
  temperatureState,
  type EntryDraft,
} from './addModelModel'
import { useAddModel } from './addModelController'

const add = useAddModel()
const open = ref<Set<string>>(new Set())
const batchOutput = ref('')

type CapabilityKey = 'toolCall' | 'vision' | 'reasoning'
const CAPABILITIES: Array<{ key: CapabilityKey; label: string }> = [
  { key: 'toolCall', label: '工具' },
  { key: 'vision', label: '识图' },
  { key: 'reasoning', label: '思考' },
]

const activateOptions = computed(() => [
  { value: '', label: '不切换' },
  ...add.drafts.map((draft) => ({
    value: draft.modelId,
    label: draft.displayName || draft.modelId,
  })),
])

function toNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null
}

function setNumber(
  draft: EntryDraft,
  field: 'contextWindowTokens' | 'maxTokens',
  value: string,
): void {
  const parsed = toNumber(value)
  if (parsed === null) return
  draft[field] = parsed
  markEdited(draft, field)
}

function capabilityValue(draft: EntryDraft, key: CapabilityKey): string {
  const value = draft.capabilityOverrides[key]
  return value === undefined ? 'auto' : value ? 'on' : 'off'
}

function autoLabel(draft: EntryDraft, key: CapabilityKey): string {
  const known = draft.model.capabilities[key]
  const state = known === undefined ? '未知' : known ? '开' : '关'
  return `自动（${state}）`
}

function setCapability(draft: EntryDraft, key: CapabilityKey, value: string) {
  if (value === 'auto') delete draft.capabilityOverrides[key]
  else draft.capabilityOverrides[key] = value === 'on'
  markEdited(draft, 'capabilities')
}

function setLocked(draft: EntryDraft, field: ModelMetadataField): void {
  markEdited(draft, field)
}

function setTemperature(draft: EntryDraft, value: string): void {
  const parsed = Number(value)
  draft.temperature =
    value.trim() === '' || !Number.isFinite(parsed)
      ? null
      : Math.min(2, Math.max(0, parsed))
}

function setPrice(
  draft: EntryDraft,
  key: 'inputUsdPerMillionTokens' | 'outputUsdPerMillionTokens',
  value: string,
): void {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return
  draft.pricing = {
    inputUsdPerMillionTokens: draft.pricing?.inputUsdPerMillionTokens ?? 0,
    outputUsdPerMillionTokens: draft.pricing?.outputUsdPerMillionTokens ?? 0,
    cacheReadUsdPerMillionTokens:
      draft.pricing?.cacheReadUsdPerMillionTokens ?? 0,
    cacheWriteUsdPerMillionTokens:
      draft.pricing?.cacheWriteUsdPerMillionTokens ?? 0,
    [key]: parsed,
  }
  markEdited(draft, 'pricing')
}

function toggleAdvanced(modelId: string): void {
  const next = new Set(open.value)
  if (next.has(modelId)) next.delete(modelId)
  else next.add(modelId)
  open.value = next
}

function applyBatch(): void {
  const parsed = toNumber(batchOutput.value)
  if (parsed !== null) add.setAllMaxTokens(parsed)
}
</script>

<template>
  <section class="confirm" data-step="confirm">
    <div class="blocks">
      <article
        v-for="draft in add.drafts"
        :key="draft.modelId"
        class="block"
        :data-draft="draft.modelId"
      >
        <header class="block-head">
          <span class="block-name">{{
            draft.displayName || draft.modelId
          }}</span>
          <code v-if="draft.displayName" class="block-id">{{
            draft.modelId
          }}</code>
          <span class="block-source">{{
            sourceLabel(draft.model.source)
          }}</span>
        </header>

        <div class="grid">
          <Field
            label="上下文"
            :hint="
              draft.unknown.includes('contextWindowTokens')
                ? '未知 · 保守默认值'
                : undefined
            "
          >
            <TextField
              type="number"
              size="sm"
              :model-value="String(draft.contextWindowTokens)"
              :aria-label="`${draft.modelId} 上下文`"
              @update:model-value="
                (v) => setNumber(draft, 'contextWindowTokens', v)
              "
            />
          </Field>
          <Field
            label="每次输出"
            :hint="
              draft.unknown.includes('maxTokens')
                ? '未知 · 保守默认值'
                : draft.maxOutputLimit
                  ? `上限 ${formatTokenCount(draft.maxOutputLimit)}`
                  : undefined
            "
          >
            <TextField
              type="number"
              size="sm"
              :model-value="String(draft.maxTokens)"
              :aria-label="`${draft.modelId} 每次输出`"
              @update:model-value="(v) => setNumber(draft, 'maxTokens', v)"
            />
          </Field>
          <Field
            v-if="reasoningOptions(draft.model).length"
            label="思考强度"
            :hint="reasoningHint({ provider: add.connection.provider ?? '' })"
          >
            <Select
              size="sm"
              :model-value="draft.reasoningEffort ?? ''"
              :options="
                reasoningOptions(draft.model).map((o) => ({
                  value: o.value ?? '',
                  label: o.label,
                }))
              "
              :aria-label="`${draft.modelId} 思考强度`"
              @update:model-value="
                (v) => {
                  draft.reasoningEffort = v ? String(v) : null
                  setLocked(draft, 'reasoningEffort')
                }
              "
            />
          </Field>
        </div>

        <div class="caps">
          <div v-for="cap in CAPABILITIES" :key="cap.key" class="cap">
            <span class="cap-label">{{ cap.label }}</span>
            <Segmented
              size="sm"
              :model-value="capabilityValue(draft, cap.key)"
              :options="[
                { value: 'auto', label: autoLabel(draft, cap.key) },
                { value: 'on', label: '开' },
                { value: 'off', label: '关' },
              ]"
              :aria-label="`${draft.modelId} ${cap.label}`"
              @update:model-value="
                (v) => setCapability(draft, cap.key, String(v))
              "
            />
          </div>
        </div>

        <Notice
          v-if="draft.unknown.length"
          tone="warn"
          title="有数值是保守默认值（未知）"
          description="这个模型的上下文或输出上限没有可靠来源，请核对后再保存。"
        >
          <template #actions>
            <Checkbox
              v-model="draft.confirmed"
              data-confirm-unknown
              label="我已核对这些数值"
            />
          </template>
        </Notice>

        <LinkButton
          class="advanced-toggle"
          :aria-expanded="open.has(draft.modelId)"
          @click="toggleAdvanced(draft.modelId)"
          >{{ open.has(draft.modelId) ? '收起高级' : '高级' }}</LinkButton
        >
        <div v-if="open.has(draft.modelId)" class="grid">
          <Field label="显示名">
            <TextField
              v-model="draft.displayName"
              size="sm"
              :placeholder="draft.modelId"
              @update:model-value="setLocked(draft, 'displayName')"
            />
          </Field>
          <Field
            label="温度"
            :hint="temperatureState(draft.model).note ?? '留空则不发送'"
          >
            <TextField
              type="number"
              size="sm"
              :disabled="!temperatureState(draft.model).enabled"
              :model-value="
                draft.temperature === null ? '' : String(draft.temperature)
              "
              :aria-label="`${draft.modelId} 温度`"
              @update:model-value="(v) => setTemperature(draft, v)"
            />
          </Field>
          <Field label="输入单价（美元 / 百万 token）">
            <TextField
              type="number"
              size="sm"
              :model-value="
                draft.pricing
                  ? String(draft.pricing.inputUsdPerMillionTokens)
                  : ''
              "
              @update:model-value="
                (v) => setPrice(draft, 'inputUsdPerMillionTokens', v)
              "
            />
          </Field>
          <Field label="输出单价（美元 / 百万 token）">
            <TextField
              type="number"
              size="sm"
              :model-value="
                draft.pricing
                  ? String(draft.pricing.outputUsdPerMillionTokens)
                  : ''
              "
              @update:model-value="
                (v) => setPrice(draft, 'outputUsdPerMillionTokens', v)
              "
            />
          </Field>
        </div>
      </article>
    </div>

    <div class="bottom">
      <div v-if="add.drafts.length > 1" class="batch">
        <TextField
          v-model="batchOutput"
          type="number"
          size="sm"
          placeholder="统一每次输出"
          aria-label="统一每次输出"
        />
        <Button size="sm" variant="secondary" @click="applyBatch">应用</Button>
      </div>
      <Field label="设为当前模型" class="activate">
        <Select
          size="sm"
          :model-value="add.activateModelId ?? ''"
          :options="activateOptions"
          aria-label="设为当前模型"
          @update:model-value="
            (v) => (add.activateModelId = v ? String(v) : null)
          "
        />
      </Field>
    </div>

    <Notice v-if="add.saveError" tone="error" :title="add.saveError" />

    <div class="footer">
      <Button variant="ghost" @click="add.step = 'pick'">上一步</Button>
      <Button
        variant="primary"
        :loading="add.saving"
        :disabled="add.blocked"
        @click="add.save()"
        >添加 {{ add.drafts.length }} 个模型</Button
      >
    </div>
  </section>
</template>

<style scoped>
.confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}

.blocks {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-height: 440px;
  overflow-y: auto;
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--r-md);
  background: var(--surface-hover);
}

.block-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.block-name {
  font-weight: 500;
}

.block-id {
  font: var(--font-code-small);
  color: rgb(var(--text-2));
}

.block-source {
  margin-left: auto;
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-3);
}

.caps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.cap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cap-label {
  font-size: var(--fs-xs);
  color: rgb(var(--text-2));
}

.advanced-toggle {
  align-self: flex-start;
}

.bottom {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}

.batch {
  display: flex;
  gap: var(--space-2);
}

.activate {
  margin-left: auto;
  min-width: 220px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
