<script setup lang="ts">
/**
 * ToolCallRow — one 28px line `[icon] 标题 · 摘要` (UI-S03): icon 14 text-3,
 * title 13 text-2, summary 13 text-3; the icon crossfades to a chevron on
 * hover; running plays the glare sweep; error / interrupted swap the icon
 * for a Dot and an error row's summary is the failure's first line in the
 * danger color. The expanded body (indented 22px like a thinking body) is
 * the registry's tool view with a hover-revealed Inspect pill that jumps to
 * the trajectory — only while 显示轨迹 is on (UI-S09). A `preparing` row
 * (DSH-23) is the call the model is still writing: the arguments parsed so
 * far and 「准备中」, nothing to expand.
 *
 * Props: data (tool node data), agent?, preparing?. Emits via chat context:
 * inspect(callId).
 */
import { computed } from 'vue'
import { useUiPreferences } from '../../../composables/useUiPreferences'
import type { AgentView } from '@emperor/core/api'
import type { ToolChatData } from '../../../conversation/types'
import { DsInspect } from '../../icons/ds'
import DisclosureRow from '../../ui/DisclosureRow.vue'
import Dot from '../../ui/Dot.vue'
import Avatar from '../../ui/Avatar.vue'
import { useChatContext, useExpansion } from '../chatContext'
import { TOOL_BODIES } from '../tools/bodies'
import { toolView } from '../tools/registry'
import { argsOf, errorSummary, toolRowState } from '../tools/toolModel'

const props = withDefaults(
  defineProps<{ data: ToolChatData; agent?: AgentView; preparing?: boolean }>(),
  { agent: undefined, preparing: false },
)
const { actions } = useChatContext()
const { preferences } = useUiPreferences()

/** Bodies that only render result material (nothing to show while running). */
const RESULT_ONLY = new Set(['read', 'glob', 'grep', 'web', 'job', 'skill'])

const view = computed(() => toolView(props.data.name, props.data, props.agent))
const state = computed(() =>
  props.preparing ? 'preparing' : toolRowState(props.data),
)
const backend = computed(
  () => props.data.externalAgent?.backend ?? argsOf(props.data).backend,
)
const title = computed(() => view.value.title(props.data))
const failure = computed(() => errorSummary(props.data))
const summary = computed(() => failure.value ?? view.value.summary(props.data))
const suffix = computed(() =>
  failure.value === null ? (view.value.suffix?.(props.data) ?? null) : null,
)
const suffixTone = computed(() =>
  suffix.value === null ? null : (view.value.suffixTone?.(props.data) ?? null),
)
const expandable = computed(
  () =>
    !props.preparing &&
    !(props.data.status === 'running' && RESULT_ONLY.has(view.value.body)),
)
/** The trajectory holds the full arguments only when it is shown (UI-S09). */
const truncatedNote = computed(() =>
  preferences.value.showTrajectory
    ? '参数过长，已截断显示；在轨迹中查看完整内容'
    : '参数过长，已截断显示',
)
const open = useExpansion(
  () => `tool:${props.data.callId}`,
  () => props.data.name === 'exit_plan_mode',
)
const body = computed(() => TOOL_BODIES[view.value.body])
const stateLabel = computed(() => {
  switch (state.value) {
    case 'preparing':
      return '准备中'
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
    :data-preparing="preparing || undefined"
  >
    <span v-if="stateLabel && !preparing" class="sr-only">{{
      stateLabel
    }}</span>
    <DisclosureRow
      v-model:open="open"
      :title="title"
      :expandable="expandable"
      :running="state === 'running' || state === 'preparing'"
      :tone="failure !== null ? 'error' : 'default'"
    >
      <template #icon>
        <Avatar
          kind="sprite"
          v-if="!data.externalAgent && (data.subagent?.subagentId || agent?.id)"
          :id="data.subagent?.subagentId || agent!.id"
          :size="20"
        />
        <Dot v-else-if="state === 'error'" state="error" />
        <Dot v-else-if="state === 'stopped'" state="warn" />
        <Avatar
          kind="logo"
          v-else-if="
            (data.name === 'subagent' || data.name === 'subagent_fork') &&
            (backend === 'codex' || backend === 'claude-code')
          "
          :icon-id="backend"
          :label="backend === 'codex' ? 'Codex' : 'Claude Code'"
          :size="16"
          :data-agent-logo="backend"
        />
        <component :is="view.icon" v-else :size="14" />
      </template>
      <template v-if="summary" #summary>
        <span class="summary-line">
          <span
            class="summary-text"
            :data-path="(view.pathSummary && failure === null) || undefined"
            >{{ summary }}</span
          >
          <span
            v-if="suffix"
            class="summary-suffix"
            :data-tone="suffixTone || undefined"
            >{{ suffix }}</span
          >
        </span>
      </template>
      <template v-if="preparing" #trailing>
        <span class="preparing ds-shimmer" data-tone="neutral">准备中</span>
      </template>
      <div class="body-wrap">
        <div v-if="data.argsTruncated" class="truncated-note">
          {{ truncatedNote }}
        </div>
        <component :is="body" :data="data" />
        <button
          v-if="preferences.showTrajectory"
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

.summary-suffix[data-tone='warn'] {
  color: rgb(var(--warn));
  font-weight: 500;
}

.summary-suffix[data-tone='accent'] {
  color: rgb(var(--accent));
}

.body-wrap {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: var(--space-1) 0 var(--space-0-5);
  min-width: 0;
}

.truncated-note {
  margin-bottom: var(--space-1);
  font: var(--type-caption) var(--font-sans);
  color: rgb(var(--text-3));
}

.preparing {
  font: var(--type-caption) var(--font-sans);
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
  background: rgb(var(--surface-base));
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
  background: var(--surface-hover-solid);
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
