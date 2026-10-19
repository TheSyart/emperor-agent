/**
 * State and actions of the add-model dialog (MOD-04), shared by its three
 * steps through provide/inject: connect (provider, key, address, a probe
 * and the vendor's list), pick (filters, families, preselection, manual
 * ids, manage-mode guards) and confirm (per-model parameters, then one
 * `model.saveEntries`). Pure decisions live in addModelModel.ts.
 */
import {
  computed,
  inject,
  provide,
  reactive,
  ref,
  type InjectionKey,
} from 'vue'
import type { DiscoveredModel } from '@emperor/core/api'
import {
  deleteModelEntry,
  listConnectionModels,
  lookupModelDefaults,
  probeModelConnection,
  saveModelEntries,
} from '../../../api/model'
import { withCoreDeadline } from '../../../api/http'
import type {
  ModelConfigPayload,
  ModelEntry,
  ProviderOption,
} from '../../../types'
import {
  buildEntryDraft,
  canUncheck,
  detectProviderFromKey,
  detectProviderFromUrl,
  filterModels,
  groupByFamily,
  manualModel,
  needsConfirmation,
  preselect,
  providerGroups,
  sortModels,
  toSaveRequest,
  type EntryDraft,
  type ModelFilter,
  type ModelSort,
} from './addModelModel'

export type AddModelStep = 'connect' | 'pick' | 'confirm'

export interface ConnectError {
  kind: 'key' | 'base' | 'network' | 'rate' | 'other'
  message: string
  fixApiBase?: string
  fixProvider?: string
}

export interface LocalStatus {
  running: boolean
  count: number | null
}

/** Local servers probed when the dialog opens (300 ms each). */
const LOCAL_PROBE_MS = 300
const RATE_RETRY_MS = 2000

type Saved = ModelConfigPayload & { savedEntryIds: string[] }

export function createAddModelController(input: {
  payload: () => ModelConfigPayload
  manageProvider?: string | null
  onSaved: (result: Saved) => void
  sleep?: (ms: number) => Promise<void>
}) {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  const options = computed<ProviderOption[]>(
    () => input.payload().providerOptions ?? [],
  )
  const step = ref<AddModelStep>('connect')
  const query = ref('')
  const connection = reactive({
    provider: null as string | null,
    protocol: 'openai' as 'openai' | 'anthropic',
    apiBase: '',
    apiKey: '',
    useSavedKey: false,
  })
  const local = reactive<Record<string, LocalStatus>>({})
  const connecting = ref(false)
  const error = ref<ConnectError | null>(null)
  const note = ref('')

  const models = ref<DiscoveredModel[]>([])
  const listSource = ref<'vendor_api' | 'catalog' | 'none'>('none')
  const truncated = ref(false)
  const totalCount = ref(0)
  const filter = ref<ModelFilter>('all')
  const sort = ref<ModelSort>('recommended')
  const search = ref('')
  const selected = ref<Set<string>>(new Set())
  const guard = ref('')
  const manualId = ref('')
  const manualMatch = ref<DiscoveredModel | null>(null)

  const drafts = ref<EntryDraft[]>([])
  const activateModelId = ref<string | null>(null)
  const saving = ref(false)
  const saveError = ref('')

  const option = computed(
    () =>
      options.value.find((item) => item.name === connection.provider) ?? null,
  )
  const groups = computed(() =>
    detectProviderFromUrl(query.value, options.value)
      ? []
      : providerGroups(options.value, query.value),
  )
  const isLocal = computed(() => Boolean(option.value?.isLocal))
  const protocols = computed(
    () =>
      (option.value?.protocols ?? ['openai']) as Array<'openai' | 'anthropic'>,
  )
  /** Saved entries on the chosen provider's connection. */
  const savedEntries = computed<ModelEntry[]>(() =>
    input
      .payload()
      .models.filter(
        (entry) =>
          entry.provider === connection.provider &&
          trimBase(entry.apiBase) === trimBase(connection.apiBase),
      ),
  )
  const savedKey = computed(() => {
    const entry = savedEntries.value.find((item) => item.apiKey)
    return entry
      ? { entryId: entry.entryId, tail: entry.apiKey.slice(-4) }
      : null
  })
  const keyHint = computed(() => {
    if (connection.useSavedKey) return null
    const suggested = detectProviderFromKey(connection.apiKey)
    if (!suggested || suggested === connection.provider) return null
    const found = options.value.find((item) => item.name === suggested)
    if (!found) return null
    return {
      provider: suggested,
      label: `这像是 ${found.displayName ?? suggested} 的 Key`,
    }
  })
  const manage = computed(() => input.manageProvider ?? null)
  const existingIds = computed(
    () => new Set(savedEntries.value.map((entry) => entry.modelId)),
  )
  const visible = computed(() =>
    sortModels(
      filterModels(models.value, filter.value, search.value),
      sort.value,
    ),
  )
  const families = computed(() =>
    sort.value === 'recommended' ? groupByFamily(visible.value) : null,
  )
  /** New models to save (manage mode: the ones not saved yet). */
  const picked = computed(() =>
    models.value.filter(
      (model) =>
        selected.value.has(model.id) && !existingIds.value.has(model.id),
    ),
  )
  const removed = computed(() =>
    savedEntries.value.filter((entry) => !selected.value.has(entry.modelId)),
  )
  const blocked = computed(() => needsConfirmation(drafts.value))

  function pickProvider(name: string, apiBase?: string): void {
    const found = options.value.find((item) => item.name === name)
    if (!found) return
    connection.provider = name
    connection.protocol = (found.defaultProtocol ??
      found.protocols?.[0] ??
      'openai') as 'openai' | 'anthropic'
    connection.apiBase =
      apiBase ?? found.apiBases?.[connection.protocol] ?? connection.apiBase
    connection.useSavedKey = Boolean(savedKey.value)
    error.value = null
  }

  function setQuery(value: string): void {
    query.value = value
    const detected = detectProviderFromUrl(value, options.value)
    if (detected) pickProvider(detected.provider, detected.apiBase)
  }

  function setProtocol(value: 'openai' | 'anthropic'): void {
    connection.protocol = value
    const preset = option.value?.apiBases?.[value]
    if (preset) connection.apiBase = preset
  }

  function connectionInput() {
    return {
      provider: connection.provider ?? 'custom',
      protocol: connection.protocol,
      apiBase: connection.apiBase,
      ...(isLocal.value
        ? { apiKey: null }
        : connection.useSavedKey && savedKey.value
          ? { entryId: savedKey.value.entryId }
          : { apiKey: connection.apiKey }),
    }
  }

  async function probeLocalServers(): Promise<void> {
    await Promise.all(
      options.value
        .filter((item) => item.isLocal && item.apiBases?.openai)
        .map(async (item) => {
          try {
            const result = await withCoreDeadline(
              probeModelConnection({
                provider: item.name,
                protocol: 'openai',
                apiBase: item.apiBases!.openai!,
                apiKey: null,
              }),
              { timeoutMs: LOCAL_PROBE_MS },
            )
            local[item.name] = result.ok
              ? { running: true, count: result.modelCount ?? null }
              : { running: false, count: null }
          } catch {
            local[item.name] = { running: false, count: null }
          }
        }),
    )
  }

  function describe(
    code: string,
    message: string,
    fix?: { apiBase?: string; provider?: string },
  ): ConnectError {
    const host = hostOf(connection.apiBase)
    if (code === 'AUTH' || code === 'CREDENTIAL_REQUIRED')
      return { kind: 'key', message: 'Key 无效或没有权限，请检查后重试' }
    if (code === 'REGION_KEY_MISMATCH')
      return {
        kind: 'key',
        message: '这个 Key 属于另一个区域的服务',
        ...(fix?.apiBase ? { fixApiBase: fix.apiBase } : {}),
      }
    if (
      code === 'WRONG_BASE' ||
      code === 'NOT_COMPATIBLE' ||
      code === 'MISSING_API_BASE'
    )
      return {
        kind: 'base',
        message: '这个地址不像兼容接口',
        ...(fix?.apiBase ? { fixApiBase: fix.apiBase } : {}),
        ...(fix?.provider ? { fixProvider: fix.provider } : {}),
      }
    if (code === 'NETWORK')
      return {
        kind: 'network',
        message: isLocal.value
          ? `连不上 ${host}，确认本地服务已经启动（例如 ollama serve）`
          : `连不上 ${host}`,
      }
    if (code === 'RATE_LIMITED')
      return { kind: 'rate', message: '被限流了，请稍后再试' }
    return { kind: 'other', message: message || '连接失败' }
  }

  /**
   * Probe the connection, then read its model list; a manage-mode open
   * skips the probe (the connection is saved and known to work).
   */
  async function connect(opts: { probe?: boolean } = {}): Promise<void> {
    if (connecting.value || !connection.provider) return
    connecting.value = true
    error.value = null
    note.value = ''
    try {
      const request = connectionInput()
      if (opts.probe !== false) {
        let probe = await probeModelConnection(request)
        if (!probe.ok && probe.code === 'RATE_LIMITED') {
          note.value = '被限流，稍后自动重试'
          await sleep(RATE_RETRY_MS)
          note.value = ''
          probe = await probeModelConnection(request)
        }
        if (!probe.ok) {
          error.value = describe(probe.code, probe.message, probe.fix)
          return
        }
      }
      const list = await listConnectionModels(request)
      if (!list.ok) {
        error.value = describe(
          list.code ?? 'UNKNOWN',
          list.message ?? '',
          list.fix,
        )
        return
      }
      models.value = list.models
      listSource.value = list.source
      truncated.value = list.truncated
      totalCount.value = list.totalCount
      selected.value = new Set(
        manage.value
          ? [...existingIds.value]
          : preselect(list.models).filter((id) => !existingIds.value.has(id)),
      )
      step.value = 'pick'
    } catch (cause) {
      error.value = { kind: 'other', message: messageOf(cause) }
    } finally {
      connecting.value = false
    }
  }

  async function applyFix(): Promise<void> {
    const fix = error.value
    if (!fix) return
    if (fix.fixProvider) pickProvider(fix.fixProvider, fix.fixApiBase)
    else if (fix.fixApiBase) connection.apiBase = fix.fixApiBase
    await connect()
  }

  function toggle(modelId: string, checked: boolean): void {
    guard.value = ''
    const next = new Set(selected.value)
    if (!checked) {
      const entry = savedEntries.value.find((item) => item.modelId === modelId)
      if (entry) {
        const verdict = canUncheck(entry.entryId, input.payload())
        if (!verdict.ok) {
          guard.value = verdict.reason
          return
        }
      }
      next.delete(modelId)
    } else next.add(modelId)
    selected.value = next
  }

  let lookupSeq = 0
  async function lookupManual(id: string): Promise<void> {
    manualId.value = id
    const modelId = id.trim()
    const seq = (lookupSeq += 1)
    if (!modelId) {
      manualMatch.value = null
      return
    }
    try {
      const { facts } = await lookupModelDefaults({
        provider: connection.provider ?? 'custom',
        protocol: connection.protocol,
        apiBase: connection.apiBase,
        modelId,
      })
      if (seq === lookupSeq) manualMatch.value = manualModel(modelId, facts)
    } catch {
      if (seq === lookupSeq) manualMatch.value = null
    }
  }

  function addManual(): void {
    const match = manualMatch.value
    if (!match) return
    if (!models.value.some((model) => model.id === match.id))
      models.value = [...models.value, match]
    selected.value = new Set([...selected.value, match.id])
    manualId.value = ''
    manualMatch.value = null
    search.value = ''
  }

  function toConfirm(): void {
    const kept = new Map(drafts.value.map((draft) => [draft.modelId, draft]))
    drafts.value = picked.value.map(
      (model) =>
        kept.get(model.id) ?? buildEntryDraft(model, { local: isLocal.value }),
    )
    if (activateModelId.value === null && !input.payload().activeModelId)
      activateModelId.value = drafts.value[0]?.modelId ?? null
    step.value = drafts.value.length ? 'confirm' : step.value
  }

  function setAllMaxTokens(value: number): void {
    for (const draft of drafts.value) {
      draft.maxTokens = draft.maxOutputLimit
        ? Math.min(value, draft.maxOutputLimit)
        : value
      if (!draft.edited.includes('maxTokens')) draft.edited.push('maxTokens')
    }
  }

  async function save(): Promise<void> {
    if (saving.value || blocked.value) return
    saving.value = true
    saveError.value = ''
    try {
      let result: Saved | null = null
      if (drafts.value.length) {
        const entryIds = Object.fromEntries(
          drafts.value.map((draft) => [draft.modelId, newEntryId()]),
        )
        result = await saveModelEntries(
          toSaveRequest({
            connection: {
              provider: connection.provider ?? 'custom',
              protocol: connection.protocol,
              apiBase: connection.apiBase,
              apiKey:
                isLocal.value || (connection.useSavedKey && savedKey.value)
                  ? null
                  : connection.apiKey,
            },
            drafts: drafts.value,
            activateModelId: activateModelId.value,
            entryIds,
          }),
        )
      }
      for (const entry of manage.value ? removed.value : []) {
        const after = await deleteModelEntry(entry.entryId)
        result = { ...after, savedEntryIds: result?.savedEntryIds ?? [] }
      }
      if (result) input.onSaved(result)
    } catch (cause) {
      saveError.value = messageOf(cause)
    } finally {
      saving.value = false
    }
  }

  async function start(): Promise<void> {
    void probeLocalServers()
    if (manage.value) {
      pickProvider(
        manage.value,
        input.payload().models.find((entry) => entry.provider === manage.value)
          ?.apiBase,
      )
      await connect({ probe: false })
    }
  }

  return reactive({
    options,
    step,
    query,
    connection,
    local,
    connecting,
    error,
    note,
    models,
    listSource,
    truncated,
    totalCount,
    filter,
    sort,
    search,
    selected,
    guard,
    manualId,
    manualMatch,
    drafts,
    activateModelId,
    saving,
    saveError,
    option,
    groups,
    isLocal,
    protocols,
    savedKey,
    keyHint,
    manage,
    existingIds,
    visible,
    families,
    picked,
    removed,
    blocked,
    pickProvider,
    setQuery,
    setProtocol,
    connect,
    applyFix,
    toggle,
    lookupManual,
    addManual,
    toConfirm,
    setAllMaxTokens,
    save,
    start,
  })
}

export type AddModelController = ReturnType<typeof createAddModelController>

const KEY: InjectionKey<AddModelController> = Symbol('add-model')

export function provideAddModel(controller: AddModelController): void {
  provide(KEY, controller)
}

export function useAddModel(): AddModelController {
  const controller = inject(KEY)
  if (!controller) throw new Error('useAddModel() outside AddModelDialog')
  return controller
}

function trimBase(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '')
}

function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return apiBase || '这个地址'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newEntryId(): string {
  return `model-${crypto.randomUUID()}`
}
