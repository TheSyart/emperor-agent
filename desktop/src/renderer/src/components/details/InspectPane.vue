<script setup lang="ts">
/**
 * InspectPane — the details column's Inspect tab: the selected tool call of
 * a session, read from that session's raw-log conversation (the same
 * store the chat timeline uses, so a running call updates live).
 *
 * Header: tool icon, registry title · summary, state dot + label. Then the
 * Input (parsed arguments as a JSON tree, raw text otherwise), the Output
 * (JSON tree when the result text is JSON, plain text otherwise; tinted on
 * error), result meta, timing and ids. "在轨迹中查看" routes to the session's
 * trajectory with `?call=<callId>` so the ledger selects the same call.
 *
 * Props:
 * - selection: the inspected tool call ({ sessionId, callId }) or null.
 *
 * Slots:
 * - default ({ selection }): replaces the call view (e.g. the trajectory
 *   inspector); the empty state renders whenever selection is null.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionConversation } from '../../composables/useSessionConversation'
import { sessionLocation } from '../../router'
import { toolView } from '../conversation/tools/registry'
import { DsInspect } from '../icons/ds'
import Button from '../ui/Button.vue'
import JsonTree from '../ui/JsonTree.vue'
import StateDot from '../ui/StateDot.vue'
import type { StateDotState } from '../ui/stateDot'
import { findToolCall, inspectView } from './inspectModel'
import type { InspectSelection } from './inspectState'

const props = defineProps<{ selection: InspectSelection | null }>()
const router = useRouter()

const conversation = useSessionConversation(
  () => props.selection?.sessionId ?? '',
)
const call = computed(() =>
  findToolCall(
    conversation.value?.snapshot.value,
    props.selection?.callId ?? '',
  ),
)
const loading = computed(
  () =>
    call.value === null &&
    conversation.value?.window.value.openState !== 'open' &&
    conversation.value?.window.value.openState !== 'error',
)
const spec = computed(() =>
  call.value === null ? null : toolView(call.value.name),
)
const view = computed(() =>
  call.value === null ? null : inspectView(call.value),
)
const title = computed(() =>
  call.value && spec.value ? spec.value.title(call.value) : '',
)
const summary = computed(() =>
  call.value && spec.value ? spec.value.summary(call.value) : '',
)
const dotState = computed<StateDotState>(() => {
  switch (view.value?.state) {
    case 'running':
      return 'ongoing'
    case 'error':
      return 'error'
    case 'stopped':
      return 'warn'
    default:
      return 'ok'
  }
})
const inputIsTree = computed(
  () => typeof view.value?.input === 'object' && view.value.input !== null,
)
const outputIsTree = computed(
  () => typeof view.value?.output === 'object' && view.value.output !== null,
)
const hasMeta = computed(
  () => view.value?.meta !== undefined && Object.keys(view.value.meta).length,
)

function openTrajectory(): void {
  const selection = props.selection
  if (!selection) return
  void router
    .push({
      ...(sessionLocation(selection.sessionId, 'trajectory') as object),
      query: { call: selection.callId },
    })
    .catch(() => undefined)
}
</script>

<template>
  <div class="inspect-pane">
    <p v-if="!selection" class="inspect-empty">
      在对话或轨迹中选择一个工具调用以查看详情
    </p>
    <slot v-else :selection="selection">
      <p v-if="loading" class="inspect-empty" role="status">正在读取调用…</p>
      <p v-else-if="!call || !view || !spec" class="inspect-empty">
        当前会话记录中找不到这个调用（{{ selection.callId }}）
      </p>
      <template v-else>
        <header class="inspect-head" :data-state="view.state">
          <span class="head-icon"
            ><component :is="spec.icon" :size="16"
          /></span>
          <span class="head-text">
            <span class="head-title">{{ title }}</span>
            <span v-if="summary" class="head-summary">{{ summary }}</span>
          </span>
          <span class="head-state">
            <StateDot :state="dotState" :size="8" />
            {{ view.stateLabel }}
          </span>
        </header>
        <div class="head-meta">
          <code class="tool-name">{{ call.name }}</code>
          <Button size="sm" variant="outline" @click="openTrajectory">
            <template #icon><DsInspect :size="14" /></template>
            在轨迹中查看
          </Button>
        </div>

        <section class="inspect-section" aria-label="输入">
          <div class="inspect-label">
            输入
            <span v-if="view.inputTruncated" class="note">已截断</span>
          </div>
          <div class="block">
            <JsonTree
              v-if="inputIsTree"
              :value="view.input"
              :expand-depth="2"
            />
            <pre v-else class="text">{{ view.input || '（无参数）' }}</pre>
          </div>
        </section>

        <section class="inspect-section" aria-label="输出">
          <div class="inspect-label">
            输出
            <span v-if="view.outputTruncated" class="note">已截断</span>
          </div>
          <div class="block" :data-error="view.isError || undefined">
            <p v-if="view.output === undefined" class="pending">
              {{ view.state === 'running' ? '等待结果…' : '没有结果' }}
            </p>
            <JsonTree
              v-else-if="outputIsTree"
              :value="view.output"
              :expand-depth="1"
            />
            <pre v-else class="text">{{ view.output || '（空）' }}</pre>
          </div>
        </section>

        <section v-if="hasMeta" class="inspect-section" aria-label="元数据">
          <div class="inspect-label">元数据</div>
          <div class="block">
            <JsonTree :value="view.meta" :expand-depth="1" />
          </div>
        </section>

        <section class="inspect-section" aria-label="计时">
          <div class="inspect-label">计时</div>
          <dl class="inspect-facts">
            <template v-for="fact in view.timing" :key="fact.label">
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </template>
          </dl>
        </section>

        <section class="inspect-section" aria-label="标识">
          <div class="inspect-label">标识</div>
          <dl class="inspect-facts">
            <template v-for="fact in view.ids" :key="fact.label">
              <dt>{{ fact.label }}</dt>
              <dd :title="fact.value">{{ fact.value }}</dd>
            </template>
          </dl>
        </section>
      </template>
    </slot>
  </div>
</template>

<style scoped>
.inspect-pane {
  height: 100%;
  min-height: 0;
  padding: var(--space-3) var(--space-4) var(--space-6);
  overflow-y: auto;
}

.inspect-empty {
  margin: 0;
  padding: var(--space-2) 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  overflow-wrap: anywhere;
}

.inspect-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}

.head-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  color: rgb(var(--label-secondary));
}

.head-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.head-title {
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
}

.head-summary {
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-state {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--space-6);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.inspect-head[data-state='error'] .head-state {
  color: rgb(var(--danger));
}

.head-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: var(--space-2) 0 var(--space-4);
}

.tool-name {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspect-section {
  margin-bottom: var(--space-4);
}

.inspect-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1-5);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
}

.note {
  color: rgb(var(--label-caption));
  font-weight: 400;
}

.block {
  max-height: 360px;
  padding: var(--space-2) 0;
  overflow: auto;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
}

.block[data-error] {
  border-color: rgb(var(--danger) / 0.4);
}

.block[data-error] .text {
  color: rgb(var(--danger));
}

.text {
  margin: 0;
  padding: 0 var(--space-3);
  color: rgb(var(--label-secondary));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: pre-wrap;
  word-break: break-word;
}

.pending {
  margin: 0;
  padding: 0 var(--space-3);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.inspect-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.inspect-facts dt {
  color: rgb(var(--label-tertiary));
}

.inspect-facts dd {
  margin: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
