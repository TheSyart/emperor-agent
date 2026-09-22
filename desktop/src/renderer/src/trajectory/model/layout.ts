// Trajectory list fold (ported from the dsh ui-trajectory layout): turn →
// Message / Step N / Compaction N groups → records. Expands assistant
// blocks, hangs usage on the Message record, derives own durations, adds the
// in-flight partial and running calls, and describes each group by its wall
// span and tool histogram.
//
// Emperor additions: user records show the host display text, event-derived
// context records land in their Turn/Step, tool records carry subagent /
// job / workflow facts, and assistant records carry fallback / cost-cap
// notices of their request.
import type {
  ContentBlock,
  TokenUsage,
  ToolSchema,
} from '@emperor/core/runtime-contract'
import type {
  RequestPromptChange,
  TrajectoryAssistantBlock,
  TrajectoryAssistantNode,
  TrajectoryAssistantRequest,
  TrajectoryCompactionRequest,
  TrajectoryContextNode,
  TrajectoryEventNode,
  TrajectoryLocation,
  TrajectoryPartialAssistant,
  TrajectoryRequestNotice,
  TrajectoryRequestView,
  TrajectoryRunningCall,
  TrajectoryToolCallBlock,
  TrajectoryToolFacts,
  TrajectoryToolResultNode,
} from './contract'
import type { TrajectoryCellProps, TrajectorySourceBlock } from './record'
import { formatElapsedSeconds } from './record'

/** One Message, Step or Compaction group inside a turn. */
export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
  turn: number | null
  groups: readonly TrajectoryGroupModel[]
}

/** Snapshot slice the trajectory view folds. */
export interface TrajectoryLayoutInput {
  nodes: readonly TrajectoryEventNode[]
  eventLocations?: ReadonlyMap<number, TrajectoryLocation>
  partial: TrajectoryPartialAssistant | null
  runningCalls: readonly TrajectoryRunningCall[]
  requests?: readonly TrajectoryRequestView[]
  callSchemas?: ReadonlyMap<string, ToolSchema>
}

/** Cell plus absolute ms for group wall-span descriptions. */
interface LaidCell {
  cell: TrajectoryCellProps
  absTime: number | null
  toolName?: string
  callId?: string
  subCalls?: readonly TrajectoryToolCallBlock[]
}

interface LaidGroup {
  title: string
  laid: LaidCell[]
}

interface TurnBucket {
  groups: LaidGroup[]
}

type InputNode = Extract<
  TrajectoryEventNode,
  { kind: 'user' | 'steering' | 'context' }
>

type OrderedLayoutEntry =
  | {
      kind: 'node'
      seq: number
      node: TrajectoryEventNode
      nodeIndex: number
    }
  | {
      kind: 'compaction'
      seq: number
      request: TrajectoryCompactionRequest
    }
  | {
      kind: 'system'
      seq: number
      request: TrajectoryAssistantRequest
      change: RequestPromptChange
    }
  | {
      kind: 'request'
      seq: number
      request: TrajectoryAssistantRequest
    }

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function layoutEntryOrder(entry: OrderedLayoutEntry): number {
  return entry.kind === 'system' && entry.change.kind === 'initial'
    ? Number.NEGATIVE_INFINITY
    : entry.seq
}

function inputCellDetail(
  node: InputNode,
): Pick<
  TrajectoryCellProps,
  | 'text'
  | 'previewMarkdown'
  | 'sourceSeq'
  | 'messageSource'
  | 'inputDetail'
  | 'sourceBlocks'
  | 'timeSeconds'
  | 'startedAt'
  | 'displayText'
> {
  const displayText = node.kind === 'context' ? undefined : node.displayText
  const previewMarkdown = displayText ?? previewContent(node.content)
  return {
    text: '',
    ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
    ...(displayText === undefined ? {} : { displayText }),
    sourceSeq: node.seq,
    messageSource: node.source,
    inputDetail: detailContent(node.content),
    sourceBlocks: node.content.map((block) => sourceBlock(block)),
    timeSeconds: 0,
    startedAt: finiteTime(node.time),
  }
}

function contextCell(
  node: TrajectoryContextNode,
  index: number,
): TrajectoryCellProps {
  const detail = inputCellDetail(node)
  return {
    index,
    kind: 'context',
    ...detail,
    ...(node.label === undefined ? {} : { text: node.label }),
    ...(node.eventType === undefined ? {} : { eventType: node.eventType }),
    ...(node.durationMs === undefined
      ? {}
      : { timeSeconds: Math.max(0, node.durationMs / 1000) }),
    ...(node.isError === true ? { isError: true } : {}),
  }
}

function toolFacts(
  facts: TrajectoryToolFacts & {
    readonly argsTruncated?: boolean
    readonly truncated?: boolean
    readonly callSeq?: number
    readonly kind?: string
    readonly seq?: number
  },
): Partial<TrajectoryCellProps> {
  return {
    ...(facts.argsTruncated === true ? { argsTruncated: true } : {}),
    ...(facts.argsTruncated === true && facts.callSeq !== undefined
      ? { argsEventSeq: facts.callSeq }
      : {}),
    ...(facts.truncated === true ? { resultTruncated: true } : {}),
    ...(facts.truncated === true &&
    facts.kind === 'tool-result' &&
    facts.seq !== undefined
      ? { resultEventSeq: facts.seq }
      : {}),
    ...(facts.subagent === undefined ? {} : { subagent: facts.subagent }),
    ...(facts.job === undefined ? {} : { job: facts.job }),
    ...(facts.workflow === undefined ? {} : { workflow: facts.workflow }),
    ...(facts.childSessionId === undefined
      ? {}
      : { childSessionId: facts.childSessionId }),
  }
}

/**
 * Fold a snapshot into turn → Message/Step groups with expanded cells.
 * @param input - nodes plus in-flight partial/runningCalls.
 * @returns turns ordered by first appearance.
 */
export function deriveTrajectoryLayout(
  input: TrajectoryLayoutInput,
): readonly TrajectoryTurnModel[] {
  const {
    nodes,
    eventLocations,
    partial,
    runningCalls,
    requests = [],
    callSchemas,
  } = input
  const resultByCall = indexResults(nodes)
  const callById = new Map<string, TrajectoryToolCallBlock>(resultByCall)
  for (const call of runningCalls) callById.set(call.callId, call)
  const emittedCallIds = indexAssistantCallIds(nodes)
  const followingAssistants = indexFollowingAssistants(nodes)
  const callStartById = new Map<string, number>()
  for (const result of resultByCall.values()) {
    const startedAt = finiteTime(result.callTime)
    if (startedAt !== null) callStartById.set(result.callId, startedAt)
  }
  for (const call of runningCalls) {
    const startedAt = finiteTime(call.time)
    if (startedAt !== null) callStartById.set(call.callId, startedAt)
  }
  const noticesByStep = new Map<string, readonly TrajectoryRequestNotice[]>()
  for (const request of requests) {
    if (request.purpose === 'assistant' && request.notices !== undefined)
      noticesByStep.set(stepKey(request.turn, request.step), request.notices)
  }
  const turns = new Map<number, TurnBucket>()
  const standaloneCompactions: TurnBucket[] = []
  let index = 0
  let prevAbsTime: number | null = null
  let lastAssistantTurn: number | null = null

  const bucket = (turn: number) => {
    let entry = turns.get(turn)
    if (entry === undefined) {
      entry = { groups: [] }
      turns.set(turn, entry)
    }
    return entry
  }

  const pushMessage = (turn: number, laid: LaidCell) => {
    const groups = bucket(turn).groups
    const last = groups.at(-1)
    if (last?.title === 'Message') {
      last.laid.push(laid)
      return
    }
    groups.push({ title: 'Message', laid: [laid] })
  }
  const pushStep = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = `Step ${step}`
    const existing = groups.find((group) => group.title === title)
    if (existing !== undefined) {
      existing.laid.push(...laid)
      return
    }
    groups.push({ title, laid: [...laid] })
  }
  const pushStepInput = (
    turn: number,
    step: number,
    laid: readonly LaidCell[],
  ) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = `Step ${step}`
    const existing = groups.find((group) => group.title === title)
    if (existing === undefined) {
      groups.push({ title, laid: [...laid] })
      return
    }
    const request = existing.laid.findIndex(
      (entry) => entry.cell.requestOnly === true,
    )
    if (request === -1) existing.laid.push(...laid)
    else existing.laid.splice(request, 0, ...laid)
  }

  const representedRequests = new Set<string>()
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.step > 0)
      representedRequests.add(stepKey(node.turn, node.step))
  }
  if (partial !== null && partial.step > 0)
    representedRequests.add(stepKey(partial.turn, partial.step))
  for (const call of runningCalls) {
    if (call.step > 0) representedRequests.add(stepKey(call.turn, call.step))
  }

  const entries: OrderedLayoutEntry[] = [
    ...nodes.map((node, nodeIndex) => ({
      kind: 'node' as const,
      seq: node.seq,
      node,
      nodeIndex,
    })),
    ...requests
      .filter(
        (request): request is TrajectoryCompactionRequest =>
          request.purpose === 'compaction',
      )
      .map((request) => ({
        kind: 'compaction' as const,
        seq: request.startSeq,
        request,
      })),
    ...requests.flatMap((request) =>
      request.purpose !== 'assistant' ||
      request.promptChange === undefined ||
      request.prompt === undefined
        ? []
        : [
            {
              kind: 'system' as const,
              seq: request.promptChange.seq,
              request,
              change: request.promptChange,
            },
          ],
    ),
    ...requests
      .filter(
        (request): request is TrajectoryAssistantRequest =>
          request.purpose === 'assistant',
      )
      .filter(
        (request) =>
          !representedRequests.has(stepKey(request.turn, request.step)),
      )
      .map((request) => ({
        kind: 'request' as const,
        seq: request.startSeq,
        request,
      })),
  ].sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right))

  for (const entry of entries) {
    if (entry.kind === 'request') {
      const { request } = entry
      pushStep(request.turn, request.step, [
        {
          absTime: finiteTime(request.startedAt),
          cell: {
            index: ++index,
            kind: 'message',
            text: '',
            sourceSeq: request.startSeq,
            requestOnly: true,
            timeSeconds:
              request.completedAt === null
                ? null
                : durationSeconds(request.completedAt, request.startedAt),
            startedAt: finiteTime(request.startedAt),
            ...(request.status === 'error' ? { isError: true } : {}),
            ...(request.notices === undefined
              ? {}
              : { notices: request.notices }),
          },
        },
      ])
      prevAbsTime =
        finiteTime(request.completedAt) ??
        finiteTime(request.startedAt) ??
        prevAbsTime
      continue
    }
    if (entry.kind === 'system') {
      const { change, request } = entry
      const turn =
        change.kind === 'initial'
          ? firstVisibleTurn(nodes, partial)
          : enclosingPromptTurn(nodes, change.seq, partial)
      pushMessage(turn, {
        absTime: finiteTime(change.time),
        cell: {
          index: ++index,
          kind: 'system',
          text: promptChangeLabel(change),
          sourceSeq: change.seq,
          ...(request.prompt === undefined
            ? {}
            : { promptDetail: request.prompt }),
          ...(change.previous === undefined
            ? {}
            : { previousPromptDetail: change.previous }),
          timeSeconds: 0,
          startedAt: finiteTime(change.time),
        },
      })
      prevAbsTime = finiteTime(change.time) ?? prevAbsTime
      continue
    }
    if (entry.kind === 'compaction') {
      const request = entry.request
      const rawOutput = request.summary
      const thinkingDetail =
        rawOutput === undefined ? '' : detailReasoning(rawOutput)
      const cell: TrajectoryCellProps = {
        index: ++index,
        kind: 'compacted',
        text:
          request.status === 'running'
            ? 'Compacting context…'
            : request.status === 'error'
              ? (request.error ?? 'Compaction failed')
              : request.summary === undefined
                ? 'Context compacted'
                : '',
        ...(request.status === 'complete' && request.summary !== undefined
          ? previewContentProperty(request.summary)
          : {}),
        sourceSeq: request.startSeq,
        ...(request.summary === undefined
          ? {}
          : {
              outputDetail: detailContent(request.summary),
              outputBlocks: request.summary.map((block) => sourceBlock(block)),
            }),
        ...(thinkingDetail === '' ? {} : { thinkingDetail }),
        ...(rawOutput === undefined
          ? {}
          : { sourceBlocks: rawOutput.map((block) => sourceBlock(block)) }),
        ...(request.status === 'error' ? { isError: true } : {}),
        timeSeconds:
          request.completedAt === null
            ? null
            : durationSeconds(request.completedAt, request.startedAt),
        startedAt: finiteTime(request.startedAt),
      }
      attachUsage(cell, request.usage)
      const compaction: TurnBucket = {
        groups: [
          {
            title: `Compaction ${request.startSeq}`,
            laid: [{ absTime: finiteTime(request.startedAt), cell }],
          },
        ],
      }
      if (request.turn === null) standaloneCompactions.push(compaction)
      else bucket(request.turn).groups.push(...compaction.groups)
      prevAbsTime =
        finiteTime(request.completedAt) ??
        finiteTime(request.startedAt) ??
        prevAbsTime
      continue
    }
    const { node, nodeIndex: i } = entry
    if (node.kind === 'user') {
      // user/message placement: enclose it in the next assistant (or
      // partial) turn, else open the turn after the last assistant.
      const turn = enclosingUserTurn(
        followingAssistants[i],
        partial,
        lastAssistantTurn,
      )
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'user',
          ...inputCellDetail(node),
          opensTurn: true,
        },
      })
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'steering') {
      const placement = steeringPlacement(
        followingAssistants[i],
        partial,
        lastAssistantTurn,
        eventLocations?.get(node.seq),
      )
      const laid = {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'user' as const,
          ...inputCellDetail(node),
        },
      }
      if (placement.step === undefined) pushMessage(placement.turn, laid)
      else pushStepInput(placement.turn, placement.step, [laid])
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'assistant') {
      const laidList = withSubCalls(
        expandAssistant(
          node,
          index + 1,
          prevAbsTime,
          resultByCall,
          callStartById,
          callById,
          { notices: noticesByStep.get(stepKey(node.turn, node.step)) },
        ),
      )
      if (node.step > 0) pushStep(node.turn, node.step, laidList)
      else for (const laid of laidList) pushMessage(node.turn, laid)
      const last = laidList[laidList.length - 1]
      if (last !== undefined) index = last.cell.index
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      lastAssistantTurn = node.turn
      continue
    }
    if (node.kind === 'context') {
      const laid = {
        absTime: finiteTime(node.time),
        cell: contextCell(node, ++index),
      }
      const location = eventLocations?.get(node.seq)
      if (node.origin === 'event' && location?.kind === 'step')
        pushStepInput(location.turn, location.step, [laid])
      else if (node.origin === 'event' && location?.kind === 'turn')
        pushMessage(location.turn, laid)
      else
        pushMessage(
          enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn),
          laid,
        )
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (!emittedCallIds.has(node.callId)) {
      const toolName = node.call?.name
      const resultPreview = summarizeResult(node)
      const laidList: LaidCell[] = [
        {
          absTime: finiteTime(node.callTime ?? node.time),
          ...(toolName !== undefined ? { toolName } : {}),
          callId: node.callId,
          subCalls: node.subCalls,
          cell: {
            index: ++index,
            kind: 'tool',
            sourceSeq: node.seq,
            ...(node.call !== null
              ? summarizeCall(node.call.name, node.call.argsRaw)
              : resultAsText(resultPreview)),
            ...(node.call !== null ? { inputDetail: node.call.argsRaw } : {}),
            outputDetail: detailResult(node),
            outputBlocks: node.content.map((block) => sourceBlock(block)),
            ...resultPreview,
            callId: node.callId,
            isError: node.isError,
            timeSeconds: durationSeconds(node.time, node.callTime),
            startedAt: finiteTime(node.callTime),
            ...toolFacts(node),
          },
        },
      ]
      for (const laid of expandSubCalls(node.subCalls, index)) {
        laidList.push(laid)
        index = laid.cell.index
      }
      pushStep(0, 1, laidList)
    }
    prevAbsTime = finiteTime(node.time) ?? prevAbsTime
  }

  if (partial !== null) {
    const fake: TrajectoryAssistantNode = {
      kind: 'assistant',
      seq: Number.MAX_SAFE_INTEGER,
      time: 0,
      turn: partial.turn,
      step: partial.step,
      blocks: partial.blocks,
    }
    const laidList = withSubCalls(
      expandAssistant(
        fake,
        index + 1,
        prevAbsTime,
        resultByCall,
        callStartById,
        callById,
        {
          streaming: true,
          notices: noticesByStep.get(stepKey(partial.turn, partial.step)),
        },
      ),
    )
    if (partial.step > 0) pushStep(partial.turn, partial.step, laidList)
    else for (const laid of laidList) pushMessage(partial.turn, laid)
    const last = laidList[laidList.length - 1]
    if (last !== undefined) index = last.cell.index
  }

  const seenCalls = collectCallIds(turns)
  for (const call of runningCalls) {
    if (seenCalls.has(call.callId)) continue
    const laidList: LaidCell[] = [
      {
        absTime: null,
        toolName: call.name,
        callId: call.callId,
        subCalls: call.subCalls,
        cell: {
          index: ++index,
          kind: 'tool',
          ...summarizeCall(call.name, call.argsRaw),
          inputDetail: call.argsRaw,
          callId: call.callId,
          timeSeconds: null,
          startedAt: finiteTime(call.time),
          ...toolFacts(call),
        },
      },
    ]
    for (const laid of expandSubCalls(call.subCalls, index)) {
      laidList.push(laid)
      index = laid.cell.index
    }
    if (call.step > 0) pushStep(call.turn, call.step, laidList)
    else for (const laid of laidList) pushMessage(call.turn, laid)
  }

  // Orphan turn-0 cells (orphaned tools) fold into Turn 1.
  const prologue = turns.get(0)
  if (prologue !== undefined) {
    turns.delete(0)
    const first = turns.get(1) ?? { groups: [] }
    first.groups = [...prologue.groups, ...first.groups]
    turns.set(1, first)
  }

  for (const entry of [...turns.values(), ...standaloneCompactions]) {
    for (const group of entry.groups) {
      for (const laid of group.laid) attachToolSchema(laid, callSchemas)
    }
  }

  return [
    ...[...turns.entries()].map(([turn, entry]) => toTurnModel(turn, entry)),
    ...standaloneCompactions.map((entry) => toTurnModel(null, entry)),
  ].sort((left, right) => firstCellIndex(left) - firstCellIndex(right))
}

/**
 * Append the changing in-flight assistant cells to a stable finalized layout.
 * @param turns - Finalized layout derived with an empty-block partial anchor.
 * @param partial - Current in-flight assistant projection.
 * @param lastIndex - Highest cell index in the finalized layout.
 * @returns The original layout without a partial, otherwise a layout sharing every unaffected turn.
 */
export function appendTrajectoryPartialLayout(
  turns: readonly TrajectoryTurnModel[],
  partial: TrajectoryPartialAssistant | null,
  lastIndex: number,
): readonly TrajectoryTurnModel[] {
  if (partial === null) return turns
  const partialTurn = deriveTrajectoryLayout({
    nodes: [],
    partial,
    runningCalls: [],
  }).at(0)
  if (partialTurn === undefined) return turns
  const streamed: TrajectoryTurnModel = {
    ...partialTurn,
    groups: partialTurn.groups.map((group) => ({
      ...group,
      cells: group.cells.map((cell) => ({
        ...cell,
        index: cell.index + lastIndex,
      })),
    })),
  }
  const turnIndex = turns.findIndex((turn) => turn.turn === streamed.turn)
  if (turnIndex === -1) return [...turns, streamed]
  const current = turns[turnIndex]
  if (current === undefined) return turns
  const groups = [...current.groups]
  for (const streamedGroup of streamed.groups) {
    const groupIndex = groups.findIndex(
      (group) => group.title === streamedGroup.title,
    )
    if (groupIndex === -1) {
      groups.push(streamedGroup)
      continue
    }
    const group = groups[groupIndex]
    if (group === undefined) continue
    const streamedCallIds = new Set(
      streamedGroup.cells.flatMap((cell) =>
        cell.callId === undefined ? [] : [cell.callId],
      ),
    )
    groups[groupIndex] = {
      ...streamedGroup,
      cells: [
        ...group.cells.filter(
          (cell) =>
            cell.requestOnly !== true &&
            (cell.callId === undefined || !streamedCallIds.has(cell.callId)),
        ),
        ...streamedGroup.cells,
      ],
    }
  }
  const updated = [...turns]
  updated[turnIndex] = { ...current, groups }
  return updated
}

function attachToolSchema(
  laid: LaidCell,
  callSchemas: ReadonlyMap<string, ToolSchema> | undefined,
): void {
  if (laid.callId === undefined || callSchemas === undefined) return
  const schema = callSchemas.get(laid.callId)
  if (schema === undefined) return
  laid.cell.schemaDetail = JSON.stringify(schema, null, 2)
}

function toTurnModel(
  turn: number | null,
  entry: TurnBucket,
): TrajectoryTurnModel {
  const groups = entry.groups.map(({ title, laid }): TrajectoryGroupModel => {
    const description = groupDescription(laid)
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map((l) => l.cell),
    }
  })
  return { turn, groups }
}

/** Chronological section position from the fold's monotonically assigned cell indexes. */
function firstCellIndex(turn: TrajectoryTurnModel): number {
  return Math.min(
    ...turn.groups.flatMap((group) => group.cells.map((cell) => cell.index)),
    Number.POSITIVE_INFINITY,
  )
}

/** Wall-span duration + tool histogram, e.g. `1,500 ms bash×6`. */
function groupDescription(laid: readonly LaidCell[]): string | undefined {
  const parts: string[] = []
  // Tool rows contribute start (absTime) and end (start + own duration) so a
  // single Tool cell still spans call→result for the group wall clock.
  const times: number[] = []
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue
    times.push(l.absTime)
    if (
      l.cell.kind === 'tool' &&
      l.cell.timeSeconds !== null &&
      Number.isFinite(l.cell.timeSeconds)
    )
      times.push(l.absTime + l.cell.timeSeconds * 1000)
  }
  if (times.length >= 2) {
    const span = formatGroupDuration(
      (Math.max(...times) - Math.min(...times)) / 1000,
    )
    if (span !== undefined) parts.push(span)
  } else if (times.length === 1) {
    const own = laid.find((l) => l.absTime === times[0])?.cell.timeSeconds
    const span =
      own !== null && own !== undefined ? formatGroupDuration(own) : undefined
    if (span !== undefined) parts.push(span)
  }
  const tools = new Map<string, number>()
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== 'tool') continue
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1)
  }
  for (const [name, count] of tools)
    parts.push(count > 1 ? `${name}×${count}` : name)
  return parts.length === 0 ? undefined : parts.join(' ')
}

function formatGroupDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined
  return formatElapsedSeconds(seconds)
}

/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
function durationSeconds(later: number, earlier: number | null): number | null {
  if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier))
    return null
  return Math.max(0, (later - earlier) / 1000)
}

/** Epoch-ms usable as an absolute time, else null. */
function finiteTime(time: number | null | undefined): number | null {
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

function expandAssistant(
  node: TrajectoryAssistantNode,
  startIndex: number,
  prevAbsTime: number | null,
  results: ReadonlyMap<string, TrajectoryToolResultNode>,
  callStarts: ReadonlyMap<string, number>,
  calls: ReadonlyMap<string, TrajectoryToolCallBlock>,
  opts: {
    streaming?: boolean
    notices?: readonly TrajectoryRequestNotice[] | undefined
  } = {},
): LaidCell[] {
  const streaming = opts.streaming === true
  if (streaming && node.blocks.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex - 1
  const usage = node.usage
  const recordedStart = finiteTime(node.timing?.stepStartTime)
  const messageDuration = streaming
    ? null
    : durationSeconds(node.time, recordedStart ?? prevAbsTime)
  const nodeAbs = streaming ? null : finiteTime(node.time)
  const messageText = node.blocks
    .filter(
      (block) => block.kind === 'text' && (!streaming || block.text !== ''),
    )
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('\n\n')
  const thinkingText = node.blocks
    .filter(
      (block) =>
        block.kind === 'reasoning' && (!streaming || block.text !== ''),
    )
    .map((block) => (block.kind === 'reasoning' ? block.text : ''))
    .join('\n\n')
  const message: TrajectoryCellProps = {
    index: ++index,
    recordId: `assistant\u0000${node.turn}\u0000${node.step}`,
    kind: 'message',
    sourceSeq: node.seq,
    text:
      messageText !== '' || thinkingText !== ''
        ? ''
        : summarizeAssistantActivity(node.blocks),
    ...(messageText !== ''
      ? { previewMarkdown: messageText }
      : thinkingText !== ''
        ? { previewMarkdown: thinkingText }
        : {}),
    ...(messageText !== '' ? { outputDetail: messageText } : {}),
    ...(thinkingText !== '' ? { thinkingDetail: thinkingText } : {}),
    sourceBlocks: node.blocks.map((block) => assistantSourceBlock(block)),
    timeSeconds: messageDuration,
    startedAt: recordedStart,
    ...(opts.notices === undefined ? {} : { notices: opts.notices }),
  }
  attachUsage(message, usage)
  message.assistantMetrics = {
    timingRecorded: node.timing !== undefined,
    stepStartTime: node.timing?.stepStartTime ?? null,
    firstTokenTime: node.timing?.firstTokenTime ?? null,
    completedTime: streaming ? null : finiteTime(node.time),
    usageProvided: usage !== undefined,
    outputTokens:
      usage !== undefined && Number.isFinite(usage.outputTokens)
        ? usage.outputTokens
        : null,
  }
  out.push({ absTime: nodeAbs, cell: message })

  for (const block of node.blocks) {
    // Text and reasoning belong to the one Assistant record emitted above.
    if (block.kind !== 'tool-call') continue
    const result = results.get(block.callId)
    const toolDuration =
      streaming || result === undefined
        ? null
        : durationSeconds(result.time, result.callTime)
    const callAbs = finiteTime(callStarts.get(block.callId))
    const call = calls.get(block.callId)
    const resultPreview =
      result === undefined ? undefined : summarizeResult(result)
    out.push({
      absTime: callAbs,
      toolName: block.name,
      callId: block.callId,
      ...(call === undefined ? {} : { subCalls: call.subCalls }),
      cell: {
        index: ++index,
        kind: 'tool',
        ...summarizeCall(block.name, block.argsRaw),
        inputDetail: block.argsRaw,
        callId: block.callId,
        ...(result !== undefined
          ? {
              outputDetail: detailResult(result),
              outputBlocks: result.content.map((item) => sourceBlock(item)),
              ...resultPreview,
              isError: result.isError,
              ...(result.truncated === true
                ? { resultTruncated: true, resultEventSeq: result.seq }
                : {}),
            }
          : {}),
        timeSeconds: toolDuration,
        startedAt: callAbs,
        ...(call === undefined ? {} : toolFacts(call)),
      },
    })
  }
  return out
}

function summarizeAssistantActivity(
  blocks: readonly TrajectoryAssistantBlock[],
): string {
  return blocks.some((block) => block.kind === 'tool-call')
    ? 'Tool call only'
    : ''
}

function promptChangeLabel(change: RequestPromptChange): string {
  if (change.kind === 'initial') return 'Initial System Prompt'
  if (change.kind === 'system') return 'System Prompt Updated'
  if (change.kind === 'tools') return 'Tools Updated'
  return 'System Prompt and Tools Updated'
}

function assistantSourceBlock(
  block: TrajectoryAssistantBlock,
): TrajectorySourceBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', content: block.text }
    case 'reasoning':
      return { type: 'thinking', content: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        content: block.argsRaw,
        callId: block.callId,
        toolName: block.name,
      }
    // Attachment refs carry no fetchable bytes, so the record shows the
    // durable metadata instead of an inline preview.
    case 'image':
      return { type: 'image', content: stringifySourceValue(block.attachment) }
    case 'other':
      return sourceBlock(block.block)
  }
}

function sourceBlock(value: unknown): TrajectorySourceBlock {
  if (typeof value !== 'object' || value === null)
    return { type: 'unknown', content: stringifySourceValue(value) }
  const block = value as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  if (typeof block.text === 'string')
    return {
      type: type === 'reasoning' ? 'thinking' : type,
      content: block.text,
    }
  const imageSrc = sourceImage(block)
  const imageAlt = typeof block.alt === 'string' ? block.alt : undefined
  return {
    type,
    content: imageSrc === undefined ? stringifySourceValue(value) : '',
    ...(imageSrc !== undefined ? { imageSrc } : {}),
    ...(imageAlt !== undefined ? { imageAlt } : {}),
  }
}

function sourceImage(block: Record<string, unknown>): string | undefined {
  if (
    typeof block.type !== 'string' ||
    !block.type.toLowerCase().includes('image')
  )
    return undefined
  for (const candidate of [block.url, block.image_url]) {
    if (typeof candidate === 'string') return safeImageSource(candidate)
  }
  if (typeof block.data === 'string') {
    const mediaType =
      [block.mimeType, block.mediaType, block.media_type].find(
        (candidate): candidate is string => typeof candidate === 'string',
      ) ?? 'image/png'
    return safeImageSource(
      block.data.startsWith('data:')
        ? block.data
        : `data:${mediaType};base64,${block.data}`,
    )
  }
  if (typeof block.source !== 'object' || block.source === null)
    return undefined
  const source = block.source as Record<string, unknown>
  if (typeof source.url === 'string') return safeImageSource(source.url)
  if (typeof source.data !== 'string') return undefined
  const mediaType =
    typeof source.media_type === 'string' ? source.media_type : 'image/png'
  return safeImageSource(`data:${mediaType};base64,${source.data}`)
}

function safeImageSource(value: string): string | undefined {
  if (value.startsWith('data:image/') || value.startsWith('blob:')) return value
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

function stringifySourceValue(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json || String(value)
}

/**
 * Turn that encloses an input message: next assistant turn, else the
 * in-flight partial, else the turn after the last finalized assistant (or 1).
 */
function enclosingUserTurn(
  followingAssistant: TrajectoryAssistantNode | undefined,
  partial: TrajectoryPartialAssistant | null,
  lastAssistantTurn: number | null,
): number {
  if (followingAssistant !== undefined) return followingAssistant.turn
  if (partial !== null) return partial.turn
  if (lastAssistantTurn !== null) return lastAssistantTurn + 1
  return 1
}

function steeringPlacement(
  followingAssistant: TrajectoryAssistantNode | undefined,
  partial: TrajectoryPartialAssistant | null,
  lastAssistantTurn: number | null,
  location: TrajectoryLocation | undefined,
): { turn: number; step?: number } {
  if (location?.kind === 'step')
    return { turn: location.turn, step: location.step }
  const locatedTurn = location?.kind === 'turn' ? location.turn : undefined
  if (
    followingAssistant !== undefined &&
    (locatedTurn === undefined || followingAssistant.turn === locatedTurn)
  )
    return {
      turn: followingAssistant.turn,
      ...(followingAssistant.step > 0 ? { step: followingAssistant.step } : {}),
    }
  if (
    partial !== null &&
    (locatedTurn === undefined || partial.turn === locatedTurn)
  )
    return {
      turn: partial.turn,
      ...(partial.step > 0 ? { step: partial.step } : {}),
    }
  if (locatedTurn !== undefined) return { turn: locatedTurn }
  return { turn: lastAssistantTurn ?? 1 }
}

function indexFollowingAssistants(
  nodes: readonly TrajectoryEventNode[],
): readonly (TrajectoryAssistantNode | undefined)[] {
  const following = new Array<TrajectoryAssistantNode | undefined>(nodes.length)
  let assistant: TrajectoryAssistantNode | undefined
  for (let index = nodes.length - 1; index >= 0; index--) {
    following[index] = assistant
    const node = nodes[index]
    if (node?.kind === 'assistant') assistant = node
  }
  return following
}

function enclosingPromptTurn(
  nodes: readonly TrajectoryEventNode[],
  seq: number,
  partial: TrajectoryPartialAssistant | null,
): number {
  const next = nodes.find(
    (node) => node.seq > seq && node.kind === 'assistant' && node.step > 0,
  )
  if (next?.kind === 'assistant') return next.turn
  return partial?.turn ?? 1
}

/** Earliest raw turn represented by the loaded window. */
function firstVisibleTurn(
  nodes: readonly TrajectoryEventNode[],
  partial: TrajectoryPartialAssistant | null,
): number {
  const turns = nodes.flatMap((node) =>
    node.kind === 'assistant' && node.turn > 0 ? [node.turn] : [],
  )
  if (partial !== null && partial.turn > 0) turns.push(partial.turn)
  return turns.length === 0 ? 1 : Math.min(...turns)
}

/** Copy provider usage onto a Message cell when present. */
function attachUsage(
  cell: TrajectoryCellProps,
  usage: Partial<TokenUsage> | undefined,
): void {
  if (usage === undefined) return
  if (usage.inputTokens !== undefined) cell.input = usage.inputTokens
  if (usage.cacheReadTokens !== undefined)
    cell.cacheRead = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined)
    cell.cacheWrite = usage.cacheWriteTokens
  if (usage.outputTokens !== undefined) cell.output = usage.outputTokens
  if (usage.reasoningTokens !== undefined) cell.think = usage.reasoningTokens
}

function indexResults(
  nodes: readonly TrajectoryEventNode[],
): Map<string, TrajectoryToolResultNode> {
  const map = new Map<string, TrajectoryToolResultNode>()
  for (const node of nodes) {
    if (node.kind === 'tool-result') map.set(node.callId, node)
  }
  return map
}

function indexAssistantCallIds(
  nodes: readonly TrajectoryEventNode[],
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    for (const block of node.blocks) {
      if (block.kind === 'tool-call') ids.add(block.callId)
    }
  }
  return ids
}

function collectCallIds(turns: Map<number, TurnBucket>): Set<string> {
  const ids = new Set<string>()
  for (const entry of turns.values()) {
    for (const group of entry.groups) {
      for (const laid of group.laid) {
        if (laid.callId !== undefined) ids.add(laid.callId)
      }
    }
  }
  return ids
}

/** Interleave each tool cell's nested child calls right after it, reindexing followers. */
function withSubCalls(laidList: LaidCell[]): LaidCell[] {
  if (
    !laidList.some(
      (laid) => laid.subCalls !== undefined && laid.subCalls.length > 0,
    )
  )
    return laidList
  const out: LaidCell[] = []
  let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0
  for (const laid of laidList) {
    out.push({ ...laid, cell: { ...laid.cell, index: ++index } })
    for (const sub of expandSubCalls(laid.subCalls, index)) {
      out.push(sub)
      index = sub.cell.index
    }
  }
  return out
}

/** Child cells (jobs, workflow members) in start order (running = null duration). */
function expandSubCalls(
  subs: readonly TrajectoryToolCallBlock[] | undefined,
  startIndex: number,
): LaidCell[] {
  if (subs === undefined || subs.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex
  for (const sub of subs) {
    const settled = 'kind' in sub
    const resultPreview = settled ? summarizeResult(sub) : undefined
    const laid: LaidCell = {
      absTime: settled
        ? finiteTime(sub.callTime ?? sub.time)
        : finiteTime(sub.time),
      toolName: settled ? (sub.call?.name ?? sub.callId) : sub.name,
      callId: sub.callId,
      cell: {
        index: ++index,
        kind: 'subtool',
        callId: sub.callId,
        ...(settled
          ? sub.call !== null
            ? summarizeCall(sub.call.name, sub.call.argsRaw)
            : resultAsText(resultPreview)
          : summarizeCall(sub.name, sub.argsRaw)),
        ...(settled
          ? sub.call !== null
            ? { inputDetail: sub.call.argsRaw }
            : {}
          : { inputDetail: sub.argsRaw }),
        ...(settled
          ? {
              outputDetail: detailResult(sub),
              outputBlocks: sub.content.map((block) => sourceBlock(block)),
              ...resultPreview,
              isError: sub.isError,
            }
          : {}),
        // A running (unsettled) child shows the em dash.
        timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
        startedAt: settled ? finiteTime(sub.callTime) : finiteTime(sub.time),
        ...toolFacts(sub),
      },
    }
    out.push(laid)
    for (const child of expandSubCalls(sub.subCalls, index)) {
      out.push(child)
      index = child.cell.index
    }
  }
  return out
}

function summarizeCall(
  name: string,
  argsRaw: string,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return { text: name, ...(argsRaw === '' ? {} : { previewMarkdown: argsRaw }) }
}

function summarizeResult(
  node: TrajectoryToolResultNode,
): Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> {
  if (node.isError) return { result: node.error?.code ?? 'error' }
  for (const block of node.content) {
    if (block.type === 'text' && block.text !== '')
      return { result: '', resultPreviewMarkdown: block.text }
  }
  return { result: 'No output' }
}

function resultAsText(
  result:
    Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> | undefined,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return {
    text: result?.result ?? '',
    ...(result?.resultPreviewMarkdown === undefined
      ? {}
      : { previewMarkdown: result.resultPreviewMarkdown }),
  }
}

function detailResult(node: TrajectoryToolResultNode): string {
  if (node.isError) {
    const text = detailContent(node.content)
    const error =
      node.error === undefined
        ? 'error'
        : `${node.error.name}: ${node.error.code}`
    return text === '' ? error : `${error}\n${text}`
  }
  const text = detailContent(node.content)
  if (text !== '') return text
  if (
    node.content.length === 0 ||
    node.content.every((block) => block.type === 'text' && block.text === '')
  )
    return 'No output'
  return JSON.stringify(node.content, null, 2)
}

function detailContent(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : undefined))
    .filter((text): text is string => text !== undefined)
    .join('\n')
}

function detailReasoning(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'reasoning' ? block.text : undefined))
    .filter((text): text is string => text !== undefined)
    .join('\n')
}

function previewContent(content: readonly ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === 'text') return block.text
  }
  return undefined
}

function previewContentProperty(
  content: readonly ContentBlock[],
): Pick<TrajectoryCellProps, 'previewMarkdown'> {
  const previewMarkdown = previewContent(content)
  return previewMarkdown === undefined ? {} : { previewMarkdown }
}
