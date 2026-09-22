<script setup lang="ts">
/** TodoWriteView — the written task list as a checklist. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import { DsCheck } from '../../icons/ds'
import GenericToolCard from './GenericToolCard.vue'
import { todoItems } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const items = computed(() => todoItems(props.data))
</script>

<template>
  <ul v-if="items && items.length" class="todo-list">
    <li
      v-for="(item, index) in items"
      :key="index"
      class="todo"
      :data-status="item.status"
    >
      <span class="mark" aria-hidden="true">
        <DsCheck v-if="item.status === 'completed'" :size="12" />
      </span>
      <span class="content">{{ item.content }}</span>
      <span v-if="item.status === 'in_progress'" class="todo-badge"
        >进行中</span
      >
    </li>
  </ul>
  <GenericToolCard v-else :data="data" />
</template>

<style scoped>
.todo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  list-style: none;
}

.todo {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--lh-base);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-secondary));
}

.mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--border-l4);
  border-radius: var(--radius-xs);
  color: rgb(var(--label-inverted));
}

[data-status='completed'] .mark {
  border-color: rgb(var(--label-tertiary));
  background: rgb(var(--label-tertiary));
}

[data-status='in_progress'] .mark {
  border-color: rgb(var(--accent-fill));
  box-shadow: inset 0 0 0 3px rgb(var(--bg-base));
  background: rgb(var(--accent-fill));
}

[data-status='completed'] .content {
  color: rgb(var(--label-tertiary));
  text-decoration: line-through;
}

[data-status='in_progress'] .content {
  color: rgb(var(--label-primary));
}

.content {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.todo-badge {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--accent-strong));
}
</style>
