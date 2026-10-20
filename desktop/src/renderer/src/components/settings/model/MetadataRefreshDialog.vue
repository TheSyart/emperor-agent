<script setup lang="ts">
/**
 * MetadataRefreshDialog — 刷新模型资料 for a provider card (MOD-05): reads
 * what the bundled catalog would change for its models (`model.refresh
 * Metadata`, a preview that writes nothing), lists the changes per model,
 * and applies them on 「应用」. Values the user set are locked and never
 * appear (Core leaves them out). After applying, the config is re-read.
 *
 * Props: open (v-model), label (provider name), entries (the card's models).
 * Emits: updated(payload) after applying.
 */
import { computed, ref, watch } from 'vue'
import type { ModelMetadataDiff } from '@emperor/core/api'
import { core } from '../../../api/http'
import type { ModelConfigPayload, ModelEntry } from '../../../types'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import Spinner from '../../ui/Spinner.vue'
import { EmptyState } from '../ui'
import { formatTokenCount, modelEntryLabel } from './modelFormModel'

const props = defineProps<{ label: string; entries: readonly ModelEntry[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ updated: [payload: ModelConfigPayload] }>()

const diffs = ref<ModelMetadataDiff[] | null>(null)
const loading = ref(false)
const applying = ref(false)
const error = ref('')

const FIELD_LABELS: Record<string, string> = {
  contextWindowTokens: '上下文',
  maxTokens: '每次输出',
  pricing: '单价',
  capabilities: '能力',
  reasoningEffort: '思考强度',
  displayName: '显示名',
}

const ids = computed(() => props.entries.map((entry) => entry.entryId))
const changed = computed(() =>
  (diffs.value ?? []).filter((diff) => diff.changes.length > 0),
)

function nameOf(entryId: string, modelId: string): string {
  const entry = props.entries.find((item) => item.entryId === entryId)
  return entry ? modelEntryLabel(entry) : modelId
}

function show(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '未知'
  if (
    (field === 'contextWindowTokens' || field === 'maxTokens') &&
    typeof value === 'number'
  )
    return formatTokenCount(value)
  if (field === 'pricing' && typeof value === 'object') {
    const price = value as Record<string, number>
    return `$${price.inputUsdPerMillionTokens} / $${price.outputUsdPerMillionTokens}`
  }
  if (field === 'capabilities' && typeof value === 'object') {
    const caps = value as Record<string, unknown>
    return (
      [
        caps.toolCall ? '工具' : '',
        caps.vision ? '识图' : '',
        caps.reasoning ? '思考' : '',
      ]
        .filter(Boolean)
        .join('、') || '无'
    )
  }
  return String(value)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  diffs.value = null
  try {
    const result = await core('model.refreshMetadata', { entryIds: ids.value })
    diffs.value = result.diffs
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function apply(): Promise<void> {
  if (applying.value || !changed.value.length) return
  applying.value = true
  error.value = ''
  try {
    await core('model.refreshMetadata', { entryIds: ids.value, apply: true })
    emit('updated', await core('model.getConfig'))
    open.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    applying.value = false
  }
}

watch(
  open,
  (value) => {
    if (value) void load()
  },
  { immediate: true },
)
</script>

<template>
  <Modal v-model:open="open" :title="`刷新 ${label} 的模型资料`" :width="520">
    <div class="refresh-dialog" data-testid="metadata-refresh-dialog">
      <p class="lead">
        按内置模型目录核对上下文、输出上限、能力与单价；你设置过的值不会改。
      </p>
      <div v-if="loading" class="loading"><Spinner size="sm" /> 正在核对…</div>
      <p v-else-if="error" class="error" role="alert">{{ error }}</p>
      <EmptyState
        v-else-if="diffs && !changed.length"
        title="已是最新"
        description="这些模型的资料与内置目录一致。"
        variant="inline"
      />
      <ul v-else-if="changed.length" class="diffs">
        <li v-for="diff in changed" :key="diff.entryId" class="diff">
          <span class="model">{{ nameOf(diff.entryId, diff.modelId) }}</span>
          <ul class="changes">
            <li
              v-for="change in diff.changes"
              :key="change.field"
              class="change"
              :data-change="`${diff.entryId}:${change.field}`"
            >
              <span class="field">{{
                FIELD_LABELS[change.field] ?? change.field
              }}</span>
              <span class="values"
                >{{ show(change.field, change.from) }} →
                <strong>{{ show(change.field, change.to) }}</strong></span
              >
            </li>
          </ul>
        </li>
      </ul>
      <div class="actions">
        <Button variant="secondary" @click="open = false">{{
          changed.length ? '取消' : '关闭'
        }}</Button>
        <Button
          v-if="changed.length"
          variant="primary"
          :disabled="applying"
          @click="apply"
          >{{ applying ? '应用中…' : '应用' }}</Button
        >
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.refresh-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.lead {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}

.error {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.diffs,
.changes {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.diffs {
  gap: var(--space-3);
  max-height: 320px;
  overflow-y: auto;
}

.diff {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.model {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-medium);
}

.change {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
  font-variant-numeric: tabular-nums;
}

.values strong {
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
