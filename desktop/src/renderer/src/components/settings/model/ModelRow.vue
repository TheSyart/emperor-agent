<script setup lang="ts">
/**
 * ModelRow — one saved model in its provider card (MOD-05): display name,
 * 「当前」, the model ID, what it can do, 「上下文 / 每次输出」 and the
 * thinking strength. 「测试」「编辑」 and the row's 「⋯」 (删除) show while
 * the row is hovered or holds focus. A retired or retiring model carries an
 * amber note and, when the catalog names one, 「替换为 X」. The editor opens
 * under the row (default slot).
 *
 * Props: entry, active, editing, highlight, testing, testSummary (the last
 * test of this session, or '').
 * Emits: test, edit, delete, replace(modelId).
 */
import { computed } from 'vue'
import type { ModelEntry } from '../../../types'
import Badge from '../../ui/Badge.vue'
import Button from '../../ui/Button.vue'
import { SettingsRowMenu } from '../ui'
import {
  CAPABILITY_ROWS,
  CAPABILITY_TAGS,
  modelEntryLabel,
} from './modelFormModel'
import { lifecycleNote, rowLimits } from './modelListModel'

const props = defineProps<{
  entry: ModelEntry
  active: boolean
  editing: boolean
  highlight: boolean
  testing: boolean
  testSummary: string
}>()
const emit = defineEmits<{
  test: []
  edit: []
  delete: []
  replace: [modelId: string]
}>()

const label = computed(() => modelEntryLabel(props.entry))
const tags = computed(() => {
  const profile = props.entry.resolvedProfile
  if (!profile) return []
  return CAPABILITY_ROWS.filter((row) => profile[row.key]).map(
    (row) => CAPABILITY_TAGS[row.key],
  )
})
const limits = computed(() => rowLimits(props.entry))
const thinking = computed(() =>
  props.entry.reasoningEffort ? `思考 ${props.entry.reasoningEffort}` : '',
)
const note = computed(() => lifecycleNote(props.entry))
</script>

<template>
  <li
    class="model-row"
    :class="{ editing }"
    :data-highlight="highlight || undefined"
    :data-entry-id="entry.entryId"
    data-editor-host
  >
    <div class="model-line">
      <div class="model-text">
        <span class="model-title">
          <span class="model-name">{{ label }}</span>
          <Badge v-if="active" tone="accent">当前</Badge>
          <Badge v-if="entry.credentialState === 'needs_reentry'" tone="warn">
            凭据需要重新输入
          </Badge>
        </span>
        <span class="model-meta">
          <code class="model-id">{{ entry.modelId }}</code>
          <Badge v-for="tag in tags" :key="tag">{{ tag }}</Badge>
          <span v-if="limits" class="limits">{{ limits }}</span>
          <span v-if="thinking" class="limits">{{ thinking }}</span>
          <span v-if="testSummary" class="test-result" role="status">{{
            testSummary
          }}</span>
        </span>
      </div>
      <div class="model-actions" :data-reveal="editing || testing || undefined">
        <Button
          size="sm"
          variant="ghost"
          :aria-label="`测试 ${label}`"
          :disabled="testing"
          @click="emit('test')"
        >
          {{ testing ? '测试中…' : '测试' }}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          :aria-label="`编辑 ${label}`"
          :aria-expanded="editing"
          @click="emit('edit')"
        >
          编辑
        </Button>
        <SettingsRowMenu
          :label="`${label} 的更多操作`"
          :items="[
            {
              id: 'delete',
              label: '删除',
              danger: true,
              onSelect: () => emit('delete'),
            },
          ]"
        />
      </div>
    </div>
    <div
      v-if="note"
      class="lifecycle"
      :data-lifecycle="note.status"
      role="note"
    >
      <span>{{ note.text }}</span>
      <Button
        v-if="note.replacement"
        size="sm"
        variant="secondary"
        @click="emit('replace', note.replacement)"
      >
        替换为 {{ note.replacement }}
      </Button>
    </div>
    <slot />
  </li>
</template>

<style scoped>
.model-row {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: var(--space-2-5) 0;
}

.model-row:first-child {
  padding-top: 0;
}

.model-row:last-child {
  padding-bottom: 0;
}

.model-row + .model-row {
  border-top: 1px solid var(--stroke-1);
}

.model-row[data-highlight] {
  border-radius: var(--r-sm);
  background: rgb(var(--accent) / 0.08);
  transition: background-color var(--motion-slow) var(--ease-standard);
}

.model-line {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.model-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.model-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.model-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--text-1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.model-id {
  font: var(--font-code-small);
  color: rgb(var(--text-2));
  overflow-wrap: anywhere;
}

.limits {
  font-variant-numeric: tabular-nums;
}

.test-result {
  color: rgb(var(--text-2));
}

/* 测试 / 编辑 / ⋯ show on hover or focus (and while busy or editing). */
.model-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--duration-ds-fast) ease;
}

.model-row:hover .model-actions,
.model-row:focus-within .model-actions,
.model-actions[data-reveal] {
  opacity: 1;
}

@media (hover: none) {
  .model-actions {
    opacity: 1;
  }
}

.lifecycle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  margin-top: var(--space-1-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
}
</style>
