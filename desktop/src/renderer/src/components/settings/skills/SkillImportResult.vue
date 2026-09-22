<script setup lang="ts">
/**
 * SkillImportResult — what a folder / zip / URL import did: a headline
 * StatusBadge, one row per imported Skill (name, scope, 已覆盖, warnings,
 * 「查看」 to open its detail) and one row per failure (name or folder, the
 * reason). Same-name conflicts carry a note; the dialog offers 「覆盖」.
 *
 * Props: summary (SkillImportSummary). Emits: select(name).
 */
import Button from '../../ui/Button.vue'
import { StatusBadge } from '../ui'
import SkillIssues from './SkillIssues.vue'
import type { SkillImportSummary } from './skillsModel'

defineProps<{ summary: SkillImportSummary }>()
const emit = defineEmits<{ select: [name: string] }>()
</script>

<template>
  <section
    class="import-result"
    aria-label="导入结果"
    data-testid="skill-import-result"
  >
    <StatusBadge :tone="summary.tone" dot class="headline">
      {{ summary.headline }}
    </StatusBadge>
    <ul v-if="summary.imported.length" class="rows" aria-label="已导入">
      <li
        v-for="entry in summary.imported"
        :key="`${entry.scope}:${entry.name}`"
        class="row"
      >
        <div class="row-head">
          <span class="name">{{ entry.name }}</span>
          <StatusBadge>{{ entry.scopeLabel }}</StatusBadge>
          <StatusBadge v-if="entry.replaced" tone="warn">已覆盖</StatusBadge>
          <Button
            size="sm"
            variant="ghost"
            class="open"
            @click="emit('select', entry.name)"
          >
            查看
          </Button>
        </div>
        <SkillIssues
          :warnings="entry.warnings"
          :label="`${entry.name} 的导入提示`"
        />
      </li>
    </ul>
    <ul v-if="summary.failures.length" class="rows" aria-label="未导入">
      <li
        v-for="(entry, index) in summary.failures"
        :key="`${entry.path}:${index}`"
        class="row"
      >
        <div class="row-head">
          <span class="name">{{ entry.name || entry.path }}</span>
          <StatusBadge :tone="entry.conflict ? 'warn' : 'error'">
            {{ entry.conflict ? '同名已存在' : '未导入' }}
          </StatusBadge>
        </div>
        <p v-if="entry.name && entry.path !== '.'" class="path">
          {{ entry.path }}
        </p>
        <SkillIssues :errors="[entry.reason]" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.import-result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2-5);
  min-width: 0;
}

.headline {
  white-space: normal;
}

.rows {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  list-style: none;
}

.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
}

.row + .row {
  border-top: 1px solid var(--border-l2);
}

.row-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.name {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.open {
  margin-left: auto;
}

.path {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}
</style>
