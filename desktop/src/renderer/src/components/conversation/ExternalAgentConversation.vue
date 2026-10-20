<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onActivated,
  onDeactivated,
  ref,
  defineAsyncComponent,
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
  delegationNeedsExit,
  type AgentView,
} from '@emperor/core/runtime-contract'
import { invokeCore, onCoreEvent } from '../../api/backend'
import { useSession } from '../../composables/useSession'
import { useSessionConversation } from '../../composables/useSessionConversation'
import { EMPTY_CHAT_SNAPSHOT } from '../../conversation/chatSnapshot'
import { PictureInPicture2 } from 'lucide-vue-next'
import IconButton from '../ui/IconButton.vue'
const EnvironmentCard = defineAsyncComponent(
  () => import('./environment/EnvironmentCard.vue'),
)
import { agentAncestry } from './environment/environmentAgentsModel'
import {
  owningRootAvailability,
  externalConversationFailure,
  externalConversationMessages,
  type OwningRootAvailability,
  type ExternalConversationAvailability,
} from './externalConversationAvailability'
import {
  abandonDelegation,
  getDelegation,
  interruptDelegation,
  type DelegationView,
} from '../../api/delegations'
import {
  createExternalHistoryFeed,
  type ExternalHistoryPage,
} from './externalHistoryFeed'
import {
  externalTimelineRows,
  externalToolStatusLabel,
} from './externalTimelineModel'
import { provideDelegationLinks } from './delegationLinks'
import ConversationMarkdown from './parts/ConversationMarkdown.vue'
import ExternalAgentDetails from './environment/ExternalAgentDetails.vue'
import Button from '../ui/Button.vue'
import Avatar from '../ui/Avatar.vue'
const route = useRoute(),
  router = useRouter()
const rootId = computed(() => String(route.params.sessionId ?? ''))
const delegationId = computed(() => String(route.params.delegationId ?? ''))
const rootAvailability = ref<OwningRootAvailability>('loading')
const availability = ref<ExternalConversationAvailability>('loading')
const canOpenRoot = computed(() => rootAvailability.value === 'available')
const controlsAvailable = computed(
  () => canOpenRoot.value && availability.value === 'ready',
)
const sessions = useSession().sessions
// Retain the existing shared root window for truthful plan/source context.
// This is event-driven and never polls the root transcript.
const rootConversation = useSessionConversation(() =>
  canOpenRoot.value ? rootId.value : '',
)
const rootSnapshot = computed(
  () => rootConversation.value?.snapshot.value ?? EMPTY_CHAT_SNAPSHOT,
)
const infoOpen = ref(true)
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
/** The run ended without an outcome: offer 「标记为已结束」 (AGT-04). */
const needsExit = computed(() =>
  agent.value
    ? agent.value.needsExit === true
    : delegationNeedsExit(record.value, run.value),
)
const ending = ref(false)
const phase = computed(() =>
  availability.value !== 'ready'
    ? externalConversationMessages[availability.value]
    : stopping.value === run.value?.id || run.value?.phase === 'cancelling'
      ? '正在停止…'
      : agent.value
        ? agentPhaseLabel(agent.value.phase)
        : runLabel(run.value?.phase ?? ''),
)
const { click, links } = provideDelegationLinks(
  () => ({
    sessionId: rootId.value,
    delegationId: delegationId.value,
  }),
  () => controlsAvailable.value,
)
watch([() => run.value?.id, () => run.value?.phase], () => links.refresh())
const ancestry = computed(() => {
  const current =
    agent.value ??
    (record.value
      ? {
          id: record.value.id,
          rootSessionId: record.value.owner.rootSessionId,
          parentAgentId: record.value.owner.parentAgentId,
          title: title.value,
          backend: record.value.backend,
        }
      : undefined)
  return current
    ? agentAncestry(rootId.value, current, agents.value)
    : undefined
})
function location(id: string) {
  return id.startsWith('dlg-')
    ? {
        name: 'external-agent',
        params: { sessionId: rootId.value, delegationId: id },
      }
    : { name: 'chat', params: { sessionId: id } }
}
async function readRoot(sessionId: string, current: number) {
  const result = owningRootAvailability(
    sessionId,
    await invokeCore('sessions.list', { includeArchived: true }),
  )
  if (current === generation) {
    rootAvailability.value = result
    if (result !== 'available') detailsRunId.value = null
  }
  if (result === 'missing')
    throw Object.assign(new Error('Owning root missing'), {
      code: 'ROOT_NOT_FOUND',
    })
  return result
}
async function navigate(id: string) {
  if (!canOpenRoot.value) return
  const current = generation
  try {
    if (
      (await readRoot(rootId.value, current)) !== 'available' ||
      current !== generation
    )
      return
    void router.push(location(id))
  } catch (cause) {
    if (current === generation) fail(cause)
  }
}
function parent() {
  if (controlsAvailable.value && ancestry.value?.parentId)
    void navigate(ancestry.value.parentId)
}
function root() {
  void navigate(rootId.value)
}
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
const rows = computed(() =>
  externalTimelineRows(
    page.value.entries,
    Object.keys(state.value?.runs ?? {}),
  ),
)
let feed: ReturnType<typeof createExternalHistoryFeed> | undefined,
  generation = 0
let activated = true
let rootCheckTimer: ReturnType<typeof setInterval> | undefined
let rootVisibilityChanged: (() => void) | undefined
function disposeFeed() {
  if (rootVisibilityChanged)
    document.removeEventListener('visibilitychange', rootVisibilityChanged)
  rootVisibilityChanged = undefined
  clearInterval(rootCheckTimer)
  rootCheckTimer = undefined
  olderLoading.value = false
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
  rootAvailability.value = 'loading'
  availability.value = 'loading'
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
      await readRoot(sessionId, current)
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
      availability.value = 'ready'
      loading.value = false
      error.value = ''
      if (contentChanged && !live.value) links.refresh()
      if (follow)
        void nextTick(() => {
          if (current === generation) scroller.value?.scrollToBottom()
        })
    },
    error: (cause) => {
      if (current === generation) fail(cause)
    },
  })
  void feed.start()
  // Core has no archive/delete broadcast. Poll only inexpensive root metadata;
  // retained history is refreshed only after its availability actually changes.
  let checkingRoot = false
  const checkRoot = async () => {
    if (checkingRoot || current !== generation) return
    checkingRoot = true
    const previous = rootAvailability.value
    try {
      const next = await readRoot(sessionId, current)
      if (current === generation && next !== previous) void feed?.refresh()
    } catch (cause) {
      if (current === generation) {
        if (rootAvailability.value !== 'missing')
          rootAvailability.value = 'error'
        fail(cause)
      }
    } finally {
      checkingRoot = false
    }
  }
  rootVisibilityChanged = () => {
    clearInterval(rootCheckTimer)
    rootCheckTimer = undefined
    if (document.visibilityState === 'hidden') return
    refresh()
    rootCheckTimer = setInterval(checkRoot, 5000)
  }
  document.addEventListener('visibilitychange', rootVisibilityChanged)
  if (document.visibilityState !== 'hidden')
    rootCheckTimer = setInterval(checkRoot, 5000)
}
function fail(cause: unknown) {
  availability.value = externalConversationFailure(cause)
  loading.value = false
  error.value =
    availability.value === 'error' ? externalConversationMessages.error : ''
  detailsRunId.value = null
  if (rootAvailability.value === 'loading') rootAvailability.value = 'error'
}
function refresh() {
  if (activated) void feed?.refresh()
}
watch([rootId, delegationId, () => route.name], openFeed, { immediate: true })
// Local archive/delete changes are not delegation events. Re-read the typed
// root state when the sidebar list changes, and on focus after other windows.
watch(
  () => sessions.value.some((session) => session.id === rootId.value),
  refresh,
)
onMounted(() => window.addEventListener('focus', refresh))
onActivated(() => {
  activated = true
  if (!feed) openFeed()
})
onDeactivated(() => {
  activated = false
  disposeFeed()
})
onBeforeUnmount(() => {
  disposeFeed()
  window.removeEventListener('focus', refresh)
})
function scroll(event: Event) {
  const el = event.target as HTMLElement
  following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
}
async function older() {
  if (olderLoading.value) return
  const current = generation,
    originatingFeed = feed
  olderLoading.value = true
  following.value = false
  const el = scroller.value?.$el,
    height = el?.scrollHeight ?? 0,
    top = el?.scrollTop ?? 0
  try {
    await originatingFeed?.older()
    if (current !== generation || originatingFeed !== feed) return
    await nextTick()
    if (current !== generation || originatingFeed !== feed) return
    if (el && scroller.value?.$el === el)
      el.scrollTop = top + el.scrollHeight - height
  } finally {
    if (current === generation && originatingFeed === feed)
      olderLoading.value = false
  }
}
async function end() {
  const sessionId = rootId.value,
    id = delegationId.value,
    current = generation
  if (!controlsAvailable.value || !needsExit.value || ending.value) return
  ending.value = true
  error.value = ''
  try {
    await abandonDelegation({ id, sessionId })
    if (current === generation) await feed?.refresh()
  } catch (cause) {
    if (current === generation) error.value = String(cause)
  } finally {
    if (current === generation) ending.value = false
  }
}
async function stop() {
  const runId = run.value?.id,
    sessionId = rootId.value,
    id = delegationId.value,
    current = generation
  if (!controlsAvailable.value || !runId || !live.value || stopping.value)
    return
  stopping.value = runId
  requestedStops.set(stopKey(sessionId, id), runId)
  try {
    if (
      (await readRoot(sessionId, current)) !== 'available' ||
      current !== generation
    ) {
      requestedStops.delete(stopKey(sessionId, id))
      if (current === generation) stopping.value = null
      return
    }
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
    class="conversation-root child-conversation"
    :data-env-card="(infoOpen && controlsAvailable) || undefined"
    data-external-conversation
    @click.capture="click"
  >
    <header class="child-header">
      <nav aria-label="子智能体路径">
        <template v-if="ancestry && !ancestry.unavailable">
          <button v-if="controlsAvailable" @click="root">主会话</button
          ><span v-else>主会话</span>
          <template v-for="ancestor in ancestry.ancestors" :key="ancestor.id">
            <span>/</span
            ><button v-if="controlsAvailable" @click="navigate(ancestor.id)">
              {{ ancestor.title }}</button
            ><span v-else>{{ ancestor.title }}</span> </template
          ><span>/ 子智能体</span>
        </template>
        <span v-else-if="ancestry?.unavailable" data-unavailable-parent>{{
          ancestry.text
        }}</span>
        <span v-else>子智能体</span>
      </nav>
      <div class="child-title">
        <h1 :title="title" :aria-label="title">{{ title }}</h1>
        <Avatar
          kind="logo"
          v-if="record"
          :icon-id="record.backend"
          :label="agentSourceLabel(record.backend)"
          :size="16"
        /><span v-if="record">{{ agentSourceLabel(record.backend) }}</span
        ><span role="status">{{ phase }}</span
        ><IconButton
          v-if="controlsAvailable"
          label="环境信息"
          :active="infoOpen"
          :aria-pressed="infoOpen"
          @click="infoOpen = !infoOpen"
          ><PictureInPicture2 :size="16" /></IconButton
        ><Button
          v-if="run && controlsAvailable"
          size="sm"
          variant="secondary"
          @click="detailsRunId = run.id"
          >任务详情</Button
        >
      </div>
    </header>
    <div class="child-view-area">
      <EnvironmentCard
        v-if="infoOpen && controlsAvailable"
        :session-id="rootId"
        :root-session-id="rootId"
        :agents="agents"
        :snapshot="rootSnapshot"
        child
        @reveal="root"
        @close="infoOpen = false"
      />
      <p
        v-if="rootAvailability === 'archived'"
        class="child-note"
        data-root-archived
      >
        主会话已归档 ·
        可查看历史公开输出；继续派工、停止任务和本地文件访问不可用。
      </p>
      <p
        v-if="!loading && availability !== 'ready' && availability !== 'error'"
        class="child-note"
        role="alert"
      >
        {{ externalConversationMessages[availability] }}
      </p>
      <p v-if="error" class="child-error" role="alert">
        {{ error }} <Button size="sm" @click="feed?.refresh()">重试</Button>
      </p>
      <p v-if="loading" class="child-note">正在读取子智能体对话…</p>
      <div class="child-diagnostics">
        <p
          v-for="issue in availability === 'ready'
            ? (page.unavailable ?? [])
            : []"
          :key="issue.runId"
          class="child-note"
          role="alert"
        >
          {{ issue.runId }} ·
          {{
            issue.reason === 'missing_public_log'
              ? '公开记录缺失'
              : '公开记录损坏'
          }}。仅显示仍可读取的公开记录和已保留的任务状态。
        </p>
        <p
          v-if="
            availability === 'ready' &&
            (page.unavailableCount ?? 0) > (page.unavailable?.length ?? 0)
          "
          class="child-note"
        >
          共 {{ page.unavailableCount }} 轮公开记录不可用，以上列出前
          {{ page.unavailable?.length }} 轮。
        </p>
      </div>
      <DynamicScroller
        v-show="availability === 'ready'"
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
            :size-dependencies="[item.text, item.name, item.status]"
          >
            <article
              class="child-entry"
              :data-entry-id="item.id"
              :data-entry-type="item.type"
              :data-tool-id="item.toolId"
              :data-run-id="item.runId"
            >
              <h2 v-if="item.type === 'run'" :title="item.runId">
                {{ item.text }}
                <Button
                  v-if="controlsAvailable"
                  size="sm"
                  variant="secondary"
                  @click="detailsRunId = item.runId"
                  >任务详情</Button
                >
              </h2>
              <template v-else
                ><p
                  v-if="item.type !== 'text' && item.type !== 'tool-detail'"
                  class="child-entry-label"
                >
                  {{
                    item.type === 'prompt'
                      ? item.chronology === 'unknown'
                        ? '已接收补充要求 · 输出先后未知'
                        : item.status === 'accepted'
                          ? '补充要求 · 已接收'
                          : '任务要求'
                      : item.type === 'question'
                        ? '等待回答'
                        : item.type === 'permission'
                          ? '权限请求'
                          : item.type === 'state'
                            ? `轮次结果 · ${runLabel(item.status)}`
                            : `${item.name || '工具'} · ${externalToolStatusLabel(item.status)}`
                  }}
                </p>
                <ConversationMarkdown v-if="item.text" :text="item.text"
              /></template>
            </article> </DynamicScrollerItem
        ></template>
        <template #after
          ><p
            v-if="
              availability === 'ready' &&
              !page.entries.length &&
              !page.unavailable?.length
            "
            class="child-note"
          >
            尚无公开输出。
          </p></template
        >
      </DynamicScroller>
    </div>
    <footer class="child-footer">
      <span>子智能体对话 · 只读</span
      ><Button
        v-if="controlsAvailable && ancestry?.parentId"
        size="sm"
        @click="parent"
        >返回父智能体</Button
      ><Button v-if="canOpenRoot" size="sm" @click="root">{{
        availability !== 'ready'
          ? '返回主会话'
          : run?.phase === 'waiting_input'
            ? '返回主会话回答'
            : '返回主会话继续派工'
      }}</Button
      ><Button
        v-if="needsExit && controlsAvailable && !live"
        data-abandon-child
        size="sm"
        variant="secondary"
        title="这次运行没有正常结束（例如 Emperor 或电脑重启过）。标记为已结束会释放它占用的工作区，Goal 可以继续；保留的文件不受影响。"
        :disabled="ending"
        @click="end"
        >{{ ending ? '正在结束…' : '标记为已结束' }}</Button
      ><Button
        v-if="live && controlsAvailable"
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
      v-if="detailsRunId && controlsAvailable"
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
  container: conversation / inline-size;
  --env-card-width: min(340px, 42cqi);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: rgb(var(--text-1));
}
.child-view-area {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.child-conversation[data-env-card] .child-timeline {
  padding-inline-end: calc(var(--env-card-width) + var(--space-4));
}
.child-header {
  flex: none;
  min-width: 0;
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--stroke-2);
}
.child-header nav {
  display: flex;
  overflow: hidden;
  white-space: nowrap;
  gap: var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-code-small);
}
.child-header nav button {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 600;
}
.child-title > span {
  color: rgb(var(--text-2));
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
  color: rgb(var(--text-3));
}
.child-entry-label {
  margin: var(--space-2) 0;
  color: rgb(var(--text-2));
  font: var(--font-code-small);
}
.child-entry-label code {
  margin-left: var(--space-2);
}
.child-entry[data-entry-type='prompt'] {
  background: rgb(var(--surface-base));
  border-radius: var(--radius-card);
}
.child-footer {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--stroke-2);
}
.child-footer > span {
  flex: 1 0 auto;
  white-space: nowrap;
  font: var(--font-code-small);
  color: rgb(var(--text-3));
}
.child-note,
.child-more {
  padding: var(--space-4);
  text-align: center;
  color: rgb(var(--text-2));
}
.child-diagnostics {
  flex: none;
  max-height: 160px;
  overflow: auto;
}
.child-error {
  padding: var(--space-3);
  color: rgb(var(--state-error-label));
}
</style>
