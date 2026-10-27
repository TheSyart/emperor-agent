<script setup lang="ts">
/**
 * GroupTaskCard — a task handed out in the group (GRP-08, 预览 B 第 3 步):
 * its title and where it is now (排队中, 进行中, 已完成, …), then 交付, 依据
 * and 权限. A task for Claude Code or Codex to change code that a member
 * handed out waits for the user (GRP-09): 「同意」 runs it in an isolated
 * copy whose changes come back as a result card; 「不同意」 cancels it.
 *
 * Props: task. Emits: confirm(approve).
 */
import { computed } from 'vue'
import Button from '../ui/Button.vue'
import { ACCESS_LABELS, TASK_STATE_LABELS, type GroupTask } from './groupModel'

const props = defineProps<{ task: GroupTask }>()
const emit = defineEmits<{ confirm: [approve: boolean] }>()

const waiting = computed(() => props.task.state === 'waiting_user')
const tone = computed(() => {
  switch (props.task.state) {
    case 'running':
      return 'run'
    case 'done':
      return 'done'
    case 'waiting_user':
      return 'ask'
    case 'failed':
    case 'cancelled':
      return 'off'
    default:
      return 'queued'
  }
})
</script>

<template>
  <section class="task" data-task-card :data-state="task.state">
    <header class="head">
      <b class="title">{{ task.title }}</b>
      <span class="state" data-task-state :data-tone="tone">{{
        TASK_STATE_LABELS[task.state]
      }}</span>
    </header>
    <dl class="kv">
      <dt>交付</dt>
      <dd>{{ task.deliverable }}</dd>
      <template v-if="task.basis">
        <dt>依据</dt>
        <dd>{{ task.basis }}</dd>
      </template>
      <dt>权限</dt>
      <dd>{{ ACCESS_LABELS[task.access] }}</dd>
    </dl>
    <div v-if="waiting" class="confirm" data-task-confirm>
      <p class="note">
        要改项目代码：同意后它在隔离副本里改，改动先给你看，你确认后才合进项目。
      </p>
      <div class="actions">
        <Button size="sm" variant="secondary" @click="emit('confirm', false)"
          >不同意</Button
        >
        <Button size="sm" variant="primary" @click="emit('confirm', true)"
          >同意</Button
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.task {
  display: grid;
  gap: var(--space-1-5);
  max-width: 560px;
  margin-top: var(--space-1);
  padding: var(--space-2-5) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--surface-base));
  box-shadow: 0 0 0 0.5px var(--hairline);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.title {
  min-width: 0;
  font-weight: var(--weight-semibold);
}

.state {
  flex: none;
  margin-left: auto;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}

.state[data-tone='run'] {
  color: rgb(var(--info));
}

.state[data-tone='done'] {
  color: rgb(var(--ok));
}

.state[data-tone='ask'] {
  color: rgb(var(--attention));
}

.kv {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: var(--space-1) var(--space-2-5);
  margin: 0;
}

.kv dt {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}

.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}

.note {
  flex: 1 1 240px;
  margin: 0;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.actions {
  display: flex;
  gap: var(--space-1-5);
}
</style>
