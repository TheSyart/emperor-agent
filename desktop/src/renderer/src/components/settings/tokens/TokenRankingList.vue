<script setup lang="ts">
/**
 * TokenRankingList — the dsh token-usage ranking rows that replace wide
 * tables: rank, name + secondary line, a share bar, the right-aligned
 * figure and a details line (every column the old table had, wrapped
 * instead of scrolled). Shows the first `limit` rows with a 「显示全部」
 * toggle. Under a 440px section container the share bar folds away.
 *
 * Props:
 * - items: RankingItem[] ({ key, primary, secondary?, share (0..1), value,
 *   valueTitle?, detail? }).
 * - label: list name.
 * - limit (default 5; 0 = all).
 * - emptyText (default 「所选范围内没有用量。」).
 */
import { computed, ref, watch } from 'vue'
import type { RankingItem } from './tokenUsageModel'

const props = withDefaults(
  defineProps<{
    items: readonly RankingItem[]
    label: string
    limit?: number
    emptyText?: string
  }>(),
  { limit: 5, emptyText: '所选范围内没有用量。' },
)

const expanded = ref(false)
watch(
  () => props.items.length,
  () => {
    expanded.value = false
  },
)

const shown = computed(() =>
  props.limit > 0 && !expanded.value
    ? props.items.slice(0, props.limit)
    : props.items,
)
const collapsible = computed(
  () => props.limit > 0 && props.items.length > props.limit,
)
</script>

<template>
  <div class="token-ranking">
    <p v-if="!items.length" class="empty">{{ emptyText }}</p>
    <ol v-else class="rows" :aria-label="label">
      <li
        v-for="(item, index) in shown"
        :key="item.key"
        class="row"
        tabindex="0"
        :data-rank-key="item.key"
      >
        <span class="rank">{{ index + 1 }}</span>
        <span
          class="name"
          :title="
            item.secondary
              ? `${item.primary} · ${item.secondary}`
              : item.primary
          "
        >
          <strong>{{ item.primary }}</strong>
          <small v-if="item.secondary">{{ item.secondary }}</small>
        </span>
        <span class="bar" aria-hidden="true">
          <i
            :style="{ width: `${Math.max(0, Math.min(1, item.share)) * 100}%` }"
          />
        </span>
        <strong class="value" :title="item.valueTitle">{{ item.value }}</strong>
        <span v-if="item.detail" class="detail">{{ item.detail }}</span>
      </li>
    </ol>
    <button
      v-if="collapsible"
      type="button"
      class="expand"
      @click="expanded = !expanded"
    >
      {{ expanded ? `收起至前 ${limit} 个` : `显示全部 ${items.length} 个` }}
    </button>
  </div>
</template>

<style scoped>
.token-ranking {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: grid;
  grid-template-columns:
    var(--space-5) minmax(0, 1.4fr) minmax(64px, 0.7fr)
    minmax(56px, auto);
  align-items: center;
  gap: var(--space-0-5) var(--space-2);
  min-height: 42px;
  padding: var(--space-1-5) var(--space-2);
  border-bottom: 1px solid var(--border-l1);
  border-radius: var(--radius-xs);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  outline: none;
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--interactive-bg-hover);
}

.row:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

.rank {
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.name {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name strong,
.name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name strong {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.name small {
  margin-top: var(--space-0-5);
  font-size: var(--fs-xxxs);
  color: rgb(var(--label-tertiary));
}

.bar {
  height: var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--interactive-bg-hover);
}

.bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: rgb(var(--accent-fill));
}

.value {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 600;
  color: rgb(var(--label-primary));
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.detail {
  grid-column: 2 / -1;
  min-width: 0;
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.expand {
  align-self: center;
  min-height: var(--space-7);
  margin-top: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  background: transparent;
  font: inherit;
  font-size: var(--fs-xxs);
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.expand:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.expand:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.empty {
  margin: 0;
  padding: var(--space-4) 0;
  font-size: var(--fs-xxs);
  color: rgb(var(--label-tertiary));
  text-align: center;
}

@container (max-width: 439px) {
  .row {
    grid-template-columns: var(--space-5) minmax(0, 1fr) auto;
  }

  .bar {
    display: none;
  }
}
</style>
