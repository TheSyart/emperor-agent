<script setup lang="ts">
/**
 * PullRequestRow — one list row: the PR glyph (open / draft) with a checks
 * dot, the title and its compact age, then `name · branch · +A −D`.
 *
 * Props: item; age (「1 周」); selected; focusable (roving tabindex).
 * Emits: select (click / Enter / Space — native button activation).
 */
import { computed } from 'vue'
import type { PullRequestListItem } from '../../../api/pullRequests'
import { pullStateIcon } from './pullIcons'

const props = defineProps<{
  item: PullRequestListItem
  age: string
  selected: boolean
  focusable: boolean
}>()
defineEmits<{ select: [] }>()

const icon = computed(() => pullStateIcon(props.item.state, props.item.isDraft))
/** The owner is dropped to leave room for the branch (full name in title). */
const repoName = computed(
  () => props.item.repo.split('/')[1] || props.item.repo,
)
const hasStats = computed(
  () => props.item.additions !== null || props.item.deletions !== null,
)
const checksLabel = computed(() => {
  if (props.item.checks === 'success') return '检查通过'
  if (props.item.checks === 'failure') return '检查失败'
  if (props.item.checks === 'pending') return '检查进行中'
  return ''
})
</script>

<template>
  <button
    type="button"
    class="pr-row"
    :data-pull-row="`${item.repo}#${item.number}`"
    :data-selected="selected || undefined"
    :aria-current="selected ? 'true' : undefined"
    :tabindex="focusable ? 0 : -1"
    :title="item.title"
    @click="$emit('select')"
  >
    <span class="glyph" :data-draft="item.isDraft || undefined">
      <component :is="icon" :size="16" aria-hidden="true" />
      <span
        v-if="item.checks"
        class="checks-dot"
        :data-checks="item.checks"
        role="img"
        :aria-label="checksLabel"
      />
    </span>
    <span class="main">
      <span class="line">
        <span class="title">{{ item.title }}</span>
        <span class="age">{{ age }}</span>
      </span>
      <span class="line meta">
        <span class="repo" :title="item.repo">{{ repoName }}</span>
        <template v-if="item.headRefName">
          <span class="sep" aria-hidden="true">·</span>
          <span class="branch">{{ item.headRefName }}</span>
        </template>
        <template v-if="hasStats">
          <span class="sep" aria-hidden="true">·</span>
          <span class="stats">
            <span class="add">+{{ item.additions ?? 0 }}</span>
            <span class="del">−{{ item.deletions ?? 0 }}</span>
          </span>
        </template>
      </span>
    </span>
  </button>
</template>

<style scoped>
.pr-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  width: 100%;
  min-width: 0;
  padding: var(--space-2) var(--space-2-5);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.pr-row:hover {
  background: var(--interactive-bg-hover);
}

.pr-row[data-selected] {
  background: var(--interactive-bg-active);
}

.pr-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.glyph {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--space-5);
  height: var(--lh-xs);
  color: rgb(var(--state-ok-label));
}

.glyph[data-draft] {
  color: rgb(var(--label-tertiary));
}

.checks-dot {
  position: absolute;
  right: 0;
  bottom: 0;
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-pill);
  box-shadow: 0 0 0 2px rgb(var(--bg-base));
}

.checks-dot[data-checks='success'] {
  background: rgb(var(--state-ok));
}

.checks-dot[data-checks='failure'] {
  background: rgb(var(--danger));
}

.checks-dot[data-checks='pending'] {
  background: rgb(var(--warn));
}

.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.age {
  flex: none;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.meta {
  gap: var(--space-1);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.repo {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch {
  flex: 0 10 auto;
  min-width: var(--space-6);
  overflow: hidden;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sep {
  flex: none;
  color: rgb(var(--label-caption));
}

.stats {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--state-ok-label));
}

.del {
  color: rgb(var(--state-error-label));
}
</style>
