<script setup lang="ts">
/**
 * Hooks › 审计: hook runs of the current session as one list — filters
 * (event / outcome, applied on change) above expandable run cards (handler,
 * event · turn, outcome badge, duration); a card opens its details in place
 * (matcher, exit code, duration, invoked time, stderr). Cursor paging under
 * the list.
 */
import { computed } from 'vue'
import IconButton from '../../ui/IconButton.vue'
import { DsChevronLeft, DsChevronRight } from '../../icons/ds'
import {
  DefinitionList,
  EmptyState,
  Select,
  SettingsCard,
  SettingsGroup,
  StatusBadge,
  type DefinitionItem,
  type SelectOption,
} from '../ui'
import type { HookAuditRecordPayload } from '../../../types'
import { useHooksController } from './hooksController'
import { HOOK_AUDIT_OUTCOMES, hookOutcomeTone } from './hooksModel'

const {
  auditLoading,
  audit,
  events,
  auditEvent,
  auditOutcome,
  auditCursor,
  auditHistory,
  selectedAudit,
  nextAuditPage,
  previousAuditPage,
  toggleAudit,
} = useHooksController()

const eventOptions = computed<SelectOption[]>(() => [
  { value: '', label: '全部事件' },
  ...events.value.map((event) => ({
    value: event.eventName,
    label: event.eventName,
  })),
])

const outcomeOptions: SelectOption[] = [
  { value: '', label: '全部结果' },
  ...HOOK_AUDIT_OUTCOMES.map((value) => ({ value, label: value })),
]

const records = computed(() => audit.value?.records ?? [])
const paged = computed(
  () => Boolean(audit.value?.nextCursor) || auditHistory.value.length > 0,
)

function recordKey(record: HookAuditRecordPayload, index: number) {
  return `${record.handlerId}:${record.invokedAt}:${index}`
}

function auditTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function details(record: HookAuditRecordPayload): DefinitionItem[] {
  return [
    { term: 'Matcher', value: record.matcher || '*', mono: true },
    { term: 'Exit code', value: record.exitCode ?? '—', mono: true },
    {
      term: '耗时',
      value: record.durationMs === null ? '—' : `${record.durationMs}ms`,
      mono: true,
    },
    { term: '调用时间', value: auditTime(record.invokedAt) },
    { term: 'Dialect', value: record.dialect || '—' },
    { term: 'Stderr', value: record.stderrSummary || '—', mono: true },
  ]
}
</script>

<template>
  <div class="hooks-audit">
    <SettingsGroup
      title="运行记录"
      :description="`当前会话 · 共 ${audit?.total ?? 0} 条`"
      variant="stack"
      data-testid="hooks-audit"
    >
      <template #actions>
        <Select
          v-model="auditEvent"
          :options="eventOptions"
          size="sm"
          aria-label="事件筛选"
          data-testid="hooks-audit-event"
        />
        <Select
          v-model="auditOutcome"
          :options="outcomeOptions"
          size="sm"
          aria-label="结果筛选"
          data-testid="hooks-audit-outcome"
        />
      </template>

      <EmptyState
        v-if="!records.length"
        :title="auditLoading ? '加载运行记录中…' : '当前会话无 Hook 运行记录'"
        description="Hook 触发后，处理结果、退出码与耗时会记录在这里。"
        compact
      />
      <SettingsCard
        v-for="(record, index) in records"
        v-else
        :key="recordKey(record, index)"
        variant="outline"
        expandable
        :open="selectedAudit === record"
        :title="record.handlerId"
        :description="`${record.eventName} · turn ${record.turn}`"
        data-testid="hooks-audit-record"
        @update:open="toggleAudit(record, $event)"
      >
        <template #meta>
          <StatusBadge :tone="hookOutcomeTone(record.outcome)" dot>
            {{ record.outcome || 'none' }}
          </StatusBadge>
        </template>
        <template #actions>
          <code class="duration">{{ record.durationMs ?? '—' }}ms</code>
        </template>
        <DefinitionList :items="details(record)" />
      </SettingsCard>

      <div v-if="paged" class="pagination">
        <IconButton
          label="上一页"
          :disabled="auditLoading || !auditHistory.length"
          @click="previousAuditPage"
        >
          <DsChevronLeft :size="16" />
        </IconButton>
        <code class="cursor">{{ auditCursor || '0' }}</code>
        <IconButton
          label="下一页"
          :disabled="auditLoading || !audit?.nextCursor"
          @click="nextAuditPage"
        >
          <DsChevronRight :size="16" />
        </IconButton>
      </div>
    </SettingsGroup>
  </div>
</template>

<style scoped>
.hooks-audit {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.duration,
.cursor {
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
  white-space: nowrap;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.cursor {
  min-width: var(--space-6);
  text-align: center;
}
</style>
