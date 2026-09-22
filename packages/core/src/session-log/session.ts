/**
 * `Session`: one append-only event log plus its derived views (ported from
 * dsh-session `Session`, with a plain listener list instead of Cordis events).
 *
 * `append()` snapshots the payload as lossless JSON, freezes the event,
 * validates surface metadata, pushes it, and then notifies listeners (a
 * listener failure never reaches the appender). Derived views fold
 * incrementally: request header, request context, and `deriveMessages()`.
 */

import { isAbsolute } from 'node:path'
import { deepFreeze } from '../llm/freeze'
import type { Message } from '../llm/message'
import { logger as log } from '../util/log'
import { snapshotJsonValue } from './json'
import { foldRequestHeader } from './request-header'
import {
  deriveEventMessage,
  SurfaceManager,
  type SessionSurface,
} from './surface'
import {
  SESSION_FORMAT_VERSION,
  type EpochHeader,
  type RequestContext,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
  type SessionHeader,
  type SurfaceEventType,
  type SurfaceIntent,
} from './types'

export type SessionListener = (session: Session, event: SessionEvent) => void

function validateHeader(id: string, input: SessionHeader): SessionHeader {
  if (input.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `session header version must be ${SESSION_FORMAT_VERSION}, got ${String(input.version)}`,
    )
  }
  if (input.id !== id)
    throw new Error(
      `session header id "${input.id}" does not match session id "${id}"`,
    )
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error(
      'session header createdAt must be a non-negative safe integer',
    )
  }
  if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
    throw new Error(
      `session header cwd must be an absolute path, got "${input.cwd}"`,
    )
  }
  if (
    input.seedLength !== undefined &&
    (!Number.isSafeInteger(input.seedLength) || input.seedLength < 0)
  ) {
    throw new Error(
      'session header seedLength must be a non-negative safe integer',
    )
  }
  if (
    input.delegationDepth !== undefined &&
    (!Number.isSafeInteger(input.delegationDepth) || input.delegationDepth < 0)
  ) {
    throw new Error(
      'session header delegationDepth must be a non-negative safe integer',
    )
  }
  return deepFreeze(structuredClone(input))
}

/** Assert the minimal identified-message shape of one surface-eligible event. */
function assertMessageEventShape(event: SessionEvent, subject: string): void {
  if (
    event.type !== 'user/message' &&
    event.type !== 'assistant/message' &&
    event.type !== 'tool/result'
  )
    return
  const message = (
    event.type === 'user/message'
      ? event.data
      : (event.data as { message?: unknown }).message
  ) as Record<string, unknown> | undefined
  if (
    typeof message !== 'object' ||
    message === null ||
    typeof message['id'] !== 'string' ||
    message['id'] === ''
  ) {
    throw new Error(`${subject} lacks an identified message`)
  }
  const expectedRole = event.type === 'assistant/message' ? 'assistant' : 'user'
  if (message['role'] !== expectedRole)
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  if (!Array.isArray(message['content']))
    throw new Error(`${subject} message has invalid content`)
  const source = message['source'] as Record<string, unknown> | undefined
  if (
    typeof source !== 'object' ||
    source === null ||
    typeof source['kind'] !== 'string'
  ) {
    throw new Error(`${subject} message has invalid source`)
  }
  if (event.type === 'assistant/message' && source['kind'] !== 'model') {
    throw new Error(`${subject} message must have model source`)
  }
  if (event.type === 'tool/result') {
    const block = (message['content'] as unknown[])[0] as
      Record<string, unknown> | undefined
    if (
      source['kind'] !== 'tool' ||
      (message['content'] as unknown[]).length !== 1 ||
      block?.['type'] !== 'tool-result' ||
      block['toolCallId'] !== source['callId']
    ) {
      throw new Error(
        `${subject} message must contain one matching tool-result block`,
      )
    }
  }
}

export class Session {
  private readonly log: SessionEvent[] = []
  private readonly surfaceManager = new SurfaceManager(this.log)
  private readonly listeners = new Set<SessionListener>()
  private appending = false
  readonly header: SessionHeader
  /** Seq of the first event appended in this process (after any restored/seeded prefix). */
  readonly firstLiveSeq: number

  /**
   * @param header - creation facts.
   * @param seed - events to start from: a fork's copied prefix, or a restored log.
   * @param mode - `seed` re-validates and appends `session/end-seed`; `restore` trusts persisted order.
   */
  constructor(
    header: SessionHeader,
    seed: readonly SessionEvent[] = [],
    mode: 'seed' | 'restore' = 'seed',
  ) {
    this.header = validateHeader(header.id, header)
    for (const [index, source] of seed.entries()) {
      const snapshot = mode === 'restore' ? source : snapshotJsonValue(source)
      if (snapshot === undefined)
        throw new Error(
          `seed event at index ${index} is not losslessly JSON-serializable`,
        )
      if (snapshot.seq !== index) {
        throw new Error(
          `seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`,
        )
      }
      assertMessageEventShape(
        snapshot,
        `seed ${snapshot.type} at index ${index}`,
      )
      try {
        this.surfaceManager.validateNext(snapshot)
      } catch (error: unknown) {
        throw new Error(
          `invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`,
        )
      }
      this.log.push(deepFreeze(snapshot))
    }
    this.firstLiveSeq = this.log.length
    if (
      mode === 'seed' &&
      seed.length > 0 &&
      this.log.at(-1)?.type !== 'session/end-seed'
    ) {
      this.append('session/end-seed', {})
    }
  }

  get id(): string {
    return this.header.id
  }

  get surface(): SessionSurface {
    return this.surfaceManager
  }

  private eventsSnapshot: readonly SessionEvent[] | undefined

  /** Frozen view of the whole log. */
  get events(): readonly SessionEvent[] {
    this.eventsSnapshot ??= Object.freeze([...this.log])
    return this.eventsSnapshot
  }

  /** Next seq to be assigned (= log length). */
  get seq(): number {
    return this.log.length
  }

  /** Observe every appended event; returns the unsubscribe function. */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType
      ? [opts: SurfaceIntent]
      : [opts?: { ignorable?: true }]
  ): SessionEvent<T> {
    if (this.appending)
      throw new Error(
        'session append cannot reenter while another append is being published',
      )
    const intent = opts[0] as (SurfaceIntent & { ignorable?: true }) | undefined
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined)
      throw new Error(
        `session event "${type}" carries non-JSON-serializable data`,
      )
    const event = deepFreeze({
      type,
      seq: this.log.length,
      time: Date.now(),
      data: dataSnapshot,
      ...(intent?.ignorable === true ? { ignorable: true } : {}),
      ...(intent?.sourceEventSeqs === undefined
        ? {}
        : { sourceEventSeqs: [...intent.sourceEventSeqs] }),
      ...(intent?.surfaceOp === undefined
        ? {}
        : { surfaceOp: structuredClone(intent.surfaceOp) }),
    } as unknown as SessionEvent<T>)
    assertMessageEventShape(event as SessionEvent, `session event "${type}"`)
    this.surfaceManager.validateNext(event as SessionEvent)
    this.appending = true
    try {
      this.log.push(event as SessionEvent)
      this.eventsSnapshot = undefined
      for (const listener of this.listeners) {
        try {
          listener(this, event as SessionEvent)
        } catch (error: unknown) {
          log.warn(`session "${this.id}": listener threw`, {
            error: String(error),
          })
        }
      }
    } finally {
      this.appending = false
    }
    return event
  }

  private headerFold: EpochHeader | undefined
  private headerFoldSeq = 0

  /** Latest logged request header, if any. */
  requestHeader(): EpochHeader | undefined {
    if (this.headerFoldSeq < this.log.length) {
      this.headerFold = deepFreeze(
        foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold),
      )
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  private contextFold: RequestContext | undefined
  private contextFoldSeq = 0

  /** Latest logged request context (provider/model/contextWindow), if any. */
  requestContext(): RequestContext | undefined {
    if (this.contextFoldSeq < this.log.length) {
      for (const event of this.log.slice(this.contextFoldSeq)) {
        if (event.type === 'request/context')
          this.contextFold = deepFreeze({ ...event.data })
      }
      this.contextFoldSeq = this.log.length
    }
    return this.contextFold
  }

  private derived: Message[] = []
  private derivedNodes = 0
  private derivedGeneration = 0

  /** The model-visible message list: surface nodes mapped to messages. */
  deriveMessages(): Message[] {
    const nodes = this.surface.nodes
    const generation = this.surface.replaceGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of nodes.slice(this.derivedNodes)) {
      const event = this.log[seq]
      const message = event === undefined ? null : deriveEventMessage(event)
      if (message) this.derived.push(message)
    }
    this.derivedNodes = nodes.length
    return [...this.derived]
  }

  /** Per-event projection used by incremental consumers (same rule as {@link deriveMessages}). */
  deriveEventMessage(event: SessionEvent): Message | null {
    return deriveEventMessage(event)
  }

  /** Last event of a type, scanning backward. */
  lastOf<T extends SessionEventType>(type: T): SessionEvent<T> | undefined {
    for (let index = this.log.length - 1; index >= 0; index--) {
      const event = this.log[index]
      if (event?.type === type) return event as SessionEvent<T>
    }
    return undefined
  }

  /** Whether a turn is currently open in the log. */
  hasOpenTurn(): boolean {
    for (let index = this.log.length - 1; index >= 0; index--) {
      const type = this.log[index]?.type
      if (type === 'turn/end') return false
      if (type === 'turn/start') return true
    }
    return false
  }
}
