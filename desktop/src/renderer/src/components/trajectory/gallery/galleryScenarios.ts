// Dev-only trajectory gallery fixtures built from the recorded raw kernel
// log (packages/core harness projection golden): the log itself, a "rich"
// three-turn variant (changed request header → Diff tab, wire-truncated
// and failed tool results, a subagent child session, a trailing
// compaction), a "long" variant (~5,000 ledger records, virtualized) and a
// "live" variant replaying turn 3 progressively (running playhead).
import type {
  SessionHistoryPage,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import kernelLog from '../../../../../../../packages/core/src/harness/projection/__golden__/kernel-turn.log.json'

interface KernelLog {
  readonly root: SessionHistoryPage
  readonly children: readonly SessionHistoryPage[]
}

/** One fixture session (history log plus optional live tail). */
export interface GallerySession {
  readonly id: string
  readonly events: readonly WireSessionEvent[]
  readonly live?: readonly WireSessionEvent[]
  readonly origin?: 'subagent'
}

export interface GalleryScenario {
  readonly id: string
  readonly label: string
  readonly sessions: readonly GallerySession[]
}

const LOG = kernelLog as unknown as KernelLog
const ROOT = LOG.root.events
/** Session preface (permission / sandbox / approval facts). */
const PREFACE = ROOT.filter((event) => event.seq < 3)
/** One complete turn (user meta → turn/end). */
const TURN = ROOT.filter((event) => event.seq >= 3 && event.seq <= 74)
/** Trailing manual compaction. */
const COMPACTION = ROOT.filter((event) => event.seq >= 75)
const TURN_SPAN_MS = 9_000

type Mutable = Record<string, unknown>

function remapTurn(value: unknown, turn: number): unknown {
  if (Array.isArray(value)) return value.map((item) => remapTurn(item, turn))
  if (typeof value !== 'object' || value === null) return value
  const out: Mutable = {}
  for (const [key, item] of Object.entries(value as Mutable))
    out[key] = key === 'turn' && item === 1 ? turn : remapTurn(item, turn)
  return out
}

/** Copy of the template turn as turn `turn` with unique ids. */
function turnEvents(turn: number): WireSessionEvent[] {
  // Turn 1 keeps the recorded ids so its subagent call opens the child.
  if (turn === 1) return structuredClone([...TURN])
  const text = JSON.stringify(TURN)
    .replaceAll('call_', `t${turn}_call_`)
    .replaceAll('<id', `<t${turn}id`)
  return remapTurn(JSON.parse(text), turn) as WireSessionEvent[]
}

/** Renumber a concatenated log (seq ascending, time shifted per block). */
function sequence(
  blocks: readonly (readonly WireSessionEvent[])[],
): WireSessionEvent[] {
  const out: WireSessionEvent[] = []
  let seq = 0
  blocks.forEach((block, blockIndex) => {
    const base = block[0]?.time ?? 0
    for (const event of block) {
      const shifted = {
        ...event,
        seq: seq++,
        time:
          1_700_000_000_000 + blockIndex * TURN_SPAN_MS + (event.time - base),
      } as WireSessionEvent & { sourceEventSeqs?: number[] }
      delete shifted.sourceEventSeqs
      out.push(shifted)
    }
  })
  return out
}

type EventPatch = (event: WireSessionEvent) => WireSessionEvent

function patchTurn(
  events: WireSessionEvent[],
  patch: EventPatch,
): WireSessionEvent[] {
  return events.map(patch)
}

function data(event: WireSessionEvent): Mutable {
  return event.data as unknown as Mutable
}

/** Turn 2: changed request header, wire-truncated + failed bash results. */
function turnTwo(): WireSessionEvent[] {
  return patchTurn(turnEvents(2), (event) => {
    if (event.type === 'request/header') {
      const header = structuredClone(data(event).header) as Mutable & {
        system: string
        tools: unknown[]
      }
      header.system = `${header.system}\n\n## Session notes\nThe user prefers concise answers and blue accents.`
      header.tools = header.tools.slice(1)
      return { ...event, data: { ...data(event), header } } as WireSessionEvent
    }
    if (event.type === 'tool/result') {
      const payload = structuredClone(data(event)) as Mutable & {
        message: { source: { callId: string }; content: Mutable[] }
      }
      const callId = payload.message.source.callId
      const block = payload.message.content[0] as Mutable & {
        content: Mutable[]
      }
      if (callId.endsWith('call_bash_a')) {
        block.content = [{ type: 'text', text: `${'alpha '.repeat(400)}\n…` }]
        return {
          ...event,
          data: payload,
          wire: {
            truncated: true,
            field: 'result',
            bytes: 412_000,
            headBytes: 262_144,
          },
        } as unknown as WireSessionEvent
      }
      if (callId.endsWith('call_bash_b')) {
        block.content = [
          { type: 'text', text: 'bash: permission denied: ./deploy.sh' },
        ]
        block.isError = true
        return { ...event, data: payload } as WireSessionEvent
      }
    }
    return event
  })
}

function childSessions(): GallerySession[] {
  return LOG.children.map((child) => ({
    id: child.header.id,
    events: [...child.events],
    origin: 'subagent' as const,
  }))
}

export function kernelScenario(): GalleryScenario {
  return {
    id: 'kernel',
    label: 'Recorded kernel log',
    sessions: [{ id: 'kernel', events: [...ROOT] }, ...childSessions()],
  }
}

export function richScenario(): GalleryScenario {
  return {
    id: 'rich',
    label: 'Rich (3 turns)',
    sessions: [
      {
        id: 'rich',
        events: sequence([
          [...PREFACE, ...turnEvents(1)],
          turnTwo(),
          turnEvents(3),
          COMPACTION,
        ]),
      },
      ...childSessions(),
    ],
  }
}

export function longScenario(turns = 400): GalleryScenario {
  const blocks: WireSessionEvent[][] = [[...PREFACE, ...turnEvents(1)]]
  for (let turn = 2; turn <= turns; turn++)
    blocks.push(turn === 2 ? turnTwo() : turnEvents(turn))
  return {
    id: 'long',
    label: `Long (${turns} turns)`,
    sessions: [{ id: 'long', events: sequence(blocks) }, ...childSessions()],
  }
}

export function liveScenario(): GalleryScenario {
  const events = sequence([
    [...PREFACE, ...turnEvents(1)],
    turnTwo(),
    turnEvents(3),
  ])
  const cut = events.findIndex(
    (event) => event.type === 'turn/start' && data(event).turn === 3,
  )
  return {
    id: 'live',
    label: 'Live (streaming turn 3)',
    sessions: [
      { id: 'live', events: events.slice(0, cut), live: events.slice(cut) },
      ...childSessions(),
    ],
  }
}

export const GALLERY_SCENARIOS: Record<string, () => GalleryScenario> = {
  kernel: kernelScenario,
  rich: richScenario,
  long: () => longScenario(),
  live: liveScenario,
}

/** History page of a fixture session (cut by event count, newest last). */
export function galleryPage(
  session: GallerySession,
  query: { beforeSeq?: number; maxMessages?: number },
  live: readonly WireSessionEvent[],
  pageEvents?: number,
): SessionHistoryPage {
  const log = [...session.events, ...live]
  const limit = pageEvents ?? Math.max(1, (query.maxMessages ?? 50) * 12)
  const eligible = log.filter(
    (event) => query.beforeSeq === undefined || event.seq < query.beforeSeq,
  )
  const events = eligible.slice(Math.max(0, eligible.length - limit))
  return {
    header: {
      version: 0,
      id: session.id,
      createdAt: session.events[0]?.time ?? 0,
      ...(session.origin === undefined ? {} : { origin: session.origin }),
    },
    events,
    hasMore: eligible.length > events.length,
    lastSeq: log.at(-1)?.seq ?? -1,
  } as SessionHistoryPage
}
