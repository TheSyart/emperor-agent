<script setup lang="ts">
/**
 * One row of a 设置 › 诊断 card, the same in all five cards: the label,
 * and its value as plain text on the right. A path is the value itself and
 * sits under the label in the code font, where a long one can wrap. A row
 * that needs attention colors its value and says why under the label; a
 * normal row keeps the why as the label's tooltip. No status badges.
 *
 * Props: row ({ label, value, detail, tone, mono? }).
 * Slots: default (an action after the value, e.g. 打开文件夹).
 */
import { computed } from 'vue'
import { SettingsRow } from '../ui'

const props = defineProps<{
  row: {
    label: string
    value: string
    detail: string
    tone: 'ok' | 'warn' | 'error' | 'muted' | 'running'
    mono?: boolean
  }
}>()

const problem = computed(
  () => props.row.tone === 'warn' || props.row.tone === 'error',
)
</script>

<template>
  <SettingsRow dense>
    <template #title>
      <span class="label" :title="row.detail || undefined">{{
        row.label
      }}</span>
    </template>
    <template v-if="row.mono" #description>
      <span class="value" data-mono :data-tone="row.tone">{{ row.value }}</span>
    </template>
    <template v-else-if="problem && row.detail" #description>
      <span class="detail" :title="row.detail">{{ row.detail }}</span>
    </template>
    <span v-if="!row.mono" class="value" :data-tone="row.tone">{{
      row.value
    }}</span>
    <slot />
  </SettingsRow>
</template>

<style scoped>
.label {
  display: block;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 400;
}

/* One or two lines of why; the full text is the tooltip. */
.detail {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}

.value {
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}

.value[data-mono] {
  display: block;
  font-family: var(--font-mono);
  text-align: left;
}

.value[data-tone='warn'] {
  font-weight: 500;
  color: rgb(var(--state-warn-label));
}

.value[data-tone='error'] {
  font-weight: 500;
  color: rgb(var(--state-error-label));
}

.value[data-tone='muted'] {
  color: rgb(var(--label-tertiary));
}

.value[data-tone='running'] {
  color: rgb(var(--accent-strong));
}
</style>
