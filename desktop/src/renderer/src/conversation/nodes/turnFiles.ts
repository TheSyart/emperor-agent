// The files a task changed (E-track contract §5, UI-S15): `turn/files`
// written by the host once the task is over — a message the user sent and
// every turn a subagent's or job's result woke — under the task's last
// turn; `turn/files-reverted` once it is undone. Older logs hold one record
// per turn. The card sits just before that turn's footer, which stays the
// turn's last row (UI-S13), even when the record lands after the next turn
// began (the snapshot takes a moment, and the user's next message ends a
// task that still had work running).
import type {
  TurnFilesRecord,
  TurnFilesReverted,
} from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationMatch,
  ConversationNodeContext,
} from '../assembler'
import { isEvent } from '../events'
import type { TurnFilesChatData } from '../types'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common'

interface TurnFilesState {
  /** `turn/end` of the turn (the card's anchor). */
  readonly endSeq: number | null
  readonly record: {
    readonly seq: number
    readonly data: TurnFilesRecord
  } | null
  readonly reverted: TurnFilesReverted | null
}

function turnOf(data: unknown): number | undefined {
  const turn = (data as { turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

function apply(
  state: TurnFilesState,
  match: ConversationMatch,
): TurnFilesState {
  const event = match.event
  if (isEvent(event, 'turn/files'))
    return { ...state, record: { seq: event.seq, data: event.data } }
  if (isEvent(event, 'turn/files-reverted'))
    return { ...state, reverted: event.data }
  return state
}

function fallback(
  context: ConversationNodeContext<TurnFilesState>,
): TurnFilesState {
  let state: TurnFilesState = { endSeq: null, record: null, reverted: null }
  for (const match of context.matches) state = apply(state, match)
  return state
}

function viewData(state: TurnFilesState): TurnFilesChatData | null {
  const record = state.record?.data
  if (record === undefined) return null
  return {
    turn: record.turn,
    ...(record.task === undefined
      ? {}
      : {
          task: {
            firstTurn: record.task.firstTurn,
            lastTurn: record.task.lastTurn,
          },
        }),
    mode: record.mode,
    status: record.status,
    ...(record.skipReason === undefined
      ? {}
      : { skipReason: record.skipReason }),
    files: record.files,
    totals: record.totals,
    truncated: record.truncated === true,
    concurrent: record.concurrent === true,
    reviewable:
      record.mode === 'git' &&
      record.status === 'recorded' &&
      record.snapshot !== undefined,
    ...(state.reverted === null
      ? {}
      : {
          reverted: {
            reverted: state.reverted.reverted,
            skipped: state.reverted.skipped,
          },
        }),
  }
}

/** The 「已编辑 N 个文件」 card of one task (one turn in older logs). */
export const turnFilesDefinition: ConversationDefinition<TurnFilesState> = {
  kind: 'turnFiles',
  target: 'chat',
  match: (event) => {
    if (
      event.type !== 'turn/end' &&
      event.type !== 'turn/files' &&
      event.type !== 'turn/files-reverted'
    )
      return null
    const turn = turnOf(event.data)
    if (turn === undefined) return null
    return {
      id: String(turn),
      role: event.type === 'turn/end' ? 'start' : 'update',
    }
  },
  start: (_context, match) => ({
    endSeq: match.event.seq,
    record: null,
    reverted: null,
  }),
  update: (context, match) => apply(context.state, match),
  buildViewNode: (context) => {
    const state = context.state ?? fallback(context)
    const data = viewData(state)
    if (data === null || state.record === null) return null
    // Just before the turn's footer (anchored at turn/end).
    const anchor =
      (state.endSeq ?? state.record.seq) + CHAT_SYNTHETIC_SEQ_OFFSETS.turnFiles
    return chatNode(context, 'turnFiles', anchor, data)
  },
}
