<script setup lang="ts">
/**
 * ModelPolicyGroup — Settings › 模型 › 执行策略: the explicit, default-off
 * fallback model (switch, target, trigger conditions) as SettingsRows under
 * one group. Every change saves at once (`model.savePolicy`; MOD-05). A
 * backup switched on without a target waits for one. The per-task cost cap
 * moved to 设置 › 用量与费用 (SET-01); a link row leads there, and saving
 * here keeps the cap as it is. The group resets from the payload after a
 * save or a refresh.
 *
 * Props: payload (the model config payload).
 * Emits: updated(payload) after a successful save.
 */
import { computed, ref, watch } from 'vue'
import { saveModelPolicy } from '../../../api/model'
import { useSettingsRoute } from '../useSettingsRoute'
import type { ModelConfigPayload } from '../../../types'
import {
  Select,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  Badge,
  Switch,
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

const { openSettings } = useSettingsRoute()

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
    title="执行策略"
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
    <SettingsLinkRow
      title="费用和限制"
      description="费用和限制在「用量与费用」里统一设置"
      data-usage-link
      @click="openSettings('tokens')"
    />
    <p v-if="error" class="policy-error" role="alert">{{ error }}</p>
  </SettingsGroup>
</template>

<style scoped>
.policy-error {
  margin: 0;
  padding-top: var(--space-2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}
</style>
