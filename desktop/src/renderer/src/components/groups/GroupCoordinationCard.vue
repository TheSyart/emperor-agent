<script setup lang="ts">
/** CG-00: a system arrangement, simple sequential plan, or conclusion. */
import { computed } from 'vue'
import { Check, GitBranch } from 'lucide-vue-next'
import GroupMarkdown from './GroupMarkdown.vue'
import type { GroupHistoryMessage, GroupMemberView } from './groupModel'

const props = defineProps<{
  message: GroupHistoryMessage
  members: readonly GroupMemberView[]
}>()

const coordination = computed(() => props.message.coordination)
const conclusion = computed(() => coordination.value?.kind === 'conclusion')
const label = computed(() => {
  const value = coordination.value
  if (!value) return '系统安排'
  if (value.kind === 'conclusion') return '结论 · 本轮结束'
  if (value.kind === 'plan')
    return `计划 · ${value.tasks?.length ?? 0} 项顺序任务`
  return `安排 · ${value.speakers?.length ?? 0} 位成员`
})
const names = computed(() => props.members.map((member) => member.name))
function nameOf(id: string): string {
  return props.members.find((member) => member.id === id)?.name ?? id
}
</script>

<template>
  <section
    v-if="coordination"
    class="coordination-card"
    data-kind="coordination"
    :data-coordination-kind="coordination.kind"
    data-group-row
    data-coordination-card
    aria-label="群聊系统协调"
  >
    <header class="coordination-head">
      <Check v-if="conclusion" :size="14" aria-hidden="true" />
      <GitBranch v-else :size="14" aria-hidden="true" />
      <b>{{ conclusion ? '群聊结论' : '群聊协调' }}</b>
      <span>{{ label }}</span>
    </header>
    <GroupMarkdown
      class="coordination-text"
      :content="message.text"
      :names="names"
    />
    <ol v-if="coordination.speakers?.length" class="coordination-steps">
      <li v-for="(speaker, index) in coordination.speakers" :key="speaker">
        <span class="step-number">{{ index + 1 }}</span>
        <span>{{ nameOf(speaker) }}</span>
      </li>
    </ol>
    <ol v-else-if="coordination.tasks?.length" class="coordination-steps tasks">
      <li v-for="(task, index) in coordination.tasks" :key="task.taskId">
        <span class="step-number">{{ index + 1 }}</span>
        <span>{{ task.title }}</span>
        <span class="task-owner">{{ nameOf(task.to) }}</span>
      </li>
    </ol>
    <p v-if="coordination.kind === 'plan'" class="coordination-boundary">
      按顺序执行；不包含后台依赖或自动成果集成。
    </p>
  </section>
</template>

<style scoped>
.coordination-card {
  width: 100%;
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.coordination-card[data-coordination-kind='conclusion'] {
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 0.5px rgb(var(--accent) / 0.3);
}

.coordination-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--text-link));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.coordination-head b {
  font-weight: var(--weight-semibold);
}

.coordination-head span {
  margin-left: auto;
  color: rgb(var(--text-3));
}

.coordination-text {
  margin-top: var(--space-1);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-s);
  overflow-wrap: anywhere;
}

.coordination-steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5) var(--space-3);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.coordination-steps li {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xs);
}

.step-number {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: var(--r-full);
  background: rgb(var(--surface-selected));
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}

.task-owner {
  color: rgb(var(--text-3));
}

.coordination-boundary {
  margin: var(--space-2) 0 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xs);
}

@media (max-width: 560px) {
  .coordination-head span {
    width: 100%;
    margin-left: var(--space-5);
  }
}
</style>
