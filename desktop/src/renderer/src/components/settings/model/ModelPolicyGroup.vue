<script setup lang="ts">
/**
 * ModelPolicyGroup — Settings › 模型 › 执行与成本策略: the explicit, default-off
 * fallback model (switch, target, trigger conditions) and the per-Agent-turn
 * cost cap, as SettingsRows under one group. Every change saves at once
 * (`model.savePolicy`; MOD-05): a switch or a choice when it changes, the
 * cap when the field is left (or Enter). A backup switched on without a
 * target waits for one. A model without prices is not covered by the cap:
 * the group names it instead of stopping turns. The group resets from the
 * payload after a save or a refresh.
 *
 * Props: payload (the model config payload).
 * Emits: updated(payload) after a successful save.
 */
import { computed, ref, watch } from 'vue'
import { saveModelPolicy } from '../../../api/model'
import type { ModelConfigPayload } from '../../../types'
import {
  Select,
  SettingsGroup,
  SettingsRow,
  Badge,
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
import { unpricedUnderCap } from './modelListModel'

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

const unpriced = computed(() =>
  unpricedUnderCap(props.payload).map(modelEntryLabel),
)
const waitingForTarget = computed(
  () => draft.value.fallbackEnabled && !draft.value.fallbackEntryId,
)

watch(
  draft,
  () => {
    error.value = ''
    if (dirty.value) saved.value = false
  },
  { deep: true },
)

/** Save the switches and choices as soon as they change. */
watch(
  () => [
    draft.value.fallbackEnabled,
    draft.value.fallbackEntryId,
    draft.value.onRateLimit,
    draft.value.onTransient,
  ],
  () => {
    if (dirty.value && !waitingForTarget.value) void save()
  },
)

async function save(): Promise<void> {
  if (saving.value || !dirty.value) return
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
    description="默认不会自动切换模型；改动立即生效。"
    data-testid="model-policy"
  >
    <template #actions>
      <Badge v-if="saved && !dirty" tone="ok" role="status"> 已保存 </Badge>
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
        <template v-if="waitingForTarget" #description
          >选好备用模型后生效</template
        >
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
    <SettingsRow title="每个任务的费用上限" :label-for="`${uid}-cap`">
      <template #description>
        <span
          >从你发出一条消息起，主对话、子智能体与失败的请求都计入；按模型单价累计，未知成本不会按
          0 计算，账本会标记为不完整。</span
        >
        <span
          v-for="name in unpriced"
          :key="name"
          class="unpriced"
          data-unpriced
          >「{{ name }}」没有单价，成本上限对它不生效</span
        >
      </template>
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
        @change="save"
        @keydown.enter="save"
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
  color: rgb(var(--text-3));
}

.unpriced {
  display: block;
  color: rgb(var(--state-warn-label));
}

.policy-error {
  margin: 0;
  padding-top: var(--space-2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}
</style>
