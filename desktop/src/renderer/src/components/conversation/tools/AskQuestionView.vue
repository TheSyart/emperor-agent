<script setup lang="ts">
/**
 * AskQuestionView — the asked questions with the chosen answers
 * (replaces AskHistoryCard): per question its header, text, options with
 * the selected ones checked, and a custom answer.
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import { DsCheck } from '../../icons/ds'
import { questionItems } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const items = computed(() => questionItems(props.data))
const outcome = computed(() => {
  if (props.data.status === 'running') return '等待回答…'
  switch (props.data.question?.outcome) {
    case 'cancelled':
      return '用户关闭了提问'
    case 'unavailable':
      return '当前无法向用户提问'
    default:
      return ''
  }
})
</script>

<template>
  <div class="ask-view">
    <div v-for="item in items" :key="item.id" class="question">
      <div v-if="item.header" class="header">{{ item.header }}</div>
      <div class="text">{{ item.question }}</div>
      <ul v-if="item.options.length" class="options">
        <li
          v-for="option in item.options"
          :key="option.label"
          class="option"
          :data-selected="item.selected.includes(option.label) || undefined"
        >
          <span class="check" aria-hidden="true">
            <DsCheck v-if="item.selected.includes(option.label)" :size="12" />
          </span>
          <span class="label">{{ option.label }}</span>
          <span v-if="option.description" class="description">{{
            option.description
          }}</span>
        </li>
      </ul>
      <div v-if="item.custom" class="custom">
        <span class="custom-label">自定义回答</span>{{ item.custom }}
      </div>
      <div
        v-else-if="
          data.question?.outcome === 'answered' && item.selected.length === 0
        "
        class="skipped"
      >
        未作答
      </div>
    </div>
    <div v-if="outcome" class="outcome">{{ outcome }}</div>
  </div>
</template>

<style scoped>
.ask-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
}

.question {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.header {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.text {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
}

.options {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

.option {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.check {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  align-self: center;
  border: 1px solid var(--border-l3);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-inverted));
}

[data-selected] .check {
  border-color: rgb(var(--accent-fill));
  background: rgb(var(--accent-fill));
}

[data-selected] .label {
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.description {
  min-width: 0;
  overflow-wrap: anywhere;
}

.custom,
.skipped,
.outcome {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.custom-label {
  margin-right: var(--space-2);
  color: rgb(var(--label-tertiary));
}

.skipped,
.outcome {
  color: rgb(var(--label-tertiary));
}
</style>
