import { computed, onMounted, ref, watch } from 'vue'
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

export type HooksTab = 'effective' | 'test' | 'audit' | 'advanced'
type Dict = Record<string, unknown>

export interface HookMatchItem {
  index?: number
  eventName?: string
  groupId?: string
  handlerId?: string
  handlerType?: string
  source?: { id?: string; kind?: string; readonly?: boolean }
  failureMode?: string
}

export interface HookMatchPayload {
  revision?: string
  eventName?: string
  items?: HookMatchItem[]
  diagnostics?: Array<{ code?: string; path?: string; message?: string }>
}

export interface HookValidationPayload {
  valid?: boolean
  config?: Dict
  diagnostics?: Array<{ code?: string; path?: string; message?: string }>
}

export function useHooksPanelController() {
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
      events.value.find(
        (event) => event.eventName === selectedEventName.value,
      ) ?? null,
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
      if (row && selectedRowKey.value !== row.key)
        selectedRowKey.value = row.key
    },
    { immediate: true },
  )
  watch(selectedEvent, (event) => {
    testInputDraft.value = defaultDryRunInput(event)
    matchResult.value = null
    testResult.value = null
  })
  onMounted(() => void loadAll())

  async function loadAll(): Promise<void> {
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

  async function changeTrust(trusted: boolean): Promise<void> {
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

  async function testMatch(): Promise<void> {
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

  async function executeMatch(item: HookMatchItem): Promise<void> {
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

  async function cancelTestRun(runId: string): Promise<void> {
    testing.value = true
    error.value = ''
    try {
      const result = await core('hooks.cancelRun', { runId })
      if (!result.cancelled)
        throw new Error(`Hook run 不存在或已结束：${runId}`)
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

  async function saveAdvanced(): Promise<void> {
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

  async function loadAudit(
    cursor: string | null = null,
    remember = false,
  ): Promise<void> {
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

  async function nextAuditPage(): Promise<void> {
    if (audit.value?.nextCursor) await loadAudit(audit.value.nextCursor, true)
  }

  async function previousAuditPage(): Promise<void> {
    const previous = auditHistory.value.pop()
    await loadAudit(previous ?? null, false)
  }

  function onAdvancedInput(): void {
    advancedDirty.value = true
    validation.value = null
    stale.value = false
  }

  return {
    tabs,
    activeTab,
    loading,
    saving,
    testing,
    trusting,
    error,
    stale,
    payload,
    metadata,
    audit,
    selectedRowKey,
    selectedEventName,
    testInputDraft,
    matchResult,
    testResult,
    advancedDraft,
    advancedDirty,
    validation,
    auditEvent,
    auditOutcome,
    auditSource,
    auditCursor,
    auditHistory,
    selectedAudit,
    rows,
    selectedRow,
    selectedEffective,
    events,
    selectedEvent,
    projectTrust,
    trustTone,
    diagnostics,
    sourceOptions,
    pendingTestRuns,
    loadAll,
    changeTrust,
    testMatch,
    executeMatch,
    cancelTestRun,
    validateAdvanced,
    saveAdvanced,
    loadAudit,
    nextAuditPage,
    previousAuditPage,
    onAdvancedInput,
    sourceStatus,
  }
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
