<script setup lang="ts">
/**
 * 设置 › 用量与费用 › 按会话和群查看花费 (SET-01): the sessions that spent
 * most in the range — their own calls plus the scheduled turns and the
 * Claude Code / Codex runs they started — most first, with the mode each
 * belongs to. Groups appear here once group chat lands (GRP-08); a deleted
 * session keeps its spend under 「已删除的会话」.
 *
 * Props: usage (the section's state; the range is shared with the main page).
 * Emits: range(range) when another range is picked.
 */
import { computed, onMounted, ref } from 'vue'
import { core } from '../../../api/http'
import { EmptyState, Segmented, SettingsSection } from '../ui'
import {
  USAGE_RANGE_OPTIONS,
  sessionRows,
  type UsageRange,
} from './usageCostModel'
import type { UsageCost } from './useUsageCost'

const props = defineProps<{ usage: UsageCost }>()
const emit = defineEmits<{ range: [range: UsageRange] }>()
const titles = ref<Map<string, string>>(new Map())

const rows = computed(() =>
  props.usage.summary.value
    ? sessionRows(props.usage.summary.value, (id) => titles.value.get(id))
    : [],
)

onMounted(async () => {
  try {
    const sessions = await core('sessions.list', { includeArchived: true })
    titles.value = new Map(
      sessions.map((s) => [String(s.id), String(s.title || '未命名会话')]),
    )
  } catch {
    // Titles are a nicety: rows still show their spend.
  }
})
</script>

<template>
  <SettingsSection>
    <div class="sessions" data-testid="usage-sessions">
      <div class="toolbar">
        <Segmented
          :model-value="usage.range.value"
          @update:model-value="emit('range', $event as UsageRange)"
          :options="USAGE_RANGE_OPTIONS"
          aria-label="统计范围"
        />
      </div>
      <ol v-if="rows.length" class="list" aria-label="花费最多的会话">
        <li
          v-for="row in rows"
          :key="row.id"
          class="row"
          :data-deleted="row.deleted || undefined"
        >
          <span class="main">
            <strong :title="row.title">{{ row.title }}</strong>
            <small>{{ row.source }} · {{ row.tokens }} Token</small>
          </span>
          <span class="value">{{ row.value }}</span>
        </li>
      </ol>
      <EmptyState
        v-else-if="usage.summary.value"
        title="这段时间没有花费"
        description="会话、群里花的钱会按多少排在这里。"
        framed
      />
    </div>
  </SettingsSection>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.toolbar {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-1);
}

.list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: var(--radius-row);
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2-5) var(--space-3);
}

.row + .row {
  box-shadow: inset 0 0.5px 0 var(--hairline);
}

.main {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.main strong {
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row[data-deleted] strong {
  color: rgb(var(--text-3));
}

.main small {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
}

.value {
  flex: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
  font-variant-numeric: tabular-nums;
}
</style>
