<script setup lang="ts">
/**
 * ModelPolicyGroup — Settings › 模型 › 执行与成本策略: the explicit, default-off
 * fallback model (switch, target, trigger conditions) and the per-Agent-turn
 * cost cap, as SettingsRows under one group. Edits stay local until 「保存策略」
 * (`model.savePolicy`); the group resets from the payload after a save or a
 * refresh.
 *
 * Props: payload (the model config payload).
 * Emits: updated(payload) after a successful save.
 */
import { computed, ref, watch } from 'vue'
import { saveModelPolicy } from '../../../api/model'
import type { ModelConfigPayload } from '../../../types'
import Button from '../../ui/Button.vue'
import {
  Select,
  SettingsGroup,
  SettingsRow,
  StatusBadge,
  Switch,
  TextField,
  settingsId,
  type SelectOption,
} from '../ui'
import {
  buildModelPolicy,
  modelEntryLabel,
  policyDraftFrom,
  policyDraftsEqual,
  type ModelPolicyDraft,
} from './modelFormModel'

const props = defineProps<{ payload: ModelConfigPayload }>()
const emit = defineEmits<{ updated: [payload: ModelConfigPayload] }>()

const uid = settingsId('model-policy')
const draft = ref<ModelPolicyDraft>(policyDraftFrom(props.payload.policy))
const saving = ref(false)
const error = ref('')
const saved = ref(false)

const baseline = computed(() => policyDraftFrom(props.payload.policy))
const dirty = computed(() => !policyDraftsEqual(draft.value, baseline.value))

const costCap = computed({
  get: () => String(draft.value.costCapUsd ?? ''),
  set: (value: string | number) => {
    draft.value.costCapUsd = value
  },
})

const targetOptions = computed<SelectOption[]>(() =>
  props.payload.models
    .filter((entry) => entry.entryId !== props.payload.activeModelId)
    .map((entry) => ({ value: entry.entryId, label: modelEntryLabel(entry) })),
)

watch(
  () => props.payload.policy,
  (policy) => {
    draft.value = policyDraftFrom(policy)
  },
  { deep: true },
)

watch(
  draft,
  () => {
    error.value = ''
    if (dirty.value) saved.value = false
  },
  { deep: true },
)

async function save(): Promise<void> {
  if (saving.value) return
  error.value = ''
  let policy
  try {
    policy = buildModelPolicy(draft.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return
  }
  saving.value = true
  try {
    const payload = await saveModelPolicy(policy)
    emit('updated', payload)
    saved.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsGroup
    title="执行与成本策略"
    description="默认不会自动切换模型；以下策略只有保存后才生效。"
    data-testid="model-policy"
  >
    <template #actions>
      <StatusBadge v-if="saved && !dirty" tone="ok" role="status">
        已保存
      </StatusBadge>
      <Button
        size="sm"
        variant="outline"
        :disabled="saving || !dirty"
        @click="save"
      >
        {{ saving ? '保存中…' : '保存策略' }}
      </Button>
    </template>

    <SettingsRow
      title="备用模型"
      description="主模型完成自身重试后仍失败时，按所选错误类型切换一次；下一 Agent 轮仍从主模型开始。"
      :label-for="`${uid}-fallback`"
    >
      <Switch :id="`${uid}-fallback`" v-model="draft.fallbackEnabled" />
    </SettingsRow>
    <template v-if="draft.fallbackEnabled">
      <SettingsRow title="切换到" dense>
        <Select
          v-model="draft.fallbackEntryId"
          :options="targetOptions"
          placeholder="请选择"
          size="sm"
          aria-label="备用模型"
          :disabled="!targetOptions.length"
        />
      </SettingsRow>
      <SettingsRow title="限流耗尽时切换" dense :label-for="`${uid}-rate`">
        <Switch :id="`${uid}-rate`" v-model="draft.onRateLimit" />
      </SettingsRow>
      <SettingsRow
        title="服务或网络暂时失败时切换"
        dense
        :label-for="`${uid}-transient`"
      >
        <Switch :id="`${uid}-transient`" v-model="draft.onTransient" />
      </SettingsRow>
    </template>
    <SettingsRow
      title="每 Agent 轮成本上限"
      description="启用前需为主模型和备用模型填写完整单价；未知成本不会按 0 计算，账本会标记为不完整。"
      :label-for="`${uid}-cap`"
    >
      <TextField
        :id="`${uid}-cap`"
        v-model="costCap"
        class="cap"
        type="number"
        min="0.000001"
        step="0.001"
        inputmode="decimal"
        placeholder="不限制"
        size="sm"
      >
        <template #trailing><span class="unit">USD</span></template>
      </TextField>
    </SettingsRow>
    <p v-if="error" class="policy-error" role="alert">{{ error }}</p>
  </SettingsGroup>
</template>

<style scoped>
.cap {
  width: calc(var(--space-8) * 4);
}

.unit {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.policy-error {
  margin: 0;
  padding-top: var(--space-2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}
</style>
