<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  Filter,
  FlaskConical,
  Play,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
} from 'lucide-vue-next'
import { core } from '../../api/http'
import type {
  EffectiveHookGroupPayload,
  HookAuditPayload,
  HookAuditRecordPayload,
  HookEventMetadataPayload,
  HooksMetadataPayload,
  HooksPayload,
} from '../../types'
import {
  auditQuery,
  cancellableRunIds,
  defaultDryRunInput,
  effectiveHookRows,
  hooksTrustTone,
  isStaleHooksError,
} from './hooksPanelModel'

type HooksTab = 'effective' | 'test' | 'audit' | 'advanced'
type Dict = Record<string, unknown>

interface HookMatchItem {
  index?: number
  eventName?: string
  groupId?: string
  handlerId?: string
  handlerType?: string
  source?: { id?: string; kind?: string; readonly?: boolean }
  failureMode?: string
}

interface HookMatchPayload {
  revision?: string
  eventName?: string
  items?: HookMatchItem[]
  diagnostics?: Array<{ code?: string; path?: string; message?: string }>
}

interface HookValidationPayload {
  valid?: boolean
  config?: Dict
  diagnostics?: Array<{ code?: string; path?: string; message?: string }>
}

const tabs: Array<{ key: HooksTab; label: string }> = [
  { key: 'effective', label: '有效配置' },
  { key: 'test', label: '测试' },
  { key: 'audit', label: '审计' },
  { key: 'advanced', label: 'Advanced' },
]

const activeTab = ref<HooksTab>('effective')
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const trusting = ref(false)
const error = ref('')
const stale = ref(false)
const payload = ref<HooksPayload | null>(null)
const metadata = ref<HooksMetadataPayload | null>(null)
const audit = ref<HookAuditPayload | null>(null)
const selectedRowKey = ref('')
const selectedEventName = ref('')
const testInputDraft = ref('{}')
const matchResult = ref<HookMatchPayload | null>(null)
const testResult = ref<Dict | null>(null)
const advancedDraft = ref('')
const advancedDirty = ref(false)
const validation = ref<HookValidationPayload | null>(null)
const auditEvent = ref('')
const auditOutcome = ref('')
const auditSource = ref('')
const auditCursor = ref<string | null>(null)
const auditHistory = ref<Array<string | null>>([])
const selectedAudit = ref<HookAuditRecordPayload | null>(null)
const cancelledRuns = ref<string[]>([])

const rows = computed(() => effectiveHookRows(payload.value))
const selectedRow = computed(
  () =>
    rows.value.find((row) => row.key === selectedRowKey.value) ??
    rows.value[0] ??
    null,
)
const selectedEffective = computed<EffectiveHookGroupPayload | null>(() => {
  const row = selectedRow.value
  if (!row) return null
  return (
    payload.value?.effectiveGroups?.find(
      (entry) =>
        entry.eventName === row.eventName &&
        entry.group?.id === row.groupId &&
        (entry.source?.id || entry.source?.kind) === row.sourceId,
    ) ?? null
  )
})
const events = computed(() => metadata.value?.events ?? [])
const selectedEvent = computed<HookEventMetadataPayload | null>(
  () =>
    events.value.find((event) => event.eventName === selectedEventName.value) ??
    null,
)
const projectTrust = computed(() => payload.value?.projectTrust ?? null)
const trustTone = computed(() => hooksTrustTone(projectTrust.value?.status))
const diagnostics = computed(() => payload.value?.diagnostics ?? [])
const sourceOptions = computed(() => payload.value?.sources ?? [])
const pendingTestRuns = computed(() =>
  cancellableRunIds(testResult.value).filter(
    (runId) => !cancelledRuns.value.includes(runId),
  ),
)

watch(
  selectedRow,
  (row) => {
    if (row && selectedRowKey.value !== row.key) selectedRowKey.value = row.key
  },
  { immediate: true },
)

watch(selectedEvent, (event) => {
  testInputDraft.value = defaultDryRunInput(event)
  matchResult.value = null
  testResult.value = null
})

onMounted(() => {
  void loadAll()
})

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [nextPayload, nextMetadata, nextAudit] = await Promise.all([
      core('hooks.getConfig'),
      core('hooks.getMetadata'),
      core('hooks.getAudit', { limit: 50 }),
    ])
    payload.value = nextPayload
    metadata.value = nextMetadata
    audit.value = nextAudit
    auditCursor.value = nextAudit.cursor ?? null
    auditHistory.value = []
    selectedEventName.value ||= nextMetadata.events?.[0]?.eventName ?? ''
    advancedDraft.value = JSON.stringify(
      nextPayload.globalConfig ?? { version: 2, hooks: {} },
      null,
      2,
    )
    advancedDirty.value = false
    validation.value = null
    stale.value = false
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function changeTrust(trusted: boolean) {
  const trust = projectTrust.value
  if (!trust?.canonicalRoot || !trust.digest) return
  if (trusted && !window.confirm(`信任项目 Hooks：${trust.canonicalRoot}？`))
    return
  trusting.value = true
  error.value = ''
  try {
    await core('hooks.setProjectTrust', {
      projectRoot: trust.canonicalRoot,
      expectedDigest: trust.digest,
      trusted,
    })
    await loadAll()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    trusting.value = false
  }
}

async function testMatch() {
  testing.value = true
  error.value = ''
  testResult.value = null
  try {
    matchResult.value = await core('hooks.testMatch', {
      revision: payload.value?.revision,
      eventName: selectedEventName.value,
      input: parseObject(testInputDraft.value),
    })
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    testing.value = false
  }
}

async function executeMatch(item: HookMatchItem) {
  if (!item.groupId || !item.handlerId) return
  if (!window.confirm(`执行 ${item.groupId} / ${item.handlerId}？`)) return
  testing.value = true
  error.value = ''
  try {
    testResult.value = await core('hooks.testRun', {
      revision: payload.value?.revision,
      eventName: selectedEventName.value,
      groupId: item.groupId,
      handlerId: item.handlerId,
      confirmExecution: true,
      input: parseObject(testInputDraft.value),
    })
    cancelledRuns.value = []
    await loadAudit(null, false)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    testing.value = false
  }
}

async function cancelTestRun(runId: string) {
  testing.value = true
  error.value = ''
  try {
    const result = await core('hooks.cancelRun', {
      runId,
    })
    if (!result.cancelled) throw new Error(`Hook run 不存在或已结束：${runId}`)
    cancelledRuns.value = [...cancelledRuns.value, runId]
    await loadAudit(null, false)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    testing.value = false
  }
}

async function validateAdvanced(): Promise<HookValidationPayload | null> {
  error.value = ''
  try {
    validation.value = await core('hooks.validateConfig', {
      sourceKind: 'global',
      config: parseObject(advancedDraft.value),
    })
    return validation.value
  } catch (cause) {
    validation.value = null
    error.value = messageOf(cause)
    return null
  }
}

async function saveAdvanced() {
  saving.value = true
  error.value = ''
  stale.value = false
  try {
    const checked = await validateAdvanced()
    if (!checked?.valid || !checked.config) return
    const saved = await core('hooks.saveConfig', {
      revision: payload.value?.revision,
      config: checked.config,
    })
    if (saved.saved === false)
      throw new Error(saved.decision?.reason || 'Hooks 配置未保存')
    payload.value = saved
    advancedDraft.value = JSON.stringify(
      saved.globalConfig ?? checked.config,
      null,
      2,
    )
    advancedDirty.value = false
    validation.value = null
  } catch (cause) {
    stale.value = isStaleHooksError(cause)
    error.value = messageOf(cause)
  } finally {
    saving.value = false
  }
}

async function loadAudit(cursor: string | null = null, remember = false) {
  loading.value = true
  error.value = ''
  try {
    if (remember) auditHistory.value.push(auditCursor.value)
    const next = await core(
      'hooks.getAudit',
      auditQuery({
        eventName: auditEvent.value,
        outcome: auditOutcome.value,
        sourceId: auditSource.value,
        cursor,
      }),
    )
    audit.value = next
    auditCursor.value = next.cursor ?? cursor
    selectedAudit.value = next.records?.[0] ?? null
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function nextAuditPage() {
  if (audit.value?.nextCursor) await loadAudit(audit.value.nextCursor, true)
}

async function previousAuditPage() {
  const previous = auditHistory.value.pop()
  await loadAudit(previous ?? null, false)
}

function onAdvancedInput() {
  advancedDirty.value = true
  validation.value = null
  stale.value = false
}

function parseObject(raw: string): Dict {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('输入必须是 JSON object')
  return parsed as Dict
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function sourceStatus(source: {
  active?: boolean
  blockedReason?: string | null
}): string {
  if (source.blockedReason === 'project_untrusted') return '项目未信任'
  if (source.blockedReason) return source.blockedReason
  return source.active === false ? '已停用' : '已启用'
}
</script>

<template>
  <section class="main-view view-readable hooks-panel">
    <header class="view-head hooks-head">
      <div class="hooks-title min-w-0">
        <div>
          <h1>Hooks</h1>
          <p>管理事件处理、项目信任与运行审计</p>
        </div>
        <code v-if="payload?.revision" :title="payload.revision"
          >rev {{ payload.revision.slice(0, 8) }}</code
        >
      </div>
      <button
        class="tool-button"
        title="刷新 Hooks"
        :disabled="loading"
        @click="loadAll"
      >
        <RefreshCw :size="16" />
      </button>
    </header>

    <div class="view-body hooks-body">
      <div class="hooks-content">
        <div class="hooks-topbar">
          <div
            class="segmented-control hooks-tabs"
            role="tablist"
            aria-label="Hooks views"
          >
            <button
              v-for="tab in tabs"
              :key="tab.key"
              :class="{ active: activeTab === tab.key }"
              role="tab"
              :aria-selected="activeTab === tab.key"
              @click="activeTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </div>
        </div>

        <div v-if="error" class="hooks-banner error-banner">
          <AlertTriangle :size="16" />
          <span>{{ error }}</span>
          <button v-if="stale" class="text-command" @click="loadAll">
            重新加载
          </button>
        </div>

        <div v-if="loading && !payload" class="hooks-empty">加载中...</div>

        <template v-else-if="activeTab === 'effective'">
          <div class="hooks-summary-line" aria-label="Hooks status">
            <span
              ><Terminal :size="14" />
              {{ payload?.summary?.total ?? 0 }} handlers</span
            >
            <span
              ><FileSearch :size="14" />
              {{ payload?.sources?.length ?? 0 }} sources</span
            >
            <span
              ><AlertTriangle :size="14" />
              {{ diagnostics.length }} diagnostics</span
            >
          </div>

          <section v-if="projectTrust" class="hooks-section">
            <h2>项目 Hooks</h2>
            <div class="settings-row hooks-settings-row" :data-tone="trustTone">
              <component
                :is="
                  projectTrust.status === 'trusted' ? ShieldCheck : ShieldAlert
                "
                :size="18"
              />
              <div>
                <strong>{{
                  projectTrust.status === 'trusted'
                    ? '已信任项目 Hooks'
                    : projectTrust.status === 'stale'
                      ? '项目配置已变更'
                      : '项目 Hooks 未信任'
                }}</strong>
                <span>{{ projectTrust.canonicalRoot }}</span>
              </div>
              <button
                v-if="projectTrust.status !== 'trusted'"
                class="tool-button asset-button"
                :disabled="trusting"
                @click="changeTrust(true)"
              >
                <ShieldCheck :size="15" />
                <span>信任</span>
              </button>
              <button
                v-else
                class="tool-button asset-button"
                :disabled="trusting"
                @click="changeTrust(false)"
              >
                <ShieldAlert :size="15" />
                <span>撤销信任</span>
              </button>
            </div>
          </section>

          <section class="hooks-section">
            <h2>配置来源</h2>
            <div v-if="!sourceOptions.length" class="hooks-empty compact">
              无配置来源
            </div>
            <div v-else class="hooks-settings-list">
              <div
                v-for="source in sourceOptions"
                :key="source.id || source.path"
                class="settings-row hooks-source-row"
              >
                <FileSearch :size="17" />
                <div>
                  <strong
                    >{{ source.kind }}
                    <small v-if="source.readonly">read-only</small></strong
                  >
                  <span :title="source.path">{{ source.path }}</span>
                </div>
                <span
                  class="state-label"
                  :class="{ blocked: source.active === false }"
                  >{{ sourceStatus(source) }}</span
                >
              </div>
            </div>
          </section>

          <section v-if="diagnostics.length" class="hooks-section">
            <h2>诊断</h2>
            <div class="hooks-settings-list">
              <div
                v-for="(item, index) in diagnostics"
                :key="`${item.code}:${item.path}:${index}`"
                class="settings-row diagnostic-row"
              >
                <AlertTriangle :size="17" />
                <div>
                  <strong>{{ item.code }}</strong
                  ><span>{{ item.message }}</span>
                </div>
                <code>{{ item.path || 'config' }}</code>
              </div>
            </div>
          </section>

          <section class="hooks-section">
            <div class="hooks-section-title">
              <h2>有效 Groups</h2>
              <span>{{ rows.length }}</span>
            </div>
            <div class="effective-layout hooks-surface">
              <div class="effective-list">
                <div v-if="!rows.length" class="hooks-empty">无有效 hooks</div>
                <button
                  v-for="row in rows"
                  v-else
                  :key="row.key"
                  class="effective-row"
                  :class="{
                    selected: selectedRow?.key === row.key,
                    inactive: !row.active,
                  }"
                  @click="selectedRowKey = row.key"
                >
                  <div>
                    <strong>{{ row.groupId }}</strong>
                    <span>{{ row.eventName }} · {{ row.matcher }}</span>
                  </div>
                  <div class="row-meta">
                    <span>{{ row.handlerTypes.join(' / ') }}</span>
                    <code>{{ row.sourceKind }}</code>
                  </div>
                </button>
              </div>

              <aside v-if="selectedEffective" class="hooks-detail">
                <div class="detail-head">
                  <div>
                    <span>{{ selectedEffective.eventName }}</span>
                    <h3>{{ selectedEffective.group?.id }}</h3>
                  </div>
                  <span
                    class="state-label"
                    :class="{ blocked: !selectedRow?.active }"
                    >{{
                      selectedRow?.active
                        ? '已启用'
                        : selectedRow?.blockedReason || '已停用'
                    }}</span
                  >
                </div>
                <dl>
                  <div>
                    <dt>Matcher</dt>
                    <dd>
                      <code>{{ selectedEffective.group?.matcher || '*' }}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>If</dt>
                    <dd>
                      <code>{{ selectedEffective.group?.if || '-' }}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Failure</dt>
                    <dd>{{ selectedEffective.group?.failureMode }}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{{ selectedEffective.source?.kind }}</dd>
                  </div>
                  <div class="wide">
                    <dt>Path</dt>
                    <dd>
                      <code>{{ selectedEffective.source?.path }}</code>
                    </dd>
                  </div>
                </dl>
                <div class="handler-list">
                  <div
                    v-for="handler in selectedEffective.group?.handlers"
                    :key="handler.id"
                    class="handler-row"
                  >
                    <component
                      :is="
                        handler.type === 'command'
                          ? Terminal
                          : handler.type === 'http'
                            ? FileSearch
                            : Braces
                      "
                      :size="15"
                    />
                    <div>
                      <strong>{{ handler.id }}</strong
                      ><span
                        >{{ handler.type }} · {{ handler.timeoutMs }}ms</span
                      >
                    </div>
                    <span>{{
                      handler.enabled === false ? '已停用' : '已启用'
                    }}</span>
                  </div>
                </div>
              </aside>
            </div>
          </section>
        </template>

        <template v-else-if="activeTab === 'test'">
          <div class="test-layout">
            <section class="hooks-surface test-form">
              <div class="surface-head"><h2>Dry Run</h2></div>
              <label>
                <span>Event</span>
                <select v-model="selectedEventName">
                  <option
                    v-for="event in events"
                    :key="event.eventName"
                    :value="event.eventName"
                  >
                    {{ event.eventName }}
                  </option>
                </select>
              </label>
              <div v-if="selectedEvent" class="event-capabilities">
                <span>{{ selectedEvent.mode }}</span>
                <span>matcher: {{ selectedEvent.matcherField || 'none' }}</span>
                <span>{{ selectedEvent.allowedHandlers.join(' / ') }}</span>
              </div>
              <label class="json-field">
                <span>Input JSON</span>
                <textarea v-model="testInputDraft" spellcheck="false" />
              </label>
              <button
                class="tool-button ink asset-button primary-action"
                :disabled="testing || !selectedEventName"
                @click="testMatch"
              >
                <FlaskConical :size="16" />
                <span>匹配</span>
              </button>
            </section>

            <section class="hooks-surface match-results">
              <div class="surface-head">
                <h2>匹配结果</h2>
                <span>{{ matchResult?.items?.length ?? 0 }}</span>
              </div>
              <div v-if="!matchResult" class="hooks-empty">尚未运行</div>
              <div v-else-if="!matchResult.items?.length" class="hooks-empty">
                无匹配 handler
              </div>
              <div v-else class="match-list">
                <div
                  v-for="item in matchResult.items"
                  :key="`${item.groupId}:${item.handlerId}`"
                  class="match-row"
                >
                  <div>
                    <strong>{{ item.groupId }} / {{ item.handlerId }}</strong>
                    <span
                      >{{ item.handlerType }} · {{ item.source?.kind }} ·
                      failure {{ item.failureMode }}</span
                    >
                  </div>
                  <button
                    class="tool-button"
                    :title="`执行 ${item.handlerId}`"
                    :disabled="testing"
                    @click="executeMatch(item)"
                  >
                    <Play :size="16" />
                  </button>
                </div>
              </div>
              <div v-if="pendingTestRuns.length" class="async-runs">
                <div v-for="runId in pendingTestRuns" :key="runId">
                  <code>{{ runId }}</code>
                  <button
                    class="tool-button"
                    :title="`取消 ${runId}`"
                    :disabled="testing"
                    @click="cancelTestRun(runId)"
                  >
                    <Square :size="14" />
                  </button>
                </div>
              </div>
              <pre v-if="testResult" class="result-json">{{
                JSON.stringify(testResult, null, 2)
              }}</pre>
            </section>
          </div>
        </template>

        <template v-else-if="activeTab === 'audit'">
          <section class="audit-toolbar">
            <Filter :size="16" />
            <select v-model="auditEvent" title="事件筛选">
              <option value="">全部事件</option>
              <option
                v-for="event in events"
                :key="event.eventName"
                :value="event.eventName"
              >
                {{ event.eventName }}
              </option>
            </select>
            <select v-model="auditOutcome" title="结果筛选">
              <option value="">全部结果</option>
              <option value="deny">deny</option>
              <option value="ask">ask</option>
              <option value="allow">allow</option>
              <option value="passthrough">passthrough</option>
              <option value="none">none</option>
            </select>
            <select v-model="auditSource" title="来源筛选">
              <option value="">全部来源</option>
              <option
                v-for="source in sourceOptions"
                :key="source.id"
                :value="source.id"
              >
                {{ source.kind }} · {{ source.id }}
              </option>
            </select>
            <button
              class="tool-button"
              title="应用筛选"
              :disabled="loading"
              @click="loadAudit(null, false)"
            >
              <RefreshCw :size="16" />
            </button>
          </section>
          <div class="audit-layout hooks-surface">
            <section class="audit-list">
              <div class="surface-head">
                <h2>Runs</h2>
                <span>{{ audit?.total ?? 0 }}</span>
              </div>
              <div v-if="!audit?.records?.length" class="hooks-empty">
                无审计记录
              </div>
              <button
                v-for="record in audit?.records"
                v-else
                :key="record.hookRunId"
                class="audit-row"
                :class="{
                  selected: selectedAudit?.hookRunId === record.hookRunId,
                }"
                @click="selectedAudit = record"
              >
                <div>
                  <strong>{{ record.handlerId }}</strong>
                  <span>{{ record.eventName }} · {{ record.outcome }}</span>
                </div>
                <div>
                  <code>{{ record.durationMs }}ms</code
                  ><span>{{ record.source?.kind }}</span>
                </div>
              </button>
              <div class="pagination">
                <button
                  class="tool-button"
                  title="上一页"
                  :disabled="!auditHistory.length"
                  @click="previousAuditPage"
                >
                  <ChevronLeft :size="16" />
                </button>
                <code>{{ auditCursor || '0' }}</code>
                <button
                  class="tool-button"
                  title="下一页"
                  :disabled="!audit?.nextCursor"
                  @click="nextAuditPage"
                >
                  <ChevronRight :size="16" />
                </button>
              </div>
            </section>
            <aside class="hooks-detail audit-detail">
              <div v-if="!selectedAudit" class="hooks-empty">选择一条记录</div>
              <template v-else>
                <div class="detail-head">
                  <div>
                    <span>{{ selectedAudit.eventName }}</span>
                    <h3>{{ selectedAudit.handlerId }}</h3>
                  </div>
                  <span class="state-label">{{ selectedAudit.outcome }}</span>
                </div>
                <dl>
                  <div>
                    <dt>Run ID</dt>
                    <dd>
                      <code>{{ selectedAudit.hookRunId }}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Group</dt>
                    <dd>{{ selectedAudit.groupId }}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{{ selectedAudit.status }}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{{ selectedAudit.durationMs }}ms</dd>
                  </div>
                  <div class="wide">
                    <dt>Reason</dt>
                    <dd>{{ selectedAudit.reason || '-' }}</dd>
                  </div>
                  <div class="wide">
                    <dt>Input hash</dt>
                    <dd>
                      <code>{{ selectedAudit.inputHash }}</code>
                    </dd>
                  </div>
                  <div class="wide">
                    <dt>Output hash</dt>
                    <dd>
                      <code>{{ selectedAudit.outputHash || '-' }}</code>
                    </dd>
                  </div>
                </dl>
              </template>
            </aside>
          </div>
        </template>

        <template v-else>
          <div class="advanced-layout">
            <section class="hooks-surface advanced-editor">
              <div class="surface-head">
                <div>
                  <h2>Global hooks_config.json</h2>
                  <span v-if="advancedDirty">未保存</span>
                </div>
                <div class="advanced-actions">
                  <button
                    class="tool-button asset-button"
                    :disabled="saving"
                    @click="validateAdvanced"
                  >
                    <Check :size="16" /><span>校验</span>
                  </button>
                  <button
                    class="tool-button ink asset-button primary-action"
                    :disabled="saving || !advancedDirty"
                    @click="saveAdvanced"
                  >
                    <Save :size="16" /><span>保存</span>
                  </button>
                </div>
              </div>
              <textarea
                v-model="advancedDraft"
                spellcheck="false"
                @input="onAdvancedInput"
              />
            </section>
            <aside class="hooks-surface validation-panel">
              <div class="surface-head"><h2>Validation</h2></div>
              <div v-if="!validation" class="hooks-empty">尚未校验</div>
              <div v-else-if="validation.valid" class="validation-ok">
                <ShieldCheck :size="18" /><span>配置有效</span>
              </div>
              <div v-else class="validation-list">
                <div
                  v-for="(item, index) in validation.diagnostics"
                  :key="`${item.code}:${item.path}:${index}`"
                >
                  <code>{{ item.path || 'config' }}</code>
                  <span>{{ item.code }} · {{ item.message }}</span>
                </div>
              </div>
            </aside>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hooks-panel {
  overflow: hidden;
}
.hooks-head {
  min-height: 56px;
}
.hooks-title {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  min-width: 0;
}
.hooks-title code {
  color: rgb(var(--fg-muted));
  font-size: 0.72rem;
}
.hooks-tabs {
  display: flex;
  gap: 0.15rem;
  padding: 0 1.25rem;
  border-bottom: 1px solid rgb(var(--border) / 0.7);
  overflow-x: auto;
}
.hooks-tab {
  min-height: 39px;
  padding: 0 0.8rem;
  color: rgb(var(--fg-muted));
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  font-size: 0.82rem;
}
.hooks-tab:hover {
  color: rgb(var(--fg));
}
.hooks-tab.active {
  color: rgb(var(--fg));
  border-bottom-color: rgb(var(--accent));
  font-weight: 700;
}
.hooks-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: auto;
  padding-bottom: 1.25rem;
}
.hooks-banner {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin: 0.75rem 1.25rem 0;
  padding: 0.65rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8rem;
}
.hooks-banner span {
  flex: 1;
  overflow-wrap: anywhere;
}
.error-banner {
  border: 1px solid rgb(var(--accent) / 0.35);
  background: rgb(var(--accent) / 0.08);
  color: rgb(var(--accent));
}
.text-command {
  text-decoration: underline;
  font-weight: 700;
}
.hooks-status-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-block: 1px solid rgb(var(--border) / 0.65);
}
.hooks-status-strip > div {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.55rem;
  min-height: 54px;
  padding: 0 1rem;
  border-left: 1px solid rgb(var(--border) / 0.55);
}
.hooks-status-strip > div:first-child {
  border-left: 0;
}
.hooks-status-strip span {
  color: rgb(var(--fg-muted));
  font-size: 0.78rem;
}
.hooks-status-strip strong {
  font: 800 1rem var(--font-display);
}
.trust-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-block: 1px solid rgb(var(--border) / 0.6);
}
.trust-bar[data-tone='ok'] {
  background: rgb(var(--success) / 0.06);
}
.trust-bar[data-tone='warn'],
.trust-bar[data-tone='error'] {
  background: rgb(var(--accent) / 0.07);
}
.trust-bar strong,
.trust-bar span {
  display: block;
}
.trust-bar span {
  color: rgb(var(--fg-muted));
  font-size: 0.72rem;
  overflow-wrap: anywhere;
  margin-top: 0.15rem;
}
.hooks-band {
  min-width: 0;
  border-block: 1px solid rgb(var(--border) / 0.65);
  background: rgb(var(--bg) / 0.38);
}
.band-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 42px;
  padding: 0 1rem;
  border-bottom: 1px solid rgb(var(--border) / 0.52);
}
.band-head h2 {
  font: 800 0.86rem var(--font-display);
}
.band-head span {
  color: rgb(var(--fg-muted));
  font-size: 0.72rem;
}
.source-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.source-item {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem;
  min-height: 40px;
  padding: 0 1rem;
  border-top: 1px solid rgb(var(--border) / 0.35);
}
.source-item:nth-child(-n + 2) {
  border-top: 0;
}
.source-kind {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-weight: 700;
  font-size: 0.75rem;
}
.source-kind small {
  color: rgb(var(--fg-muted));
  font: 0.62rem var(--font-mono);
}
.source-item code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--fg-muted));
  font-size: 0.7rem;
}
.state-label {
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid rgb(var(--border) / 0.7);
  border-radius: 4px;
  padding: 0.18rem 0.38rem;
  font: 700 0.65rem var(--font-mono);
  color: rgb(var(--success));
}
.state-label.blocked {
  color: rgb(var(--accent));
}
.diagnostic-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.35fr) minmax(0, 1fr);
  gap: 0.8rem;
  padding: 0.65rem 1rem;
  border-top: 1px solid rgb(var(--border) / 0.35);
  font-size: 0.76rem;
}
.diagnostic-row:first-of-type {
  border-top: 0;
}
.diagnostic-row code,
.diagnostic-row span {
  overflow-wrap: anywhere;
}
.effective-layout,
.audit-layout {
  display: grid;
  grid-template-columns: minmax(300px, 0.9fr) minmax(320px, 1.1fr);
  gap: 1rem;
  min-height: 360px;
}
.effective-row,
.audit-row {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.8rem;
  min-height: 56px;
  padding: 0.6rem 1rem;
  text-align: left;
  border-top: 1px solid rgb(var(--border) / 0.38);
}
.effective-row:first-of-type,
.audit-row:first-of-type {
  border-top: 0;
}
.effective-row:hover,
.audit-row:hover,
.effective-row.selected,
.audit-row.selected {
  background: rgb(var(--fg) / 0.045);
}
.effective-row.selected,
.audit-row.selected {
  box-shadow: inset 3px 0 0 rgb(var(--accent));
}
.effective-row.inactive {
  opacity: 0.62;
}
.effective-row strong,
.effective-row span,
.audit-row strong,
.audit-row span {
  display: block;
}
.effective-row strong,
.audit-row strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.79rem;
}
.effective-row span,
.audit-row span {
  color: rgb(var(--fg-muted));
  font-size: 0.7rem;
  margin-top: 0.18rem;
}
.row-meta {
  text-align: right;
}
.row-meta code {
  font-size: 0.68rem;
}
.hooks-detail {
  min-width: 0;
  border-left: 1px solid rgb(var(--border) / 0.65);
  padding-left: 1rem;
}
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.65rem 0 0.85rem;
  border-bottom: 1px solid rgb(var(--border) / 0.55);
}
.detail-head span {
  color: rgb(var(--fg-muted));
  font-size: 0.7rem;
}
.detail-head h2 {
  font: 800 1rem var(--font-display);
  margin-top: 0.15rem;
  overflow-wrap: anywhere;
}
.hooks-detail dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
}
.hooks-detail dl > div {
  min-width: 0;
  padding: 0.65rem 0.75rem 0.65rem 0;
  border-bottom: 1px solid rgb(var(--border) / 0.35);
}
.hooks-detail dl > div.wide {
  grid-column: 1 / -1;
}
.hooks-detail dt {
  color: rgb(var(--fg-muted));
  font-size: 0.66rem;
  text-transform: uppercase;
}
.hooks-detail dd {
  margin: 0.2rem 0 0;
  font-size: 0.76rem;
  overflow-wrap: anywhere;
}
.hooks-detail dd code {
  word-break: break-all;
}
.handler-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid rgb(var(--border) / 0.35);
}
.handler-row strong,
.handler-row span {
  display: block;
}
.handler-row strong {
  font-size: 0.76rem;
}
.handler-row span {
  color: rgb(var(--fg-muted));
  font-size: 0.68rem;
}
.test-layout,
.advanced-layout {
  display: grid;
  grid-template-columns: minmax(320px, 0.8fr) minmax(360px, 1.2fr);
  gap: 1rem;
  min-height: 480px;
}
.test-form {
  display: flex;
  flex-direction: column;
}
.test-form label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem 1rem 0;
  font-size: 0.72rem;
  color: rgb(var(--fg-muted));
}
.test-form select,
.audit-toolbar select {
  min-height: 34px;
  border: 1px solid rgb(var(--border) / 0.8);
  border-radius: 6px;
  background: rgb(var(--bg));
  padding: 0 0.55rem;
  color: rgb(var(--fg));
}
.json-field {
  flex: 1;
}
.json-field textarea,
.advanced-editor textarea {
  width: 100%;
  flex: 1;
  resize: none;
  border: 0;
  border-top: 1px solid rgb(var(--border) / 0.45);
  background: rgb(var(--paper2) / 0.35);
  padding: 0.8rem;
  font: 0.75rem/1.55 var(--font-mono);
  color: rgb(var(--fg));
}
.json-field textarea {
  min-height: 230px;
  border: 1px solid rgb(var(--border) / 0.65);
  border-radius: 6px;
}
.test-form > button {
  align-self: flex-end;
  margin: 0.75rem 1rem;
}
.event-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.65rem 1rem 0;
}
.event-capabilities span {
  border: 1px solid rgb(var(--border) / 0.65);
  border-radius: 4px;
  padding: 0.2rem 0.38rem;
  font-size: 0.66rem;
  color: rgb(var(--fg-muted));
}
.match-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.7rem;
  min-height: 58px;
  padding: 0.65rem 1rem;
  border-top: 1px solid rgb(var(--border) / 0.35);
}
.match-row:first-child {
  border-top: 0;
}
.match-row strong,
.match-row span {
  display: block;
}
.match-row strong {
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}
.match-row span {
  color: rgb(var(--fg-muted));
  font-size: 0.7rem;
  margin-top: 0.18rem;
}
.result-json {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 0.8rem 1rem;
  border-top: 1px solid rgb(var(--border) / 0.55);
  background: rgb(var(--paper2) / 0.4);
  font-size: 0.7rem;
}
.async-runs > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem;
  min-height: 38px;
  padding: 0 0.75rem 0 1rem;
  border-top: 1px solid rgb(var(--border) / 0.45);
}
.async-runs code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.68rem;
}
.audit-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0 0.25rem;
}
.audit-toolbar select {
  min-width: 140px;
}
.audit-row > div:last-child {
  text-align: right;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.45rem;
  min-height: 44px;
  padding: 0 0.75rem;
  border-top: 1px solid rgb(var(--border) / 0.5);
}
.pagination code {
  min-width: 2rem;
  text-align: center;
  font-size: 0.68rem;
}
.audit-detail {
  padding-right: 1rem;
}
.advanced-editor {
  display: flex;
  flex-direction: column;
  min-height: 480px;
}
.advanced-editor .band-head > div {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
}
.advanced-actions {
  align-items: center !important;
}
.advanced-editor textarea {
  min-height: 420px;
}
.validation-ok {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 1rem;
  color: rgb(var(--success));
  font-weight: 700;
}
.validation-list > div {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.7rem 1rem;
  border-top: 1px solid rgb(var(--border) / 0.35);
  font-size: 0.73rem;
}
.validation-list code,
.validation-list span {
  overflow-wrap: anywhere;
}
.hooks-empty {
  display: grid;
  place-items: center;
  min-height: 100px;
  color: rgb(var(--fg-muted));
  font-size: 0.78rem;
}

@media (max-width: 980px) {
  .effective-layout,
  .audit-layout,
  .test-layout,
  .advanced-layout {
    grid-template-columns: 1fr;
  }
  .hooks-detail {
    border-left: 0;
    border-top: 1px solid rgb(var(--border) / 0.65);
    padding: 0.75rem 1rem 0;
  }
  .source-grid {
    grid-template-columns: 1fr;
  }
  .source-item:nth-child(2) {
    border-top: 1px solid rgb(var(--border) / 0.35);
  }
}

@media (max-width: 620px) {
  .hooks-tabs {
    padding-inline: 0.65rem;
  }
  .hooks-body {
    gap: 0.75rem;
  }
  .hooks-status-strip {
    grid-template-columns: 1fr;
  }
  .hooks-status-strip > div {
    border-left: 0;
    border-top: 1px solid rgb(var(--border) / 0.45);
  }
  .hooks-status-strip > div:first-child {
    border-top: 0;
  }
  .trust-bar {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .trust-bar button {
    grid-column: 1 / -1;
    justify-self: end;
  }
  .source-item {
    grid-template-columns: 78px minmax(0, 1fr);
  }
  .source-item .state-label {
    grid-column: 2;
    justify-self: start;
  }
  .diagnostic-row {
    grid-template-columns: 1fr;
    gap: 0.35rem;
  }
  .effective-row,
  .audit-row {
    grid-template-columns: 1fr;
  }
  .row-meta,
  .audit-row > div:last-child {
    text-align: left;
  }
  .hooks-detail dl {
    grid-template-columns: 1fr;
  }
  .hooks-detail dl > div.wide {
    grid-column: auto;
  }
  .audit-toolbar {
    align-items: stretch;
  }
  .audit-toolbar select {
    flex: 1 1 100%;
  }
  .band-head {
    align-items: flex-start;
    padding-block: 0.6rem;
  }
  .advanced-editor .band-head {
    flex-direction: column;
  }
}

/* Settings-aligned minimalist surface. */
.hooks-panel {
  overflow: hidden;
}

.hooks-head {
  min-height: 58px;
  flex-direction: row !important;
  align-items: center !important;
}

.hooks-head > .tool-button {
  margin-left: auto;
}

.hooks-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hooks-title > div {
  min-width: 0;
}

.hooks-title code {
  flex: 0 0 auto;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.hooks-body {
  display: block;
  overflow-x: hidden;
  overflow-y: auto;
  padding-bottom: 20px;
  scrollbar-gutter: stable;
}

.hooks-content {
  display: grid;
  height: auto !important;
  gap: 14px;
}

.hooks-topbar {
  display: flex;
  min-width: 0;
  align-items: center;
}

.hooks-tabs {
  display: inline-flex;
  max-width: 100%;
  gap: 2px;
  overflow-x: auto;
  border: 1px solid rgb(var(--border));
  border-radius: 8px;
  padding: 2px;
  background: rgb(var(--bg-elevated));
}

.hooks-tabs button {
  min-height: 28px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  padding: 0 10px;
  color: rgb(var(--fg-muted));
  font-size: 12px;
  white-space: nowrap;
}

.hooks-tabs button.active {
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
  font-weight: 650;
}

.hooks-banner {
  margin: 0;
  border-radius: 8px;
  padding: 9px 11px;
}

.error-banner {
  border-color: rgb(var(--danger) / 0.35);
  background: rgb(var(--danger) / 0.08);
  color: rgb(var(--danger));
}

.hooks-summary-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 2px 1px;
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.hooks-summary-line span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.hooks-section {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.hooks-section > h2,
.hooks-section-title h2 {
  color: rgb(var(--fg-muted));
  font-size: 12px;
  font-weight: 650;
}

.hooks-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.hooks-section-title > span {
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.hooks-settings-list {
  display: grid;
  gap: 6px;
}

.hooks-settings-row,
.hooks-source-row,
.diagnostic-row {
  min-width: 0;
  background: rgb(var(--bg-elevated));
}

.hooks-settings-row > div span,
.hooks-source-row > div span,
.diagnostic-row > div span {
  overflow: hidden;
  color: rgb(var(--fg-subtle));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hooks-source-row small {
  margin-left: 5px;
  color: rgb(var(--fg-subtle));
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
}

.diagnostic-row {
  grid-template-columns: 20px minmax(0, 1fr) minmax(100px, auto);
}

.diagnostic-row code {
  max-width: 240px;
  overflow: hidden;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-label {
  max-width: 14rem;
  overflow: hidden;
  border: 1px solid rgb(var(--border));
  border-radius: 5px;
  padding: 2px 6px;
  color: rgb(var(--ok));
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-label.blocked {
  color: rgb(var(--danger));
}

.hooks-surface {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgb(var(--border));
  border-radius: 8px;
  background: rgb(var(--bg-elevated));
}

.effective-layout,
.audit-layout {
  display: grid;
  min-height: 340px;
  grid-template-columns: minmax(260px, 0.86fr) minmax(300px, 1.14fr);
  gap: 0;
}

.effective-list,
.audit-list {
  min-width: 0;
  border-right: 1px solid rgb(var(--border));
}

.effective-row,
.audit-row {
  display: grid;
  width: 100%;
  min-height: 52px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  border-top: 1px solid rgb(var(--border));
  padding: 8px 10px;
  text-align: left;
}

.effective-row:first-of-type,
.audit-row:first-of-type {
  border-top: 0;
}

.effective-row:hover,
.audit-row:hover,
.effective-row.selected,
.audit-row.selected {
  background: rgb(var(--bg-inset));
}

.effective-row.selected,
.audit-row.selected {
  box-shadow: inset 2px 0 0 rgb(var(--accent));
}

.effective-row.inactive {
  opacity: 0.64;
}

.effective-row strong,
.effective-row span,
.audit-row strong,
.audit-row span {
  display: block;
}

.effective-row strong,
.audit-row strong {
  overflow: hidden;
  color: rgb(var(--fg));
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.effective-row span,
.audit-row span {
  margin-top: 2px;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.row-meta,
.audit-row > div:last-child {
  text-align: right;
}

.row-meta code,
.audit-row code {
  font-size: 10px;
}

.hooks-detail {
  min-width: 0;
  border: 0;
  padding: 12px;
}

.detail-head,
.surface-head {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid rgb(var(--border));
}

.detail-head {
  padding: 0 0 10px;
}

.detail-head h3 {
  margin-top: 2px;
  color: rgb(var(--fg));
  font-size: 14px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.detail-head span,
.surface-head > span,
.surface-head > div > span {
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.hooks-detail dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
}

.hooks-detail dl > div {
  min-width: 0;
  border-bottom: 1px solid rgb(var(--border));
  padding: 9px 10px 9px 0;
}

.hooks-detail dl > div.wide {
  grid-column: 1 / -1;
}

.hooks-detail dt {
  color: rgb(var(--fg-subtle));
  font-size: 9px;
  text-transform: uppercase;
}

.hooks-detail dd {
  margin: 3px 0 0;
  color: rgb(var(--fg-muted));
  font-size: 11px;
  overflow-wrap: anywhere;
}

.hooks-detail dd code {
  word-break: break-all;
}

.handler-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid rgb(var(--border));
  padding: 9px 0;
}

.handler-row strong,
.handler-row span {
  display: block;
}

.handler-row strong {
  font-size: 11px;
}

.handler-row span {
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.surface-head {
  padding: 0 11px;
}

.surface-head h2 {
  color: rgb(var(--fg));
  font-size: 12px;
  font-weight: 650;
}

.test-layout,
.advanced-layout {
  display: grid;
  min-height: 460px;
  grid-template-columns: minmax(300px, 0.82fr) minmax(340px, 1.18fr);
  gap: 12px;
}

.test-form {
  display: flex;
  flex-direction: column;
}

.test-form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 11px 0;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.test-form select,
.audit-toolbar select {
  min-height: 34px;
  border: 1px solid rgb(var(--border));
  border-radius: 7px;
  background: rgb(var(--bg));
  padding: 0 8px;
  color: rgb(var(--fg));
}

.json-field {
  flex: 1;
}

.json-field textarea,
.advanced-editor textarea {
  width: 100%;
  flex: 1;
  resize: vertical;
  border: 1px solid rgb(var(--border));
  border-radius: 7px;
  background: rgb(var(--bg));
  padding: 10px;
  color: rgb(var(--fg));
  font: 11px/1.55 var(--font-mono);
}

.json-field textarea {
  min-height: 220px;
}

.test-form > button {
  align-self: flex-end;
  margin: 10px 11px;
}

.event-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 11px 0;
}

.event-capabilities span {
  border: 1px solid rgb(var(--border));
  border-radius: 5px;
  padding: 2px 5px;
  color: rgb(var(--fg-subtle));
  font-size: 9px;
}

.match-row {
  display: grid;
  min-height: 52px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border-top: 1px solid rgb(var(--border));
  padding: 8px 11px;
}

.match-row strong,
.match-row span {
  display: block;
}

.match-row strong {
  color: rgb(var(--fg));
  font-size: 11px;
  overflow-wrap: anywhere;
}

.match-row span {
  margin-top: 2px;
  color: rgb(var(--fg-subtle));
  font-size: 10px;
}

.result-json {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  border-top: 1px solid rgb(var(--border));
  padding: 10px;
  background: rgb(var(--bg));
  font-size: 10px;
}

.async-runs > div {
  display: grid;
  min-height: 38px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border-top: 1px solid rgb(var(--border));
  padding: 0 8px 0 11px;
}

.async-runs code {
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.audit-toolbar select {
  min-width: 130px;
}

.pagination {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  border-top: 1px solid rgb(var(--border));
  padding: 0 8px;
}

.audit-detail {
  padding-right: 12px;
}

.advanced-editor {
  display: flex;
  min-height: 460px;
  flex-direction: column;
}

.advanced-editor .surface-head > div {
  display: flex;
  align-items: center;
  gap: 7px;
}

.advanced-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.advanced-editor textarea {
  min-height: 400px;
  resize: none;
  border: 0;
  border-radius: 0;
}

.validation-ok {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px;
  color: rgb(var(--ok));
  font-weight: 650;
}

.validation-list > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid rgb(var(--border));
  padding: 10px 11px;
  font-size: 10px;
}

.validation-list code,
.validation-list span {
  overflow-wrap: anywhere;
}

.hooks-empty {
  display: grid;
  min-height: 96px;
  place-items: center;
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.hooks-empty.compact {
  min-height: 56px;
  border: 1px solid rgb(var(--border));
  border-radius: 8px;
}

@media (max-width: 980px) {
  .effective-layout,
  .audit-layout,
  .test-layout,
  .advanced-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .effective-list,
  .audit-list {
    border-right: 0;
    border-bottom: 1px solid rgb(var(--border));
  }

  .hooks-detail {
    border: 0;
    padding: 12px;
  }
}

@media (max-width: 620px) {
  .hooks-title code {
    display: none;
  }

  .hooks-tabs {
    width: 100%;
  }

  .hooks-tabs button {
    flex: 1 0 auto;
  }

  .hooks-settings-row,
  .hooks-source-row,
  .diagnostic-row {
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .hooks-settings-row > button,
  .hooks-source-row > .state-label,
  .diagnostic-row > code {
    grid-column: 2;
    justify-self: start;
    max-width: 100%;
  }

  .effective-row,
  .audit-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .row-meta,
  .audit-row > div:last-child {
    text-align: left;
  }

  .hooks-detail dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .hooks-detail dl > div.wide {
    grid-column: auto;
  }

  .audit-toolbar {
    align-items: stretch;
  }

  .audit-toolbar select {
    flex: 1 1 calc(50% - 6px);
    min-width: 0;
  }

  .advanced-editor .surface-head {
    min-height: 76px;
    align-items: flex-start;
    flex-direction: column;
    justify-content: center;
    padding-block: 8px;
  }
}
</style>
