<script setup lang="ts">
/**
 * AddModelDialog — add models in three steps (MOD-04): 连接 (provider or
 * a pasted address, the key, a probe and the vendor's list) → 选择模型
 * (families, filters, preselection, manual ids) → 确认参数 (context,
 * output, capabilities, thinking, advanced), then one `model.saveEntries`.
 * With `manageProvider` it opens at step 2 for a saved provider: saved
 * models start checked, unchecking one removes it (not the one in use).
 *
 * Props: open (v-model), payload (the current model config),
 * manageProvider?.
 * Emits: saved(payload & { savedEntryIds }) — the dialog has closed.
 */
import { computed, watch } from 'vue'
import Modal from '../../ui/Modal.vue'
import type { ModelConfigPayload } from '../../../types'
import ConfirmParamsStep from './ConfirmParamsStep.vue'
import ConnectStep from './ConnectStep.vue'
import PickModelsStep from './PickModelsStep.vue'
import {
  createAddModelController,
  provideAddModel,
  type AddModelStep,
} from './addModelController'

const props = defineProps<{
  payload: ModelConfigPayload
  manageProvider?: string | null
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  saved: [result: ModelConfigPayload & { savedEntryIds: string[] }]
}>()

const controller = createAddModelController({
  payload: () => props.payload,
  manageProvider: props.manageProvider ?? null,
  onSaved: (result) => {
    open.value = false
    emit('saved', result)
  },
})
provideAddModel(controller)

watch(
  open,
  (value) => {
    if (value) void controller.start()
  },
  { immediate: true },
)

const STEPS: ReadonlyArray<{ key: AddModelStep; label: string }> = [
  { key: 'connect', label: '连接' },
  { key: 'pick', label: '选择模型' },
  { key: 'confirm', label: '确认参数' },
]
const title = computed(() => (controller.manage ? '管理模型' : '添加模型'))
const current = computed(() =>
  STEPS.findIndex((item) => item.key === controller.step),
)
</script>

<template>
  <Modal v-model:open="open" :title="title" :width="760">
    <div class="add-model" data-testid="add-model-dialog">
      <ol class="steps" aria-label="步骤">
        <li
          v-for="(item, index) in STEPS"
          :key="item.key"
          :data-state="
            index < current ? 'done' : index === current ? 'current' : 'next'
          "
          :aria-current="index === current ? 'step' : undefined"
        >
          <span class="step-index">{{ index + 1 }}</span>
          {{ item.label }}
        </li>
      </ol>
      <ConnectStep v-if="controller.step === 'connect'" />
      <PickModelsStep v-else-if="controller.step === 'pick'" />
      <ConfirmParamsStep v-else />
    </div>
  </Modal>
</template>

<style scoped>
.add-model {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
}

.steps {
  display: flex;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}

.steps li {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}

.steps li[data-state='current'] {
  font-weight: 500;
  color: rgb(var(--text-1));
}

.step-index {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--r-full);
  background: var(--surface-hover);
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
}

.steps li[data-state='current'] .step-index {
  background: rgb(var(--text-1));
  color: rgb(var(--surface-base));
}
</style>
