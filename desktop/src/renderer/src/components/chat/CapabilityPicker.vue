<script setup lang="ts">
import type { CapabilityPickerGroup, CapabilityPickerItem } from '../../capabilities/capabilityPicker'

const props = defineProps<{
  groups: CapabilityPickerGroup[]
  heading: string
  hint: string
  mode: 'add' | 'slash'
}>()

const emit = defineEmits<{
  select: [item: CapabilityPickerItem]
}>()
</script>

<template>
  <div class="composer-palette capability-picker" :data-mode="props.mode">
    <div class="composer-palette-head">
      <span>{{ props.heading }}</span>
      <em>{{ props.hint }}</em>
    </div>

    <section v-for="group in props.groups" :key="group.label" class="composer-palette-group">
      <div class="composer-palette-label">{{ group.label }}</div>
      <button
        v-for="item in group.items"
        :key="item.id"
        type="button"
        class="composer-palette-item capability-picker-item"
        :data-action="item.action"
        :data-tone="item.tone || item.capability?.tone || 'slate'"
        @click="emit('select', item)"
      >
        <span class="composer-palette-item-icon">
          <component :is="item.icon" :size="15" />
        </span>
        <strong>{{ item.label }}</strong>
        <span>{{ item.description }}</span>
        <b v-if="item.meta">{{ item.meta }}</b>
      </button>
    </section>
  </div>
</template>
