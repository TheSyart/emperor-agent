<script setup lang="ts">
/**
 * ToolCallRow — dsh ToolRow: one 24px line `[icon] 标题 · 摘要`; the icon
 * crossfades to a chevron on hover; running plays the glare sweep; error /
 * interrupted swap the icon for a StateDot and an error row's summary is
 * the failure's first line in the danger color. The expanded body is the
 * registry's tool view (collapsed by default) with a hover-revealed
 * Inspect pill that jumps to the trajectory.
 *
 * Props: data (tool node data), nodeKey. Emits via chat context:
 * inspect(callId).
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import { DsInspect } from '../../icons/ds'
import DisclosureRow from '../../ui/DisclosureRow.vue'
import StateDot from '../../ui/StateDot.vue'
import { useChatContext, useExpansion } from '../chatContext'
import { TOOL_BODIES } from '../tools/bodies'
import { toolView } from '../tools/registry'
import { errorSummary, toolRowState } from '../tools/toolModel'

const props = defineProps<{ data: ToolChatData }>()
const { actions } = useChatContext()

/** Bodies that only render result material (nothing to show while running). */
const RESULT_ONLY = new Set(['read', 'glob', 'grep', 'web', 'job', 'skill'])

const view = computed(() => toolView(props.data.name))
const state = computed(() => toolRowState(props.data))
const title = computed(() => view.value.title(props.data))
const failure = computed(() => errorSummary(props.data))
const summary = computed(() => failure.value ?? view.value.summary(props.data))
const suffix = computed(() =>
  failure.value === null ? (view.value.suffix?.(props.data) ?? null) : null,
)
const expandable = computed(
  () => !(props.data.status === 'running' && RESULT_ONLY.has(view.value.body)),
)
const open = useExpansion(
  () => `tool:${props.data.callId}`,
  () => props.data.name === 'exit_plan_mode',
)
const body = computed(() => TOOL_BODIES[view.value.body])
const stateLabel = computed(() => {
  switch (state.value) {
    case 'running':
      return '运行中'
    case 'error':
      return '失败'
    case 'stopped':
      return '已中断'
    default:
      return ''
  }
})
</script>

<template>
  <div
    class="tool-row"
    :data-state="state"
    :data-tool="data.name"
    :data-call-id="data.callId"
  >
    <span v-if="stateLabel" class="sr-only">{{ stateLabel }}</span>
    <DisclosureRow
      v-model:open="open"
      :title="title"
      :expandable="expandable"
      :running="state === 'running'"
      :tone="failure !== null ? 'error' : 'default'"
    >
      <template #icon>
        <StateDot v-if="state === 'error'" state="error" />
        <StateDot v-else-if="state === 'stopped'" state="warn" />
        <component :is="view.icon" v-else :size="14" />
      </template>
      <template v-if="summary" #summary>
        <span class="summary-line">
          <span
            class="summary-text"
            :data-path="(view.pathSummary && failure === null) || undefined"
            >{{ summary }}</span
          >
          <span v-if="suffix" class="summary-suffix">{{ suffix }}</span>
        </span>
      </template>
      <div class="body-wrap">
        <div v-if="data.argsTruncated" class="truncated-note">
          参数过长，已截断显示；完整内容可在 Trajectory 中查看。
        </div>
        <component :is="body" :data="data" />
        <button
          type="button"
          class="inspect"
          @click="actions.inspect(data.callId)"
        >
          <DsInspect :size="12" />
          Inspect
        </button>
      </div>
    </DisclosureRow>
  </div>
</template>

<style scoped>
.tool-row {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tool-row :deep(.title) {
  color: rgb(var(--label-secondary));
}

.tool-row :deep(.body) {
  padding-left: 0;
}

.summary-line {
  display: flex;
  min-width: 0;
}

.summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-text[data-path] {
  color: rgb(var(--label-secondary));
  text-decoration: underline;
  text-decoration-color: rgb(var(--label-caption));
  text-underline-offset: 3px;
}

.summary-suffix {
  flex: none;
  margin-left: var(--space-1);
}

.body-wrap {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: var(--space-1) 0 var(--space-0-5) var(--space-1);
  min-width: 0;
}

.truncated-note {
  margin-bottom: var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--warn));
}

.inspect {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-1) 0 var(--space-0-5);
  padding: var(--space-0-5) var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  background: rgb(var(--bg-base));
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxxs);
  line-height: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--duration-ds-fast) ease;
}

.tool-row:hover .inspect,
.inspect:focus-visible {
  opacity: 1;
}

.inspect:hover {
  background: var(--interactive-bg-hover-solid);
  color: rgb(var(--label-primary));
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
