// One session's contiguous raw event window (ported from the dsh Session
// window logic): cold → opening → open, tail-page fetch, live buffering
// while a fetch is in flight, seq dedupe, gap repair by re-pulling the tail,
// and older pages via `beforeSeq` with a continuity check.
//
// The window owns no rendering: it drives a `ConversationAssembler` and
// reports publication cadences to its owner (the conversation store).
import type {
  SessionHeader,
  SessionHistoryPage,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type { SessionHistoryQuery } from '../api/sessions'
import {
  maximumPublication,
  type ConversationAssembler,
  type ConversationPublication,
} from './assembler'

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

/** Maximum consecutive tail re-pulls while stitching a gap. */
const MAX_REPAIR_ATTEMPTS = 3

export type WindowOpenState = 'cold' | 'opening' | 'open' | 'error'

/** History transport injected by the store (tests pass a fake). */
export interface SessionWindowApi {
  history(query: SessionHistoryQuery): Promise<SessionHistoryPage>
}

/** Observable window facts. */
export interface SessionWindowState {
  readonly openState: WindowOpenState
  readonly header: SessionHeader | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly error: string | null
}

export interface SessionWindowOptions {
  readonly pageMessages?: number
  /** Called with the cadence of every change (state or content). */
  readonly onChange?: (publication: ConversationPublication) => void
  /** Diagnostics sink for discontinuities (default console.warn in dev). */
  readonly onWarning?: (message: string) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SessionWindow {
  private events: WireSessionEvent[] = []
  /** Log tail when the last page was cut (covers hidden fork seeds). */
  private cutSeq: number | null = null
  private liveBuffer: WireSessionEvent[] = []
  private openPromise: Promise<void> | null = null
  private generation = 0
  private stitching = false
  private state: SessionWindowState = {
    openState: 'cold',
    header: null,
    hasMore: false,
    loadingOlder: false,
    error: null,
  }
  private readonly pageMessages: number

  constructor(
    readonly sessionId: string,
    private readonly api: SessionWindowApi,
    private readonly assembler: ConversationAssembler,
    private readonly options: SessionWindowOptions = {},
  ) {
    this.pageMessages = options.pageMessages ?? PAGE_MESSAGES
  }

  /** Current observable facts. */
  get snapshot(): SessionWindowState {
    return this.state
  }

  /** Loaded events in ascending seq order (read-only view). */
  get window(): readonly WireSessionEvent[] {
    return this.events
  }

  /** Seq of the first loaded event, or null when empty. */
  get baseSeq(): number | null {
    return this.events[0]?.seq ?? null
  }

  /** Seq of the last known log event, or null before any page. */
  get tailSeq(): number | null {
    const last = this.events.at(-1)?.seq
    if (last === undefined) return this.cutSeq
    return this.cutSeq === null ? last : Math.max(last, this.cutSeq)
  }

  /** First open: pull the tail page. Idempotent while opening/open. */
  open(): Promise<void> {
    if (this.state.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.generation).finally(() => {
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** Drop the window and reopen from the tail (e.g. after a reconnect). */
  async resync(): Promise<void> {
    if (this.state.openState === 'cold') return
    this.generation++
    this.openPromise = null
    this.events = []
    this.cutSeq = null
    this.liveBuffer = []
    this.stitching = false
    this.setState({ openState: 'cold', error: null })
    await this.open()
  }

  /** Accept live events (any order, duplicates allowed). */
  acceptLive(events: readonly WireSessionEvent[]): void {
    let publication: ConversationPublication = 'none'
    for (const event of events) {
      publication = maximumPublication(publication, this.acceptOne(event))
    }
    if (publication !== 'none') this.options.onChange?.(publication)
  }

  /** Page up: pull one older page and prepend it (full rebuild). */
  async loadOlder(): Promise<void> {
    const base = this.baseSeq
    if (
      this.state.openState !== 'open' ||
      !this.state.hasMore ||
      this.state.loadingOlder ||
      base === null
    )
      return
    const generation = this.generation
    this.setState({ loadingOlder: true })
    try {
      const page = await this.api.history({
        sessionId: this.sessionId,
        beforeSeq: base,
        maxMessages: this.pageMessages,
      })
      if (generation !== this.generation || this.baseSeq !== base) return
      const older = page.events.filter((event) => event.seq < base)
      const last = older.at(-1)
      if (last === undefined) {
        this.assembler.prepend([], page.hasMore)
        this.setState({ hasMore: page.hasMore })
        return
      }
      if (last.seq + 1 !== base) {
        // Continuity violation: keep the window, stop paging (fail-soft).
        this.warn(
          `history page discontinuous: tail ${last.seq} vs base ${base}`,
        )
        this.assembler.prepend([], false)
        this.setState({ hasMore: false })
        return
      }
      this.events = [...older, ...this.events]
      this.assembler.prepend(older, page.hasMore)
      this.setState({ hasMore: page.hasMore })
    } catch (error: unknown) {
      this.warn(`loadOlder failed: ${errorText(error)}`)
    } finally {
      if (generation === this.generation) this.setState({ loadingOlder: false })
    }
  }

  private async doOpen(generation: number): Promise<void> {
    this.setState({ openState: 'opening', error: null })
    try {
      const page = await this.api.history({
        sessionId: this.sessionId,
        maxMessages: this.pageMessages,
      })
      if (generation !== this.generation) return
      this.install(page)
      this.setState({ openState: 'open' })
      await this.repairIfGapped(generation)
    } catch (error: unknown) {
      if (generation !== this.generation) return
      this.setState({ openState: 'error', error: errorText(error) })
    }
  }

  /**
   * Install a tail page and stitch the live buffer by seq (the sole dedupe
   * key). Buffered events that do not connect stay buffered for repair.
   */
  private install(page: SessionHistoryPage): void {
    this.events = [...page.events].sort((left, right) => left.seq - right.seq)
    this.cutSeq = page.lastSeq >= 0 ? page.lastSeq : null
    this.assembler.replaceWindow(this.events, page.hasMore)
    this.setState({ header: page.header, hasMore: page.hasMore }, false)
    const buffered = this.liveBuffer
    this.liveBuffer = []
    buffered.sort((left, right) => left.seq - right.seq)
    for (const event of buffered) {
      if (this.appendContiguous(event) === 'gap') this.liveBuffer.push(event)
    }
    this.options.onChange?.('immediate')
  }

  /** Re-pull the tail page while buffered events still leave a hole. */
  private async repairIfGapped(generation: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
      if (this.liveBuffer.length === 0) return
      if (generation !== this.generation) return
      this.stitching = true
      try {
        const page = await this.api.history({
          sessionId: this.sessionId,
          maxMessages: this.pageMessages,
        })
        if (generation !== this.generation || this.state.openState !== 'open')
          return
        this.install(page)
      } catch (error: unknown) {
        this.warn(`gap repair failed: ${errorText(error)}`)
        return
      } finally {
        this.stitching = false
      }
    }
    if (this.liveBuffer.length > 0) {
      this.warn(`gap repair gave up with ${this.liveBuffer.length} buffered`)
      this.liveBuffer = []
    }
  }

  private acceptOne(event: WireSessionEvent): ConversationPublication {
    const openState = this.state.openState
    if (openState === 'opening' || this.stitching) {
      this.liveBuffer.push(event)
      return 'none'
    }
    if (openState !== 'open') return 'none'
    const result = this.appendContiguous(event)
    if (result === 'gap') {
      this.liveBuffer.push(event)
      void this.repairIfGapped(this.generation)
      return 'none'
    }
    return result
  }

  private appendContiguous(
    event: WireSessionEvent,
  ): ConversationPublication | 'gap' {
    const tail = this.tailSeq
    if (tail !== null && event.seq <= tail) return 'none'
    if (tail !== null && event.seq > tail + 1) return 'gap'
    this.events.push(event)
    return this.assembler.append(event)
  }

  private setState(patch: Partial<SessionWindowState>, notify = true): void {
    this.state = { ...this.state, ...patch }
    if (notify) this.options.onChange?.('immediate')
  }

  private warn(message: string): void {
    if (this.options.onWarning !== undefined) this.options.onWarning(message)
    else if (import.meta.env?.DEV)
      console.warn(`[conversation:${this.sessionId}] ${message}`)
  }
}
