<script setup lang="ts">
/**
 * GitHubLabels — an issue's labels as small text chips with a color dot.
 * The color comes from GitHub; only a plain six-digit hex is used, anything
 * else draws the neutral dot. Label names are plain text. Spans with list
 * roles, so the chips can sit inside a row button.
 *
 * Props: labels.
 */
import type { GitHubLabel } from '../../../api/github'
import { labelColor } from './githubModel'

defineProps<{ labels: readonly GitHubLabel[] }>()

function dotStyle(color: string): Record<string, string> | undefined {
  const css = labelColor(color)
  return css ? { background: css } : undefined
}
</script>

<template>
  <span v-if="labels.length" class="labels" role="list">
    <span
      v-for="label in labels"
      :key="label.name"
      class="label"
      role="listitem"
    >
      <span class="dot" :style="dotStyle(label.color)" aria-hidden="true" />
      {{ label.name }}
    </span>
  </span>
</template>

<style scoped>
.labels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.dot {
  flex: none;
  width: var(--space-2);
  height: var(--space-2);
  border-radius: 50%;
  background: rgb(var(--label-caption));
}
</style>
