<script setup lang="ts">
/**
 * ModelPicker — dsh ModelSelect: 28px trigger (model name + caption effort +
 * chevron) opening an upward menu with the saved model entries and the
 * current model's reasoning-effort choices. Selection flows back through the
 * composer controller (switch-model / set-reasoning-effort).
 */
import { computed, ref } from 'vue'
import type { ModelEntry } from '../../types'
import Chip from '../ui/Chip.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'

const props = defineProps<{
  entries: ModelEntry[]
  activeId: string
  label: string
  reasoningLabel: string
  reasoningValue: string
  reasoningOptions: Array<{ value: string | null; label: string }>
  providerLabel: (provider: string) => string
  disabled?: boolean
  title?: string
}>()

const emit = defineEmits<{
  'select-model': [entryId: string]
  'select-reasoning': [value: string | null]
}>()

const open = ref(false)
const anchor = ref<HTMLElement | null>(null)

const entries = computed(() => props.entries.filter((entry) => entry.entryId))
const showEffort = computed(
  () => props.reasoningOptions.length > 1 && props.reasoningValue !== '',
)

function entryLabel(entry: ModelEntry): string {
  return entry.effectiveDisplayName || entry.modelId || '模型'
}
</script>

<template>
  <span ref="anchor" class="model-picker">
    <Chip
      chevron
      :active="open"
      :disabled="disabled"
      :title="title"
      aria-haspopup="menu"
      aria-label="模型与思考"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="name">{{ label }}</span>
      <span v-if="showEffort" class="effort">{{ reasoningLabel }}</span>
    </Chip>
  </span>
  <Menu v-model:open="open" :anchor="anchor" :width="280" label="模型与思考">
    <MenuItem variant="label">模型 · 下一轮生效</MenuItem>
    <MenuItem
      v-for="entry in entries"
      :key="entry.entryId"
      :selected="entry.entryId === activeId"
      :description="`${providerLabel(entry.provider)} · ${entry.modelId || '未配置'}`"
      @select="emit('select-model', entry.entryId)"
    >
      {{ entryLabel(entry) }}
    </MenuItem>
    <template v-if="reasoningOptions.length > 1">
      <MenuItem variant="separator" />
      <MenuItem variant="label">思考强度</MenuItem>
      <div class="efforts" role="group" aria-label="思考强度">
        <button
          v-for="option in reasoningOptions"
          :key="option.label"
          type="button"
          class="effort-choice"
          :data-active="(option.value || '') === reasoningValue || undefined"
          :disabled="disabled"
          @click="emit('select-reasoning', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </template>
  </Menu>
</template>

<style scoped>
.model-picker {
  display: inline-flex;
  min-width: 0;
  max-width: min(360px, 45cqw);
}

.model-picker :deep(.ds-chip) {
  max-width: 100%;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.effort {
  margin-left: var(--space-1);
  color: rgb(var(--label-caption));
}

.efforts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: 0 var(--space-2-5) var(--space-2);
}

.effort-choice {
  height: var(--space-6);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.effort-choice:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}

.effort-choice[data-active] {
  border-color: rgb(var(--accent-fill) / 0.6);
  background: rgb(var(--accent-soft));
  color: rgb(var(--accent-strong));
}

.effort-choice:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
