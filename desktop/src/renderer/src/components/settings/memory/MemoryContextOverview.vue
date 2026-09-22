<script setup lang="ts">
/**
 * MemoryContextOverview — the collapsed 「上下文概览」 card at the top of
 * Settings › 记忆: a one-line summary (mode · hot log · sources · versions)
 * that expands into the context / history log / semantic compaction /
 * runtime / maintenance facts. A 「需关注」 badge surfaces when a hot log
 * needs rotation, archiving is blocked or maintenance failed.
 *
 * Props: memory (MemoryPayload | null).
 */
import { computed, ref } from 'vue'
import { DefinitionList, SettingsCard, StatusBadge } from '../ui'
import { contextGroups, contextSummary } from './memoryModel'
import type { MemoryPayload } from '../../../types'

const props = defineProps<{ memory: MemoryPayload | null }>()

const open = ref(false)
const groups = computed(() => contextGroups(props.memory))
const summary = computed(() => contextSummary(props.memory))
const attention = computed(() => groups.value.some((group) => group.warn))
</script>

<template>
  <SettingsCard
    v-model:open="open"
    class="memory-context-overview"
    expandable
    title="上下文概览"
    :description="summary"
    :disabled="!groups.length"
  >
    <template #meta>
      <StatusBadge v-if="attention" tone="warn" dot>需关注</StatusBadge>
    </template>
    <div class="groups">
      <section
        v-for="group in groups"
        :key="group.key"
        class="group"
        :data-group="group.key"
      >
        <h4 class="group-title">
          {{ group.title }}
          <StatusBadge v-if="group.warn" tone="warn">需关注</StatusBadge>
        </h4>
        <DefinitionList :items="group.items" :label-width="64" />
      </section>
    </div>
  </SettingsCard>
</template>

<style scoped>
/* Context spans the card; the stats blocks pair up two per row. */
.groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-5);
  min-width: 0;
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.group[data-group='context'] {
  grid-column: 1 / -1;
}

@container (max-width: 479px) {
  .groups {
    grid-template-columns: minmax(0, 1fr);
  }
}

.group-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 600;
  color: rgb(var(--label-secondary));
}
</style>
