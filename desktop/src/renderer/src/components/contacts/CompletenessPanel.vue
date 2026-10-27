<script setup lang="ts">
/**
 * CompletenessPanel — 完整度 (GRP-04): the five binary rules of a role card
 * (交付、≥ 2 步方法、边界、工具与权限一致、跑过试用台), a meter and one line
 * per rule. A hint only: saving is never blocked.
 *
 * Props: items (contactEditorModel.completeness).
 */
import { computed } from 'vue'
import type { CompletenessItem } from './contactEditorModel'

const props = defineProps<{ items: readonly CompletenessItem[] }>()

const done = computed(() => props.items.filter((item) => item.done).length)
const percent = computed(() =>
  props.items.length ? Math.round((done.value / props.items.length) * 100) : 0,
)
</script>

<template>
  <section class="completeness" data-completeness aria-label="完整度">
    <header class="head">
      <h3 class="title">完整度</h3>
      <span class="count">{{ done }} / {{ items.length }}</span>
    </header>
    <div
      class="meter"
      role="progressbar"
      aria-label="完整度"
      :aria-valuenow="done"
      aria-valuemin="0"
      :aria-valuemax="items.length"
    >
      <span class="fill" :style="{ width: `${percent}%` }" />
    </div>
    <ul class="checks">
      <li
        v-for="item in items"
        :key="item.key"
        :data-check="item.key"
        :data-done="String(item.done)"
      >
        {{ item.label }}
      </li>
    </ul>
    <p class="note">只是提示，不影响保存。</p>
  </section>
</template>

<style scoped>
.completeness {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.title {
  margin: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.count {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
}

.meter {
  height: 6px;
  overflow: hidden;
  border-radius: var(--r-full);
  background: rgb(var(--surface-sunken));
}

.fill {
  display: block;
  height: 100%;
  background: rgb(var(--accent));
}

.checks {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.checks li::before {
  content: '✓';
  display: inline-block;
  width: var(--space-4);
  color: rgb(var(--ok));
}

.checks li[data-done='false']::before {
  content: '○';
  color: rgb(var(--text-4));
}

.note {
  margin: 0;
  color: rgb(var(--text-4));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}
</style>
