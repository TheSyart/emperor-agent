/**
 * Runtime-context projection (ported from dsh-agent-loop runtime-context.ts).
 *
 * The dynamic runtime context (sandbox/approval policy, plan mode, goal,
 * delegation notes, …) reaches the model only as a durable `user/message`
 * with `form: 'snapshot'`, and only when its text differs from the snapshot
 * still on the surface. When every context empties out after one was shown,
 * a single "none" snapshot supersedes it. This keeps the system prompt, and
 * with it the provider prefix cache, stable.
 */

import { createUserMessage, type UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import { isReplacementSurfaceEvent } from '../../session-log/surface'
import type { ContextSnapshotSection } from '../prompt/assembler'

export const RUNTIME_CONTEXT_PRODUCER = 'runtime-context'
const CLEARED =
  'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function isOwned(message: UserMessage): boolean {
  return (
    message.source.kind === 'context' &&
    message.source.producer === RUNTIME_CONTEXT_PRODUCER
  )
}

function textOf(message: UserMessage): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text'
    ? block.text
    : undefined
}

export class RuntimeContextProjection {
  /** undefined: never shown; null: shown but compacted away; else the retained snapshot. */
  private retained: { seq: number; text: string | undefined } | null | undefined
  private readonly unsubscribe: () => void

  constructor(session: Session) {
    const surface = new Set(session.surface.nodes)
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event?.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }
    this.unsubscribe = session.subscribe((_session, event) => {
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (
        this.retained &&
        isReplacementSurfaceEvent(event) &&
        event.sourceEventSeqs?.includes(this.retained.seq) === true
      ) {
        this.retained = null
      }
    })
  }

  /** The snapshot message to enter, or undefined when nothing changed. */
  project(
    current: string,
    _sections: readonly ContextSnapshotSection[] = [],
  ): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return undefined
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return undefined
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: {
        kind: 'context',
        producer: RUNTIME_CONTEXT_PRODUCER,
        form: 'snapshot',
      },
    })
  }

  dispose(): void {
    this.unsubscribe()
  }
}
