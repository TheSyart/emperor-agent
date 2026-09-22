// Ledger row model of the trajectory table (the pure parts of the dsh
// TrajectoryTable): flatten turns into rows, filter by search matches, fold
// collapsed turns / assistant tool runs into summary rows, place request
// boundaries and numbers, and derive per-record display text, state and
// inspector tabs. The Vue table only renders these rows.
import type { TrajectoryTurnModel } from './layout'
import { trajectoryPreviewText } from './preview'
import type { TrajectoryCellKind, TrajectoryCellProps } from './record'
import { trajectoryRecordId } from './record'
import { trajectoryRequestKey, type TrajectoryRequestNumber } from './requests'

/** One ledger row (a record, or a synthetic folded summary). */
export interface TrajectoryLedgerRecord {
  turn: number | null
  /** Position of the owning turn section in the layout. */
  section: number
  group: string
  groupStart: boolean
  turnStart: boolean
  cell: TrajectoryCellProps
  turnEnd: boolean
  collapsedSummary?: string
  collapsedSummaryKind?: 'turn' | 'assistant'
}

/** Completion state of one record. */
export type TrajectoryRecordState = 'complete' | 'running' | 'error'

/** Inspector tab of one record. */
export type TrajectoryDetailTab =
  | 'system-prompt'
  | 'tools'
  | 'diff'
  | 'overview'
  | 'rendered'
  | 'raw'
  | 'source'
  | 'input'
  | 'output'
  | 'schema'
  | 'timing'
  | 'options'
  | 'usage'

export interface TrajectoryDetailTabItem {
  readonly id: TrajectoryDetailTab
  readonly label: string
}

const SYSTEM_PROMPT_TABS: readonly TrajectoryDetailTabItem[] = [
  { id: 'system-prompt', label: 'System Prompt' },
  { id: 'tools', label: 'Tools' },
]
const SYSTEM_UPDATE_TABS: readonly TrajectoryDetailTabItem[] = [
  ...SYSTEM_PROMPT_TABS,
  { id: 'diff', label: 'Diff' },
]

/** Inspector tabs of a selected request. */
export const TRAJECTORY_REQUEST_TABS: readonly TrajectoryDetailTabItem[] = [
  { id: 'overview', label: 'Summary' },
  { id: 'options', label: 'Options' },
  { id: 'usage', label: 'Usage' },
  { id: 'timing', label: 'Timing' },
]

/** Flatten the layout into ledger rows with group/turn boundaries. */
export function flattenTrajectoryRecords(
  turns: readonly TrajectoryTurnModel[],
): TrajectoryLedgerRecord[] {
  return turns.flatMap((turn, section) => {
    let firstInSection = true
    const records = turn.groups.flatMap((group) =>
      group.cells.map((cell, index): TrajectoryLedgerRecord => {
        const turnStart =
          firstInSection &&
          cell.requestOnly !== true &&
          cell.kind !== 'system' &&
          (cell.kind !== 'compacted' || turn.turn === null)
        if (turnStart) firstInSection = false
        return {
          turn: turn.turn,
          section,
          group: group.title,
          groupStart: index === 0,
          turnStart,
          cell,
          turnEnd: false,
        }
      }),
    )
    const last = records.at(-1)
    if (last !== undefined) last.turnEnd = true
    return records
  })
}

/** Keep only rows whose record index matches, recomputing boundaries. */
export function filterTrajectoryRecords(
  records: readonly TrajectoryLedgerRecord[],
  matches: ReadonlySet<number>,
): TrajectoryLedgerRecord[] {
  const filtered = records
    .filter(
      (record) =>
        record.cell.requestOnly !== true && matches.has(record.cell.index),
    )
    .map((record) => ({
      ...record,
      groupStart: false,
      turnStart: false,
      turnEnd: false,
    }))
  const startedSections = new Set<number>()
  for (const [index, record] of filtered.entries()) {
    const previous = filtered[index - 1]
    const next = filtered[index + 1]
    record.groupStart =
      previous === undefined ||
      previous.section !== record.section ||
      previous.group !== record.group
    record.turnStart =
      !startedSections.has(record.section) &&
      record.cell.kind !== 'system' &&
      (record.cell.kind !== 'compacted' || record.turn === null)
    if (record.turnStart) startedSections.add(record.section)
    record.turnEnd = next === undefined || next.section !== record.section
  }
  return filtered
}

/** Step number of a `Step N` group title. */
export function trajectoryRequestStep(group: string): number | undefined {
  if (!group.startsWith('Step ')) return undefined
  const value = Number(group.slice('Step '.length))
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Section label of a turn (`Turn N` / `Between turns`). */
export function trajectorySectionLabel(turn: number | null): string {
  return turn === null ? 'Between turns' : `Turn ${turn}`
}

/**
 * Record index at which each request's boundary is drawn: the first
 * non-input record of a Step group (steering input precedes its request),
 * or the first record of any other group.
 */
export function indexTrajectoryRequestBoundaries(
  records: readonly TrajectoryLedgerRecord[],
): ReadonlyMap<string, number> {
  const boundaries = new Map<string, number>()
  for (const record of records) {
    const key = trajectoryRequestKey(record.turn, record.group)
    if (boundaries.has(key)) continue
    if (trajectoryRequestStep(record.group) === undefined) {
      if (record.groupStart) boundaries.set(key, record.cell.index)
      continue
    }
    if (record.cell.kind === 'user' || record.cell.kind === 'context') continue
    boundaries.set(key, record.cell.index)
  }
  return boundaries
}

/**
 * Display number of every request boundary: session numbers first, then
 * sequential numbers for boundaries without a recorded request.
 */
export function indexTrajectoryRequestDisplayNumbers(
  records: readonly TrajectoryLedgerRecord[],
  sessionNumbers: readonly TrajectoryRequestNumber[] | undefined,
  boundaries: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>()
  for (const request of sessionNumbers ?? [])
    numbers.set(
      trajectoryRequestKey(request.turn, request.group),
      request.number,
    )
  let next = Math.max(0, ...numbers.values()) + 1
  const boundaryRecords = records
    .filter(
      (record) =>
        boundaries.get(trajectoryRequestKey(record.turn, record.group)) ===
          record.cell.index &&
        trajectoryRequestStep(record.group) !== undefined,
    )
    .sort((left, right) => left.cell.index - right.cell.index)
  for (const record of boundaryRecords) {
    const key = trajectoryRequestKey(record.turn, record.group)
    if (!numbers.has(key)) numbers.set(key, next++)
  }
  return numbers
}

/** Position of each coincident request marker in its run (left to right). */
export function indexTrajectoryRequestBoundaryRuns(
  records: readonly TrajectoryLedgerRecord[],
): ReadonlyMap<number, number> {
  const indexes = new Map<number, number>()
  let runLength = 0
  for (const record of records) {
    if (record.cell.requestOnly === true) {
      indexes.set(record.cell.index, runLength++)
      continue
    }
    if (
      runLength > 0 &&
      record.groupStart &&
      trajectoryRequestStep(record.group) !== undefined
    )
      indexes.set(record.cell.index, runLength)
    runLength = 0
  }
  return indexes
}

function summarizeTurn(records: readonly TrajectoryLedgerRecord[]): string {
  const steps = new Set(
    records
      .map((record) => record.group)
      .filter((group) => group.startsWith('Step ')),
  ).size
  const toolCalls = records.filter(
    (record) => record.cell.kind === 'tool' || record.cell.kind === 'subtool',
  ).length
  return [
    `${steps} ${steps === 1 ? 'step' : 'steps'}`,
    `${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`,
  ].join(' · ')
}

/** Fold collapsed turns into their first record plus a summary row. */
export function collapseTrajectoryTurns(
  records: readonly TrajectoryLedgerRecord[],
  collapsedTurns: ReadonlySet<number>,
): TrajectoryLedgerRecord[] {
  const recordsByTurn = new Map<number, TrajectoryLedgerRecord[]>()
  for (const record of records) {
    if (record.turn === null) continue
    const turnRecords = recordsByTurn.get(record.turn) ?? []
    turnRecords.push(record)
    recordsByTurn.set(record.turn, turnRecords)
  }
  return records.flatMap((record): TrajectoryLedgerRecord[] => {
    if (record.turn === null || !collapsedTurns.has(record.turn))
      return [record]
    const turnRecords = recordsByTurn.get(record.turn) ?? [record]
    if (record.cell.requestOnly === true || record.cell.kind === 'system')
      return [record]
    const contentRecords = turnRecords.filter(
      (candidate) =>
        candidate.cell.requestOnly !== true && candidate.cell.kind !== 'system',
    )
    if (contentRecords.length <= 1) return [record]
    if (record.cell.index !== contentRecords[0]?.cell.index) return []
    return [
      { ...record, turnEnd: false },
      {
        ...record,
        groupStart: false,
        turnStart: false,
        turnEnd: true,
        collapsedSummary: summarizeTurn(contentRecords.slice(1)),
        collapsedSummaryKind: 'turn',
      },
    ]
  })
}

/** Tool and subtool rows directly following one assistant record. */
export function trajectoryAssistantToolCalls(
  records: readonly TrajectoryLedgerRecord[],
  assistantIndex: number,
): readonly TrajectoryLedgerRecord[] {
  const at = records.findIndex((record) => record.cell.index === assistantIndex)
  if (at === -1 || records[at]?.cell.kind !== 'message') return []
  const calls: TrajectoryLedgerRecord[] = []
  for (let index = at + 1; index < records.length; index++) {
    const record = records[index]
    if (record === undefined) break
    if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') break
    calls.push(record)
  }
  return calls
}

function summarizeAssistantTools(
  records: readonly TrajectoryLedgerRecord[],
): string {
  const names = [
    ...new Set(
      records
        .map((record) => {
          const separator = record.cell.text.indexOf(' · ')
          return separator === -1
            ? record.cell.text
            : record.cell.text.slice(0, separator)
        })
        .filter((name) => name !== ''),
    ),
  ]
  const count = records.length
  const summary = `${count} tool ${count === 1 ? 'call' : 'calls'}`
  return names.length > 0 ? `${summary} · ${names.join(', ')}` : summary
}

/** Fold the tool rows of collapsed assistant records into one summary row. */
export function collapseTrajectoryAssistants(
  records: readonly TrajectoryLedgerRecord[],
  collapsedAssistants: ReadonlySet<string>,
): TrajectoryLedgerRecord[] {
  const out: TrajectoryLedgerRecord[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record === undefined) continue
    out.push(record)
    if (
      record.cell.kind !== 'message' ||
      !collapsedAssistants.has(trajectoryRecordId(record.cell))
    )
      continue
    const calls: TrajectoryLedgerRecord[] = []
    for (let next = index + 1; next < records.length; next++) {
      const candidate = records[next]
      if (
        candidate === undefined ||
        candidate.collapsedSummary !== undefined ||
        (candidate.cell.kind !== 'tool' && candidate.cell.kind !== 'subtool')
      )
        break
      calls.push(candidate)
    }
    if (calls.length === 0) continue
    const last = calls.at(-1)
    out[out.length - 1] = { ...record, turnEnd: false }
    out.push({
      ...record,
      groupStart: false,
      turnStart: false,
      turnEnd: last?.turnEnd ?? false,
      collapsedSummary: summarizeAssistantTools(calls),
      collapsedSummaryKind: 'assistant',
    })
    index += calls.length
  }
  return out
}

/** Fold state applied to the ledger. */
export interface TrajectoryLedgerFold {
  readonly collapsedTurns?: ReadonlySet<number>
  readonly collapsedAssistants?: ReadonlySet<string>
  /** Record indexes matching the active search (null without a query). */
  readonly searchMatches?: ReadonlySet<number> | null
}

/** Flatten, search-filter and fold the layout into display rows. */
export function deriveTrajectoryLedger(
  turns: readonly TrajectoryTurnModel[],
  fold: TrajectoryLedgerFold = {},
): TrajectoryLedgerRecord[] {
  const flat = flattenTrajectoryRecords(turns)
  const searched =
    fold.searchMatches === undefined || fold.searchMatches === null
      ? flat
      : filterTrajectoryRecords(flat, fold.searchMatches)
  const turnFolded =
    fold.collapsedTurns === undefined || fold.collapsedTurns.size === 0
      ? searched
      : collapseTrajectoryTurns(searched, fold.collapsedTurns)
  return fold.collapsedAssistants === undefined ||
    fold.collapsedAssistants.size === 0
    ? turnFolded
    : collapseTrajectoryAssistants(turnFolded, fold.collapsedAssistants)
}

/** Completion state of one record. */
export function trajectoryRecordState(
  cell: TrajectoryCellProps,
): TrajectoryRecordState {
  if (cell.isError === true) return 'error'
  if (cell.kind === 'compacted' && cell.timeSeconds === null) return 'running'
  if (
    (cell.kind === 'tool' || cell.kind === 'subtool') &&
    cell.outputDetail === undefined
  )
    return 'running'
  return 'complete'
}

/** Status label of a record state. */
export function trajectoryStatusLabel(state: TrajectoryRecordState): string {
  if (state === 'error') return 'Failed'
  if (state === 'running') return 'Pending'
  return 'Completed'
}

/** Human label of a message / context source. */
export function trajectoryMessageSourceLabel(source: unknown): string {
  if (typeof source !== 'object' || source === null || Array.isArray(source))
    return 'Unknown'
  const properties = source as Record<string, unknown>
  const kind = properties.kind
  if (kind === 'user') return 'User'
  if (kind === 'context') {
    const producer = properties.producer
    return typeof producer === 'string' && producer !== ''
      ? `Context · ${producer}`
      : 'Context'
  }
  if (kind === 'event') {
    const type = properties.type
    return typeof type === 'string' && type !== '' ? `Event · ${type}` : 'Event'
  }
  if (typeof kind !== 'string' || kind === '') return 'Unknown'
  return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`
}

/** Whether the record's content is Markdown (Preview tab). */
export function isTrajectoryMarkdownRecord(cell: TrajectoryCellProps): boolean {
  return (
    cell.kind === 'user' || cell.kind === 'context' || cell.kind === 'message'
  )
}

/** Assistant record that only requested tools. */
export function isTrajectoryToolCallOnly(cell: TrajectoryCellProps): boolean {
  return (
    cell.kind === 'message' &&
    !cell.outputDetail &&
    !cell.thinkingDetail &&
    cell.text === 'Tool call only'
  )
}

/** Markdown source of a record for the Preview / Raw tabs. */
export function trajectoryMarkdownSource(
  cell: TrajectoryCellProps,
): string | undefined {
  if (cell.kind === 'user' || cell.kind === 'context') return cell.inputDetail
  if (cell.kind === 'message' || cell.kind === 'compacted')
    return cell.outputDetail
  return undefined
}

/** One-line display text of a record. */
export function trajectoryRecordDisplayText(cell: TrajectoryCellProps): string {
  if (isTrajectoryToolCallOnly(cell)) return ''
  if (cell.previewMarkdown !== undefined) {
    const preview = trajectoryPreviewText(cell.previewMarkdown)
    if (cell.text === '') return preview
    return preview === '' ? cell.text : `${cell.text} · ${preview}`
  }
  if (cell.text !== '') return cell.text
  const markdown =
    cell.kind === 'user' || cell.kind === 'context'
      ? cell.inputDetail
      : cell.kind === 'message'
        ? (cell.outputDetail ?? cell.thinkingDetail)
        : undefined
  return markdown === undefined ? '' : trajectoryPreviewText(markdown)
}

/** One-line result text of a tool record. */
export function trajectoryRecordResultText(
  cell: TrajectoryCellProps,
): string | undefined {
  return cell.resultPreviewMarkdown === undefined
    ? cell.result
    : trajectoryPreviewText(cell.resultPreviewMarkdown)
}

/** Split a tool record's `name · args` text. */
export function trajectoryToolCallTextParts(
  kind: TrajectoryCellKind,
  text: string,
): { name: string; args?: string } | undefined {
  if (kind !== 'tool' && kind !== 'subtool') return undefined
  const separator = text.indexOf(' · ')
  if (separator === -1) return { name: text }
  return { name: text.slice(0, separator), args: text.slice(separator + 3) }
}

/** The assistant message (and parent tool of a subtool) owning a tool row. */
export function trajectoryParentRecords(
  records: readonly TrajectoryLedgerRecord[],
  record: TrajectoryLedgerRecord,
): { message?: TrajectoryLedgerRecord; tool?: TrajectoryLedgerRecord } {
  if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') return {}
  const at = records.findIndex(
    (candidate) => candidate.cell.index === record.cell.index,
  )
  if (at === -1) return {}
  let tool: TrajectoryLedgerRecord | undefined
  if (record.cell.kind === 'subtool') {
    for (let index = at - 1; index >= 0; index--) {
      const candidate = records[index]
      if (
        candidate === undefined ||
        candidate.turn !== record.turn ||
        candidate.group !== record.group
      )
        break
      if (candidate.cell.kind === 'tool') {
        tool = candidate
        break
      }
    }
  }
  const parentCallId = tool?.cell.callId ?? record.cell.callId
  const message =
    parentCallId === undefined
      ? undefined
      : records.find(
          (candidate) =>
            candidate.turn === record.turn &&
            candidate.cell.kind === 'message' &&
            candidate.cell.sourceBlocks?.some(
              (block) => block.callId === parentCallId,
            ) === true,
        )
  return {
    ...(message === undefined ? {} : { message }),
    ...(tool === undefined ? {} : { tool }),
  }
}

/** Inspector tabs of one record. */
export function trajectoryDetailTabs(
  cell: TrajectoryCellProps,
): readonly TrajectoryDetailTabItem[] {
  if (cell.kind === 'system')
    return cell.previousPromptDetail === undefined
      ? SYSTEM_PROMPT_TABS
      : SYSTEM_UPDATE_TABS
  if (cell.kind === 'compacted')
    return [
      { id: 'overview', label: 'Summary' },
      { id: 'raw', label: 'Raw' },
    ]
  if (isTrajectoryMarkdownRecord(cell))
    return [
      { id: 'overview', label: 'Summary' },
      { id: 'rendered', label: 'Preview' },
      { id: 'raw', label: 'Raw' },
      ...(cell.messageSource === undefined
        ? []
        : [{ id: 'source', label: 'Source' } as const]),
    ]
  return [
    { id: 'overview', label: 'Summary' },
    ...(cell.inputDetail ? [{ id: 'input', label: 'Payload' } as const] : []),
    ...(cell.outputDetail ? [{ id: 'output', label: 'Result' } as const] : []),
    { id: 'schema', label: 'Schema' },
    { id: 'timing', label: 'Timing' },
  ]
}
