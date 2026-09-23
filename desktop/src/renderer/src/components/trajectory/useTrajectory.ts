// Shared trajectory controller of one session: activates the lazy
// 'trajectory' target of the conversation store, memoizes the view model on
// the snapshot fields it reads (streaming deltas never rebuild the finalized
// layout), and owns the selection / fold / tab state that the ledger and
// the inspector column (both inside TrajectoryView) share. Callers use
// `useTrajectory(sessionId)` and receive the same ref-counted controller.
import {
  computed,
  effectScope,
  getCurrentScope,
  onScopeDispose,
  ref,
  shallowRef,
  type ComputedRef,
  type EffectScope,
  type Ref,
  type ShallowRef,
} from 'vue'
import {
  defaultConversationStore,
  registerLazyConversationTarget,
  useConversation,
  type ConversationHandle,
  type ConversationStore,
} from '../../conversation/store'
import type { SessionWindowState } from '../../conversation/sessionWindow'
import {
  EMPTY_TRAJECTORY_SNAPSHOT,
  TRAJECTORY_EXTENSIONS,
  TRAJECTORY_TARGET,
  appendTrajectoryPartialLayout,
  deriveTrajectoryFinalizedLayout,
  deriveTrajectoryRequestNumbers,
  findTrajectoryCallRecord,
  flattenTrajectoryRecords,
  indexTrajectoryRequestBoundaries,
  indexTrajectoryRequestDisplayNumbers,
  trajectoryDetailTabs,
  trajectoryPartialSignature,
  trajectoryRecordId,
  trajectoryTimelinePartial,
  type TrajectoryCellProps,
  type TrajectoryDetailTab,
  type TrajectoryFinalizedLayout,
  type TrajectoryLedgerRecord,
  type TrajectoryRequestNumber,
  type TrajectorySnapshot,
  type TrajectoryTurnModel,
} from '../../trajectory/model'

// This module only loads with the lazy trajectory chunk: register the target
// here so the chat bundle never imports the trajectory definitions.
registerLazyConversationTarget(TRAJECTORY_TARGET, TRAJECTORY_EXTENSIONS)

/** What the inspector shows: one record, or one provider request. */
export type TrajectorySelection =
  | { readonly kind: 'record'; readonly id: string }
  | {
      readonly kind: 'request'
      readonly turn: number | null
      readonly group: string
      readonly seq?: number
    }

/** One-shot request for the ledger to bring a record into view. */
export interface TrajectoryScrollRequest {
  readonly recordId: string
  readonly token: number
}

/** Shared per-session trajectory state (see file header). */
export interface TrajectoryController {
  readonly sessionId: string
  readonly handle: ConversationHandle
  readonly snapshot: ComputedRef<TrajectorySnapshot>
  /** Finalized layout (partial reduced to an anchor). */
  readonly finalized: ComputedRef<TrajectoryFinalizedLayout>
  /** Ledger / timeline layout: finalized + structural streaming tail. */
  readonly turns: ComputedRef<readonly TrajectoryTurnModel[]>
  /** Streaming records only, with their live content. */
  readonly streamingTurns: ComputedRef<readonly TrajectoryTurnModel[]>
  /** Live content of streaming records by record index. */
  readonly streamingCells: ComputedRef<ReadonlyMap<number, TrajectoryCellProps>>
  readonly requestNumbers: ComputedRef<readonly TrajectoryRequestNumber[]>
  /** Unfolded, unfiltered ledger rows (structural cells). */
  readonly records: ComputedRef<readonly TrajectoryLedgerRecord[]>
  /** Record index each request boundary is drawn at, by request key. */
  readonly requestBoundaries: ComputedRef<ReadonlyMap<string, number>>
  /** Display number of each request, by request key. */
  readonly requestDisplayNumbers: ComputedRef<ReadonlyMap<string, number>>
  readonly windowState: ComputedRef<SessionWindowState>
  readonly running: ComputedRef<boolean>
  readonly selection: ShallowRef<TrajectorySelection | null>
  /** Selected record with its live content (undefined for requests). */
  readonly selectedRecord: ComputedRef<TrajectoryLedgerRecord | undefined>
  readonly selectedRecordId: ComputedRef<string | null>
  readonly activeTab: Ref<TrajectoryDetailTab>
  readonly collapsedTurns: ShallowRef<ReadonlySet<number>>
  readonly collapsedAssistants: ShallowRef<ReadonlySet<string>>
  readonly scrollRequest: ShallowRef<TrajectoryScrollRequest | null>
  /** A ledger record with its streaming content applied. */
  currentRecord(record: TrajectoryLedgerRecord): TrajectoryLedgerRecord
  recordByIndex(index: number): TrajectoryLedgerRecord | undefined
  /** Select a record (most recently used tab that it offers). */
  selectRecord(index: number, options?: { scroll?: boolean }): void
  selectRequest(
    target: Omit<Extract<TrajectorySelection, { kind: 'request' }>, 'kind'>,
    tab?: TrajectoryDetailTab,
  ): void
  activateTab(tab: TrajectoryDetailTab): void
  clearSelection(): void
  /** Unfold, select on its Summary tab and scroll to a record. */
  openRecordSummary(record: TrajectoryLedgerRecord): void
  /** `openRecordSummary` of a tool call's record; false when not loaded. */
  openCallSummary(callId: string): boolean
  /** Inspect deep link: select + reveal a call's record; false when absent. */
  focusCall(callId: string): boolean
  toggleTurn(turn: number): void
  toggleAssistant(id: string): void
  setCollapsedTurns(turns: ReadonlySet<number>): void
  setCollapsedAssistants(ids: ReadonlySet<string>): void
  requestScroll(recordId: string): void
  loadOlder(): Promise<void>
}

const EMPTY_WINDOW: SessionWindowState = {
  openState: 'cold',
  header: null,
  hasMore: false,
  loadingOlder: false,
  error: null,
}

function sameInputs(
  left: readonly unknown[] | null,
  right: readonly unknown[],
): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  )
}

/** Memoize `derive` on the identity of `inputs()` (not on the whole snapshot). */
function memoOn<T>(
  inputs: () => readonly unknown[],
  derive: () => T,
): ComputedRef<T> {
  let last: readonly unknown[] | null = null
  let value: T
  return computed(() => {
    const next = inputs()
    if (!sameInputs(last, next)) {
      last = next
      value = derive()
    }
    return value
  })
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** Build a controller over one open conversation handle. */
export function createTrajectoryController(
  handle: ConversationHandle,
): TrajectoryController {
  handle.activate(TRAJECTORY_TARGET)
  const snapshot = computed<TrajectorySnapshot>(() => {
    void handle.revision.value
    return (
      handle.target<TrajectorySnapshot>(TRAJECTORY_TARGET) ??
      EMPTY_TRAJECTORY_SNAPSHOT
    )
  })
  const finalized = memoOn(
    () => {
      const value = snapshot.value
      return [
        value.eventNodes,
        value.eventLocations,
        value.partial?.turn ?? null,
        value.partial?.step ?? null,
        value.runningCalls,
        value.requests,
        value.callSchemas,
      ]
    },
    () => deriveTrajectoryFinalizedLayout(snapshot.value),
  )
  const partialSignature = computed(() =>
    trajectoryPartialSignature(snapshot.value.partial),
  )
  const turns = memoOn(
    () => [finalized.value, partialSignature.value],
    () =>
      appendTrajectoryPartialLayout(
        finalized.value.turns,
        trajectoryTimelinePartial(snapshot.value.partial),
        finalized.value.lastIndex,
      ),
  )
  const streamingTurns = memoOn(
    () => [finalized.value.lastIndex, snapshot.value.partial],
    () =>
      appendTrajectoryPartialLayout(
        [],
        snapshot.value.partial,
        finalized.value.lastIndex,
      ),
  )
  const streamingCells = computed(
    () =>
      new Map(
        streamingTurns.value.flatMap((turn) =>
          turn.groups.flatMap((group) =>
            group.cells.map((cell) => [cell.index, cell] as const),
          ),
        ),
      ),
  )
  const requestNumbers = memoOn(
    () => [snapshot.value.eventNodes, snapshot.value.requests],
    () =>
      deriveTrajectoryRequestNumbers(
        snapshot.value.eventNodes,
        snapshot.value.requests,
      ),
  )
  const records = computed(() => flattenTrajectoryRecords(turns.value))
  const recordsByIndex = computed(
    () => new Map(records.value.map((record) => [record.cell.index, record])),
  )
  const recordsById = computed(
    () =>
      new Map(
        records.value.map((record) => [
          trajectoryRecordId(record.cell),
          record,
        ]),
      ),
  )
  const requestBoundaries = computed(() =>
    indexTrajectoryRequestBoundaries(records.value),
  )
  const requestDisplayNumbers = computed(() =>
    indexTrajectoryRequestDisplayNumbers(
      records.value,
      requestNumbers.value,
      requestBoundaries.value,
    ),
  )
  const windowState = computed(() => handle.window.value ?? EMPTY_WINDOW)
  const running = computed(
    () =>
      handle.snapshot.value.running ||
      snapshot.value.partial !== null ||
      snapshot.value.runningCalls.length > 0,
  )

  const selection = shallowRef<TrajectorySelection | null>(null)
  const activeTab = ref<TrajectoryDetailTab>('overview')
  const tabHistory = new Set<TrajectoryDetailTab>(['overview'])
  const collapsedTurns = shallowRef<ReadonlySet<number>>(new Set())
  const collapsedAssistants = shallowRef<ReadonlySet<string>>(new Set())
  const scrollRequest = shallowRef<TrajectoryScrollRequest | null>(null)
  let scrollToken = 0

  function currentRecord(
    record: TrajectoryLedgerRecord,
  ): TrajectoryLedgerRecord {
    const cell = streamingCells.value.get(record.cell.index)
    return cell === undefined ? record : { ...record, cell }
  }

  const selectedRecordId = computed(() =>
    selection.value?.kind === 'record' ? selection.value.id : null,
  )
  const selectedRecord = computed(() => {
    const id = selectedRecordId.value
    if (id === null) return undefined
    const record = recordsById.value.get(id)
    return record === undefined ? undefined : currentRecord(record)
  })

  function activateTab(tab: TrajectoryDetailTab): void {
    tabHistory.delete(tab)
    tabHistory.add(tab)
    activeTab.value = tab
  }

  function requestScroll(recordId: string): void {
    scrollRequest.value = { recordId, token: ++scrollToken }
  }

  function selectRecord(index: number, options: { scroll?: boolean } = {}) {
    const record = recordsByIndex.value.get(index)
    if (record === undefined) {
      selection.value = null
      return
    }
    const id = trajectoryRecordId(record.cell)
    selection.value = { kind: 'record', id }
    const available = new Set(
      trajectoryDetailTabs(record.cell).map((tab) => tab.id),
    )
    const recent = [...tabHistory].reverse().find((tab) => available.has(tab))
    activeTab.value =
      recent ?? trajectoryDetailTabs(record.cell)[0]?.id ?? 'overview'
    if (options.scroll === true) requestScroll(id)
  }

  function unfoldFor(target: TrajectoryLedgerRecord): void {
    if (target.turn !== null && collapsedTurns.value.has(target.turn))
      collapsedTurns.value = toggled(collapsedTurns.value, target.turn)
    if (target.cell.kind !== 'tool' && target.cell.kind !== 'subtool') return
    const all = records.value
    const at = all.findIndex(
      (record) => record.cell.index === target.cell.index,
    )
    for (let index = at - 1; index >= 0; index--) {
      const candidate = all[index]
      if (candidate === undefined || candidate.turn !== target.turn) break
      if (candidate.cell.kind !== 'message') continue
      const id = trajectoryRecordId(candidate.cell)
      if (collapsedAssistants.value.has(id))
        collapsedAssistants.value = toggled(collapsedAssistants.value, id)
      break
    }
  }

  function openRecordSummary(target: TrajectoryLedgerRecord): void {
    unfoldFor(target)
    const id = trajectoryRecordId(target.cell)
    selection.value = { kind: 'record', id }
    activateTab('overview')
    requestScroll(id)
  }

  function openCallSummary(callId: string): boolean {
    const target = records.value.find((record) => record.cell.callId === callId)
    if (target === undefined) return false
    openRecordSummary(target)
    return true
  }

  function focusCall(callId: string): boolean {
    const found = findTrajectoryCallRecord(turns.value, callId)
    if (found === undefined) return false
    const record = recordsByIndex.value.get(found.index)
    if (record === undefined) return false
    openRecordSummary(record)
    return true
  }

  return {
    sessionId: handle.sessionId,
    handle,
    snapshot,
    finalized,
    turns,
    streamingTurns,
    streamingCells,
    requestNumbers,
    records,
    requestBoundaries,
    requestDisplayNumbers,
    windowState,
    running,
    selection,
    selectedRecord,
    selectedRecordId,
    activeTab,
    collapsedTurns,
    collapsedAssistants,
    scrollRequest,
    currentRecord,
    recordByIndex: (index) => recordsByIndex.value.get(index),
    selectRecord,
    selectRequest(target, tab = 'overview') {
      selection.value = { kind: 'request', ...target }
      activateTab(tab)
    },
    activateTab,
    clearSelection() {
      selection.value = null
    },
    openRecordSummary,
    openCallSummary,
    focusCall,
    toggleTurn(turn) {
      collapsedTurns.value = toggled(collapsedTurns.value, turn)
    },
    toggleAssistant(id) {
      collapsedAssistants.value = toggled(collapsedAssistants.value, id)
    },
    setCollapsedTurns(value) {
      collapsedTurns.value = value
    },
    setCollapsedAssistants(value) {
      collapsedAssistants.value = value
    },
    requestScroll,
    loadOlder: () => handle.loadOlder(),
  }
}

interface RegistryEntry {
  readonly controller: TrajectoryController
  readonly scope: EffectScope
  refs: number
}

const registries = new WeakMap<ConversationStore, Map<string, RegistryEntry>>()

/**
 * Acquire the shared controller of a session (created on first use,
 * disposed with its conversation retain when the last user releases it).
 */
export function acquireTrajectory(
  sessionId: string,
  store: ConversationStore = defaultConversationStore(),
): { controller: TrajectoryController; release: () => void } {
  let registry = registries.get(store)
  if (registry === undefined) {
    registry = new Map()
    registries.set(store, registry)
  }
  let entry = registry.get(sessionId)
  if (entry === undefined) {
    const scope = effectScope(true)
    const controller = scope.run(() =>
      createTrajectoryController(useConversation(sessionId, store)),
    ) as TrajectoryController
    entry = { controller, scope, refs: 0 }
    registry.set(sessionId, entry)
  }
  const acquired = entry
  acquired.refs++
  let released = false
  return {
    controller: acquired.controller,
    release: () => {
      if (released) return
      released = true
      acquired.refs--
      if (acquired.refs > 0) return
      acquired.scope.stop()
      if (registry.get(sessionId) === acquired) registry.delete(sessionId)
    },
  }
}

/**
 * The shared trajectory controller of a session for the calling component
 * (released with the component's scope). The ledger and the inspector of the
 * same session share one instance.
 */
export function useTrajectory(
  sessionId: string,
  options: { store?: ConversationStore } = {},
): TrajectoryController {
  const { controller, release } = acquireTrajectory(sessionId, options.store)
  if (getCurrentScope() !== undefined) onScopeDispose(release)
  return controller
}
