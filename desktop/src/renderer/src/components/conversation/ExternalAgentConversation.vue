<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
// @ts-expect-error vue-virtual-scroller v2 beta has no declarations
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import {
  agentTitle,
  agentSourceLabel,
  agentPhaseLabel,
  type AgentView,
} from '@emperor/core/api'
import { invokeCore, onCoreEvent } from '../../api/backend'
import {
  getDelegation,
  interruptDelegation,
  type DelegationView,
} from '../../api/delegations'
import {
  createExternalHistoryFeed,
  type ExternalHistoryPage,
  type ExternalHistoryEntry,
} from './externalHistoryFeed'
import { provideDelegationLinks } from './delegationLinks'
import ConversationMarkdown from './parts/ConversationMarkdown.vue'
import ExternalAgentDetails from './environment/ExternalAgentDetails.vue'
import Button from '../ui/Button.vue'
import ProviderLogo from '../ui/ProviderLogo.vue'
const route = useRoute(),
  router = useRouter()
const rootId = computed(() => String(route.params.sessionId ?? ''))
const delegationId = computed(() => String(route.params.delegationId ?? ''))
const state = shallowRef<DelegationView | null>(null)
const agents = shallowRef<AgentView[]>([])
const page = shallowRef<ExternalHistoryPage>({
  entries: [],
  before: null,
  after: null,
  hasBefore: false,
  hasAfter: false,
})
const error = ref(''),
  loading = ref(true),
  olderLoading = ref(false),
  detailsRunId = ref<string | null>(null)
const stopping = ref<string | null>(null)
const requestedStops = new Map<string, string>()
const stopKey = (sessionId: string, id: string) => `${sessionId}:${id}`
const following = ref(true)
const scroller = ref<{ $el: HTMLElement; scrollToBottom: () => void } | null>(
  null,
)
const record = computed(() => state.value?.record)
const agent = computed(() =>
  agents.value.find((a) => a.id === delegationId.value),
)
const title = computed(
  () =>
    agent.value?.title ??
    (record.value
      ? agentTitle(record.value?.startSpec?.description, record.value.backend)
      : '子智能体'),
)
const run = computed(() =>
  record.value?.currentRunId
    ? state.value?.runs[record.value.currentRunId]
    : undefined,
)
const live = computed(() =>
  ['queued', 'preparing', 'running', 'waiting_input', 'cancelling'].includes(
    run.value?.phase ?? '',
  ),
)
const phase = computed(() =>
  stopping.value === run.value?.id || run.value?.phase === 'cancelling'
    ? '正在停止…'
    : agent.value
      ? agentPhaseLabel(agent.value.phase)
      : '正在读取…',
)
const { click, links } = provideDelegationLinks(() => ({
  sessionId: rootId.value,
  delegationId: delegationId.value,
}))
const ancestors = computed(() => {
  const chain: AgentView[] = [],
    seen = new Set([delegationId.value])
  let id = agent.value?.parentAgentId ?? record.value?.owner.parentAgentId
  while (id && id !== rootId.value && !seen.has(id)) {
    seen.add(id)
    const parent = agents.value.find((a) => a.id === id)
    if (!parent) break
    chain.unshift(parent)
    id = parent.parentAgentId
  }
  return chain
})
function location(id: string) {
  return id.startsWith('dlg-')
    ? {
        name: 'external-agent',
        params: { sessionId: rootId.value, delegationId: id },
      }
    : { name: 'chat', params: { sessionId: id } }
}
function parent() {
  void router.push(
    location(
      agent.value?.parentAgentId ??
        record.value?.owner.parentAgentId ??
        rootId.value,
    ),
  )
}
function root() {
  void router.push({ name: 'chat', params: { sessionId: rootId.value } })
}
// Join small text batches for normal prose/markdown, while keeping each rendered
// unit bounded and tools/questions in their durable position.
const runLabels: Record<string, string> = {
  queued: '等待调度',
  preparing: '正在准备',
  running: '运行中',
  waiting_input: '等待回答',
  cancelling: '正在停止',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  outcome_unknown: '结果待确认',
}
function runLabel(status: string) {
  return runLabels[status] ?? '结果待确认'
}
const rows = computed(() => {
  const result: (
    | ExternalHistoryEntry
    | { id: string; runId: string; type: 'run'; text: string }
  )[] = []
  let previousRun = ''
  for (const entry of page.value.entries) {
    if (entry.runId !== previousRun) {
      result.push({
        id: entry.runId + ':heading',
        runId: entry.runId,
        type: 'run',
        text: `第 ${Math.max(1, Object.keys(state.value?.runs ?? {}).indexOf(entry.runId) + 1)} 轮`,
      })
      previousRun = entry.runId
    }
    const last = result.at(-1)
    if (
      entry.type === 'text' &&
      last?.type === 'text' &&
      last.runId === entry.runId &&
      (last.text?.length ?? 0) + (entry.text?.length ?? 0) <= 32768
    )
      last.text = (last.text ?? '') + (entry.text ?? '')
    else result.push({ ...entry })
  }
  return result
})
let feed: ReturnType<typeof createExternalHistoryFeed> | undefined,
  generation = 0
let activated = true
function disposeFeed() {
  generation++
  feed?.dispose()
  feed = undefined
}
function openFeed() {
  disposeFeed()
  if (
    !activated ||
    route.name !== 'external-agent' ||
    !rootId.value ||
    !delegationId.value
  )
    return
  const sessionId = rootId.value,
    id = delegationId.value
  const current = generation
  state.value = null
  agents.value = []
  page.value = {
    entries: [],
    before: null,
    after: null,
    hasBefore: false,
    hasAfter: false,
  }
  loading.value = true
  error.value = ''
  stopping.value = requestedStops.get(stopKey(sessionId, id)) ?? null
  following.value = true
  detailsRunId.value = null
  feed = createExternalHistoryFeed({
    subscribe: (changed) =>
      onCoreEvent((input) => {
        if (!input || typeof input !== 'object') return
        const e = input as Record<string, unknown>
        if (e.session_id !== sessionId && e.rootSessionId !== sessionId) return
        if (e.delegation_id === id || e.event === 'agent_tree_changed')
          changed()
      }),
    read: async (cursor) => {
      const [history, view, tree] = await Promise.all([
        invokeCore('delegations.history', { id, sessionId, ...cursor }),
        getDelegation({ id, sessionId }),
        invokeCore('agents.list', { rootSessionIds: [sessionId] }),
      ])
      if (current === generation) {
        state.value = view
        agents.value = tree.agents
        if (
          stopping.value &&
          (view.record?.currentRunId !== stopping.value ||
            ![
              'queued',
              'preparing',
              'running',
              'waiting_input',
              'cancelling',
            ].includes(view.runs[stopping.value]?.phase ?? ''))
        ) {
          requestedStops.delete(stopKey(sessionId, id))
          stopping.value = null
        }
      }
      return history
    },
    update: (value) => {
      if (current !== generation) return
      const follow = following.value
      const contentChanged = page.value.entries.length !== value.entries.length
      page.value = value
      loading.value = false
      error.value = ''
      if (contentChanged && !live.value) links.refresh()
      if (follow)
        void nextTick(() => {
          if (current === generation) scroller.value?.scrollToBottom()
        })
    },
    error: (cause) => {
      if (current === generation) {
        error.value = String(cause)
        loading.value = false
      }
    },
  })
  void feed.start()
}
watch([rootId, delegationId, () => route.name], openFeed, { immediate: true })
onActivated(() => {
  activated = true
  if (!feed) openFeed()
})
onDeactivated(() => {
  activated = false
  disposeFeed()
})
onBeforeUnmount(disposeFeed)
function scroll(event: Event) {
  const el = event.target as HTMLElement
  following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
}
async function older() {
  if (olderLoading.value) return
  olderLoading.value = true
  following.value = false
  const el = scroller.value?.$el,
    height = el?.scrollHeight ?? 0,
    top = el?.scrollTop ?? 0
  try {
    await feed?.older()
    await nextTick()
    if (el) el.scrollTop = top + el.scrollHeight - height
  } finally {
    olderLoading.value = false
  }
}
async function stop() {
  const runId = run.value?.id,
    sessionId = rootId.value,
    id = delegationId.value,
    current = generation
  if (!runId || !live.value || stopping.value) return
  stopping.value = runId
  requestedStops.set(stopKey(sessionId, id), runId)
  try {
    await interruptDelegation({ id, runId, sessionId })
    if (current === generation) await feed?.refresh()
  } catch (cause) {
    requestedStops.delete(stopKey(sessionId, id))
    if (rootId.value === sessionId && delegationId.value === id) {
      stopping.value = null
      error.value = String(cause)
    }
  }
}
</script>
<template>
  <section
    class="child-conversation"
    data-external-conversation
    @click.capture="click"
  >
    <header class="child-header">
      <nav aria-label="子智能体路径">
        <button @click="root">主会话</button
        ><template v-for="ancestor in ancestors" :key="ancestor.id"
          ><span>/</span
          ><button @click="router.push(location(ancestor.id))">
            {{ ancestor.title }}
          </button></template
        ><span>/ 子智能体</span>
      </nav>
      <div class="child-title">
        <h1>{{ title }}</h1>
        <ProviderLogo
          v-if="record"
          :icon-id="record.backend"
          :label="agentSourceLabel(record.backend)"
          size="xs"
        /><span v-if="record">{{ agentSourceLabel(record.backend) }}</span
        ><span role="status">{{ phase }}</span
        ><Button
          v-if="run"
          size="sm"
          variant="outline"
          @click="detailsRunId = run.id"
          >任务详情</Button
        >
      </div>
    </header>
    <p v-if="error" class="child-error" role="alert">
      {{ error }} <Button size="sm" @click="feed?.refresh()">重试</Button>
    </p>
    <p v-if="loading" class="child-note">正在读取子智能体对话…</p>
    <DynamicScroller
      ref="scroller"
      class="child-timeline"
      :items="rows"
      :min-item-size="48"
      key-field="id"
      @scroll.passive="scroll"
    >
      <template #before
        ><div v-if="page.hasBefore" class="child-more">
          <Button size="sm" :disabled="olderLoading" @click="older">{{
            olderLoading ? '正在读取…' : '加载更早记录'
          }}</Button>
        </div></template
      >
      <template #default="{ item, index, active }"
        ><DynamicScrollerItem
          :item="item"
          :active="active"
          :data-index="index"
          :size-dependencies="[item.text]"
        >
          <article
            class="child-entry"
            :data-entry-id="item.id"
            :data-entry-type="item.type"
          >
            <h2 v-if="item.type === 'run'" :title="item.runId">
              {{ item.text }}
              <Button
                size="sm"
                variant="outline"
                @click="detailsRunId = item.runId"
                >任务详情</Button
              >
            </h2>
            <template v-else
              ><p v-if="item.type !== 'text'" class="child-entry-label">
                {{
                  item.type === 'prompt'
                    ? '任务要求'
                    : item.type === 'question'
                      ? '等待回答'
                      : item.type === 'permission'
                        ? '权限请求'
                        : item.type === 'state'
                          ? `轮次结果 · ${runLabel(item.status)}`
                          : `${item.name || '工具'} · ${item.status}`
                }}<code v-if="item.toolId">{{ item.toolId }}</code>
              </p>
              <ConversationMarkdown v-if="item.text" :text="item.text"
            /></template>
          </article> </DynamicScrollerItem
      ></template>
      <template #after
        ><p v-if="!loading && !page.entries.length" class="child-note">
          尚无公开输出。
        </p></template
      >
    </DynamicScroller>
    <footer class="child-footer">
      <span>子智能体对话 · 只读</span
      ><Button size="sm" @click="parent">返回父智能体</Button
      ><Button size="sm" @click="root">{{
        run?.phase === 'waiting_input' ? '返回主会话回答' : '返回主会话继续派工'
      }}</Button
      ><Button
        v-if="live"
        data-stop-child
        size="sm"
        variant="danger"
        :disabled="!!stopping || run?.phase === 'cancelling'"
        @click="stop"
        >{{
          stopping || run?.phase === 'cancelling' ? '正在停止…' : '停止子智能体'
        }}</Button
      >
    </footer>
    <ExternalAgentDetails
      v-if="detailsRunId"
      :key="detailsRunId"
      :run-id="detailsRunId"
      :delegation-id="delegationId"
      :session-id="rootId"
      @close="detailsRunId = null"
      @configure="root"
      @root="root"
    />
  </section>
</template>
<style scoped>
.child-conversation {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: rgb(var(--label-primary));
}
.child-header {
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--border-l2);
}
.child-header nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: rgb(var(--label-tertiary));
  font: var(--font-code-small);
}
.child-header nav button {
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  cursor: pointer;
}
.child-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
h1 {
  margin: 0;
  flex: 1;
  font-size: var(--fs-md);
  font-weight: 600;
}
.child-title > span {
  color: rgb(var(--label-secondary));
  font: var(--font-code-small);
}
.child-timeline {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.child-entry {
  max-width: 748px;
  margin: auto;
  padding: var(--space-2) var(--space-5);
  overflow-wrap: anywhere;
}
.child-entry h2 {
  margin: var(--space-5) 0 var(--space-2);
  font: var(--font-code-small);
  color: rgb(var(--label-caption));
}
.child-entry-label {
  margin: var(--space-2) 0;
  color: rgb(var(--label-secondary));
  font: var(--font-code-small);
}
.child-entry-label code {
  margin-left: var(--space-2);
}
.child-entry[data-entry-type='prompt'] {
  background: rgb(var(--bg-layer-1));
  border-radius: var(--radius-card);
}
.child-footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--border-l2);
}
.child-footer > span {
  flex: 1;
  font: var(--font-code-small);
  color: rgb(var(--label-caption));
}
.child-note,
.child-more {
  padding: var(--space-4);
  text-align: center;
  color: rgb(var(--label-secondary));
}
.child-error {
  padding: var(--space-3);
  color: rgb(var(--state-error-label));
}
</style>
