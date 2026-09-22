import {
  computed,
  inject,
  onMounted,
  provide,
  ref,
  watch,
  type InjectionKey,
} from 'vue'
import { core } from '../../../api/http'
import type {
  HookAuditRecordPayload,
  HookMatchItemPayload,
  HooksAuditPayload,
  HooksConfigPayload,
  HooksMatchPayload,
  HooksMetadataPayload,
  HooksTestRunPayload,
  HooksValidationPayload,
} from '../../../types'
import {
  auditQuery,
  hookEventCountRows,
  hooksEditorSeed,
  totalHookCount,
} from './hooksModel'

export type HooksTab = 'config' | 'test' | 'audit'

/**
 * Settings › Hooks state: the Claude Code `hooks.json` editor (the editable
 * global file plus read-only project `.claude/settings*.json` sources
 * discovered by Core), the matcher test bench and the run audit. The section
 * view and its tab components only render; every `hooks.*` Core call lives
 * here. HooksSection creates it with `provideHooksController()`; the tabs
 * read it back with `useHooksController()`.
 */
export function createHooksController() {
  const tabs: Array<{ id: HooksTab; label: string }> = [
    { id: 'config', label: '配置' },
    { id: 'test', label: '测试' },
    { id: 'audit', label: '审计' },
  ]
  const activeTab = ref<HooksTab>('config')
  const loading = ref(false)
  const saving = ref(false)
  const testing = ref(false)
  const auditLoading = ref(false)
  const error = ref('')
  const payload = ref<HooksConfigPayload | null>(null)
  const metadata = ref<HooksMetadataPayload | null>(null)
  const audit = ref<HooksAuditPayload | null>(null)
  const draft = ref('')
  const dirty = ref(false)
  const validation = ref<HooksValidationPayload | null>(null)
  const selectedEventName = ref('')
  const matchQuery = ref('')
  const matchResult = ref<HooksMatchPayload | null>(null)
  /** Match item waiting for the inline 「确认执行」 step. */
  const pendingRun = ref<HookMatchItemPayload | null>(null)
  const testResult = ref<HooksTestRunPayload | null>(null)
  const auditEvent = ref('')
  const auditOutcome = ref('')
  const auditCursor = ref<string | null>(null)
  const auditHistory = ref<Array<string | null>>([])
  /** Audit record whose details are expanded (identity of the record). */
  const selectedAudit = ref<HookAuditRecordPayload | null>(null)

  const eventRows = computed(() => hookEventCountRows(payload.value))
  const total = computed(() => totalHookCount(payload.value))
  const events = computed(() => metadata.value?.events ?? [])
  const selectedEvent = computed(
    () =>
      events.value.find(
        (event) => event.eventName === selectedEventName.value,
      ) ?? null,
  )
  const loadErrors = computed(() => payload.value?.errors ?? [])
  /** Read-only project sources (every loaded file except the global one). */
  const projectFiles = computed(() =>
    (payload.value?.files ?? []).filter((file) => file !== payload.value?.path),
  )

  watch(selectedEventName, () => {
    matchResult.value = null
    pendingRun.value = null
    testResult.value = null
  })
  watch([auditEvent, auditOutcome], () => {
    auditHistory.value = []
    void loadAudit(null, false)
  })
  onMounted(() => void loadAll())

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const [nextPayload, nextMetadata, nextAudit] = await Promise.all([
        core('hooks.getConfig'),
        core('hooks.getMetadata'),
        core(
          'hooks.getAudit',
          auditQuery({
            eventName: auditEvent.value,
            outcome: auditOutcome.value,
          }),
        ),
      ])
      payload.value = nextPayload
      metadata.value = nextMetadata
      audit.value = nextAudit
      auditCursor.value = nextAudit.cursor ?? null
      auditHistory.value = []
      selectedAudit.value = null
      selectedEventName.value ||= nextMetadata.events?.[0]?.eventName ?? ''
      draft.value = hooksEditorSeed(nextPayload)
      dirty.value = false
      validation.value = null
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      loading.value = false
    }
  }

  async function validate(): Promise<HooksValidationPayload | null> {
    error.value = ''
    try {
      validation.value = await core('hooks.validateConfig', {
        content: draft.value,
      })
      return validation.value
    } catch (cause) {
      validation.value = null
      error.value = messageOf(cause)
      return null
    }
  }

  async function save(): Promise<void> {
    if (saving.value || !dirty.value) return
    saving.value = true
    error.value = ''
    try {
      const checked = await validate()
      if (!checked?.valid) return
      const saved = await core('hooks.saveConfig', { content: draft.value })
      payload.value = saved
      draft.value = hooksEditorSeed(saved)
      dirty.value = false
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      saving.value = false
    }
  }

  async function testMatch(): Promise<void> {
    if (!selectedEventName.value) return
    testing.value = true
    error.value = ''
    pendingRun.value = null
    testResult.value = null
    try {
      matchResult.value = await core('hooks.testMatch', {
        eventName: selectedEventName.value,
        query: matchQuery.value,
        ...(dirty.value ? { content: draft.value } : {}),
      })
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      testing.value = false
    }
  }

  /** First step of a test run: ask for an explicit confirmation. */
  function requestRun(item: HookMatchItemPayload): void {
    pendingRun.value = item
  }

  function cancelRun(): void {
    pendingRun.value = null
  }

  /** Runs the confirmed match item (`confirmExecution: true`). */
  async function confirmRun(): Promise<void> {
    const item = pendingRun.value
    if (!item) return
    testing.value = true
    error.value = ''
    try {
      testResult.value = (await core('hooks.testRun', {
        eventName: selectedEventName.value,
        query: matchQuery.value,
        index: item.index,
        confirmExecution: true,
        ...(dirty.value ? { content: draft.value } : {}),
      })) as unknown as HooksTestRunPayload
      pendingRun.value = null
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      testing.value = false
    }
  }

  async function loadAudit(
    cursor: string | null = null,
    remember = false,
  ): Promise<void> {
    auditLoading.value = true
    error.value = ''
    try {
      if (remember) auditHistory.value.push(auditCursor.value)
      const next = await core(
        'hooks.getAudit',
        auditQuery({
          eventName: auditEvent.value,
          outcome: auditOutcome.value,
          cursor,
        }),
      )
      audit.value = next
      auditCursor.value = next.cursor ?? cursor
      selectedAudit.value = null
    } catch (cause) {
      error.value = messageOf(cause)
    } finally {
      auditLoading.value = false
    }
  }

  async function nextAuditPage(): Promise<void> {
    if (audit.value?.nextCursor) await loadAudit(audit.value.nextCursor, true)
  }

  async function previousAuditPage(): Promise<void> {
    const previous = auditHistory.value.pop()
    await loadAudit(previous ?? null, false)
  }

  function toggleAudit(record: HookAuditRecordPayload, open: boolean): void {
    selectedAudit.value = open ? record : null
  }

  function onDraftInput(): void {
    dirty.value = true
    validation.value = null
  }

  function resetDraft(): void {
    draft.value = hooksEditorSeed(payload.value)
    dirty.value = false
    validation.value = null
  }

  return {
    tabs,
    activeTab,
    loading,
    saving,
    testing,
    auditLoading,
    error,
    payload,
    metadata,
    audit,
    draft,
    dirty,
    validation,
    selectedEventName,
    selectedEvent,
    matchQuery,
    matchResult,
    pendingRun,
    testResult,
    auditEvent,
    auditOutcome,
    auditCursor,
    auditHistory,
    selectedAudit,
    eventRows,
    total,
    events,
    loadErrors,
    projectFiles,
    loadAll,
    validate,
    save,
    testMatch,
    requestRun,
    cancelRun,
    confirmRun,
    loadAudit,
    nextAuditPage,
    previousAuditPage,
    toggleAudit,
    onDraftInput,
    resetDraft,
  }
}

export type HooksController = ReturnType<typeof createHooksController>

const HOOKS_CONTROLLER_KEY: InjectionKey<HooksController> =
  Symbol('settings-hooks')

/** Section side: create the controller and share it with the tab views. */
export function provideHooksController(): HooksController {
  const controller = createHooksController()
  provide(HOOKS_CONTROLLER_KEY, controller)
  return controller
}

/** Tab side: the controller HooksSection provided. */
export function useHooksController(): HooksController {
  const controller = inject(HOOKS_CONTROLLER_KEY, null)
  if (!controller)
    throw new Error('useHooksController() must run inside HooksSection')
  return controller
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
