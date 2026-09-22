// Turn/Step location index for one session window (ported from the dsh
// conversation-location-index, without the Location data stores).
//
// Every event in the window resolves to a Location: the Turn (and Step) it
// belongs to, or the session level. Turn/Step objects are reference-stable:
// an unchanged Turn keeps its identity across rebuilds and boundary appends,
// so consumers can compare references to detect change.
import type { SessionEvent } from '@emperor/core/runtime-contract'

/** Immutable resolved boundary for one agent step. */
export interface StepLocation {
  readonly turn: number
  readonly step: number
  readonly start: SessionEvent<'step/start'> | undefined
  readonly end: SessionEvent<'step/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
}

/** Immutable resolved boundary for one agent turn. */
export interface TurnLocation {
  readonly turn: number
  readonly start: SessionEvent<'turn/start'> | undefined
  readonly end: SessionEvent<'turn/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  readonly steps: readonly StepLocation[]
}

/** Engine-owned placement of one event in the session hierarchy. */
export type ConversationLocation =
  | { readonly kind: 'session' }
  | { readonly kind: 'turn'; readonly turn: TurnLocation }
  | {
      readonly kind: 'step'
      readonly turn: TurnLocation
      readonly step: StepLocation
    }
  | { readonly kind: 'unresolved' }

/** Reference-stable Turn/Step facts of the loaded window. */
export interface ConversationTimeline {
  readonly turnOrder: readonly number[]
  readonly turns: ReadonlyMap<number, TurnLocation>
}

interface Coordinates {
  readonly turn?: number
  readonly step?: number
  readonly session?: true
}

interface StepDraft {
  readonly turn: number
  readonly step: number
  firstSeq: number
  start?: SessionEvent<'step/start'>
  end?: SessionEvent<'step/end'>
}

interface TurnDraft {
  readonly turn: number
  firstSeq: number
  start?: SessionEvent<'turn/start'>
  end?: SessionEvent<'turn/end'>
  readonly steps: Map<number, StepDraft>
}

const SESSION_LOCATION = { kind: 'session' } as const
const UNRESOLVED_LOCATION = { kind: 'unresolved' } as const

/** Empty timeline shared by fresh windows. */
export const EMPTY_TIMELINE: ConversationTimeline = {
  turnOrder: [],
  turns: new Map(),
}

/** Whether an event type moves a Turn/Step boundary. */
export function isLocationBoundary(type: string): boolean {
  return (
    type === 'turn/start' ||
    type === 'turn/end' ||
    type === 'step/start' ||
    type === 'step/end'
  )
}

function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function payloadCoordinates(event: SessionEvent): Coordinates {
  const data = event.data as { turn?: unknown; step?: unknown }
  if (data.turn === null) return { session: true }
  const turn = coordinate(data.turn)
  const step = coordinate(data.step)
  return {
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  }
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameStep(
  left: StepLocation | undefined,
  right: StepLocation,
): boolean {
  return (
    left !== undefined &&
    left.start === right.start &&
    left.end === right.end &&
    left.status === right.status
  )
}

function sameTurn(
  left: TurnLocation | undefined,
  right: TurnLocation,
): boolean {
  return (
    left !== undefined &&
    left.start === right.start &&
    left.end === right.end &&
    left.status === right.status &&
    sameReferences(left.steps, right.steps)
  )
}

/** Whether two Locations place an event at the same Turn/Step objects. */
export function sameLocation(
  left: ConversationLocation | undefined,
  right: ConversationLocation | undefined,
): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind)
    return left === right
  if (left.kind === 'session' || left.kind === 'unresolved') return true
  if (right.kind === 'session' || right.kind === 'unresolved') return false
  if (left.kind === 'turn' || right.kind === 'turn') {
    return (
      left.kind === 'turn' && right.kind === 'turn' && left.turn === right.turn
    )
  }
  return left.turn === right.turn && left.step === right.step
}

/** Turn/step numbers of a Location (null at the session level). */
export function locationCoordinates(location: ConversationLocation): {
  turn: number | null
  step: number | null
} {
  if (location.kind === 'step')
    return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn, step: null }
  return { turn: null, step: null }
}

/** Session-owned Turn/Step timeline and event-to-Location index. */
export class ConversationLocationIndex {
  private coordinates = new Map<number, Coordinates>()
  private locations = new Map<number, ConversationLocation>()
  private seqsByTurn = new Map<number, Set<number>>()
  private timeline: ConversationTimeline = EMPTY_TIMELINE
  private currentTurn: number | undefined
  private currentStep: number | undefined

  /** Current reference-stable timeline. */
  snapshot(): ConversationTimeline {
    return this.timeline
  }

  /** Latest Location of one ingested event (session level when unknown). */
  locationOf(event: SessionEvent): ConversationLocation {
    return this.locations.get(event.seq) ?? SESSION_LOCATION
  }

  /**
   * Rebuild timeline facts for a complete window (ascending seq).
   * @returns seqs whose resolved Location changed.
   */
  rebuild(events: readonly SessionEvent[]): ReadonlySet<number> {
    const previousLocations = this.locations
    const turns = new Map<number, TurnDraft>()
    const coordinates = new Map<number, Coordinates>()
    let currentTurn: number | undefined
    let currentStep: number | undefined

    const turnDraft = (turn: number, seq: number): TurnDraft => {
      let draft = turns.get(turn)
      if (draft === undefined) {
        draft = { turn, firstSeq: seq, steps: new Map() }
        turns.set(turn, draft)
      } else {
        draft.firstSeq = Math.min(draft.firstSeq, seq)
      }
      return draft
    }
    const stepDraft = (turn: number, step: number, seq: number): StepDraft => {
      const owner = turnDraft(turn, seq)
      let draft = owner.steps.get(step)
      if (draft === undefined) {
        draft = { turn, step, firstSeq: seq }
        owner.steps.set(step, draft)
      } else {
        draft.firstSeq = Math.min(draft.firstSeq, seq)
      }
      return draft
    }

    for (const event of events) {
      const explicit = payloadCoordinates(event)
      if (event.type === 'turn/start') {
        currentTurn = (event as SessionEvent<'turn/start'>).data.turn
        currentStep = undefined
      }
      if (event.type === 'step/start') {
        const data = (event as SessionEvent<'step/start'>).data
        currentTurn = data.turn
        currentStep = data.step
      }
      if (explicit.session !== true && explicit.turn !== undefined) {
        if (currentTurn !== explicit.turn) currentStep = undefined
        currentTurn = explicit.turn
        if (explicit.step !== undefined) currentStep = explicit.step
      }
      const turn =
        explicit.session === true ? undefined : (explicit.turn ?? currentTurn)
      const step =
        explicit.session === true ||
        event.type === 'turn/start' ||
        event.type === 'turn/end'
          ? undefined
          : (explicit.step ?? (turn === currentTurn ? currentStep : undefined))
      coordinates.set(event.seq, {
        ...(turn === undefined ? {} : { turn }),
        ...(turn === undefined || step === undefined ? {} : { step }),
      })
      if (turn !== undefined) turnDraft(turn, event.seq)
      if (turn !== undefined && step !== undefined)
        stepDraft(turn, step, event.seq)

      if (event.type === 'turn/start') {
        const typed = event as SessionEvent<'turn/start'>
        turnDraft(typed.data.turn, event.seq).start = typed
      } else if (event.type === 'turn/end') {
        const typed = event as SessionEvent<'turn/end'>
        turnDraft(typed.data.turn, event.seq).end = typed
      } else if (event.type === 'step/start') {
        const typed = event as SessionEvent<'step/start'>
        stepDraft(typed.data.turn, typed.data.step, event.seq).start = typed
      } else if (event.type === 'step/end') {
        const typed = event as SessionEvent<'step/end'>
        stepDraft(typed.data.turn, typed.data.step, event.seq).end = typed
        if (currentTurn === typed.data.turn && currentStep === typed.data.step)
          currentStep = undefined
      }
      if (event.type === 'turn/end') {
        const typed = event as SessionEvent<'turn/end'>
        if (currentTurn === typed.data.turn) {
          currentTurn = undefined
          currentStep = undefined
        }
      }
    }

    const previousTurns = this.timeline.turns
    const nextTurns = new Map<number, TurnLocation>()
    const orderedDrafts = [...turns.values()].sort(
      (left, right) => left.firstSeq - right.firstSeq,
    )
    for (const draft of orderedDrafts) {
      const previousTurn = previousTurns.get(draft.turn)
      const previousSteps = new Map(
        previousTurn?.steps.map((step) => [step.step, step]) ?? [],
      )
      const steps = [...draft.steps.values()]
        .sort((left, right) => left.firstSeq - right.firstSeq)
        .map((candidate): StepLocation => {
          const value: StepLocation = {
            turn: candidate.turn,
            step: candidate.step,
            start: candidate.start,
            end: candidate.end,
            status:
              candidate.end !== undefined
                ? 'closed'
                : candidate.start === undefined
                  ? 'unknown'
                  : 'open',
          }
          const previous = previousSteps.get(candidate.step)
          return sameStep(previous, value) ? (previous as StepLocation) : value
        })
      const value: TurnLocation = {
        turn: draft.turn,
        start: draft.start,
        end: draft.end,
        status:
          draft.end !== undefined
            ? 'closed'
            : draft.start === undefined
              ? 'unknown'
              : 'open',
        steps,
      }
      nextTurns.set(
        draft.turn,
        sameTurn(previousTurn, value) ? (previousTurn as TurnLocation) : value,
      )
    }

    const nextOrder = orderedDrafts.map((draft) => draft.turn)
    const turnOrder = sameReferences(this.timeline.turnOrder, nextOrder)
      ? this.timeline.turnOrder
      : nextOrder
    let sameMap = previousTurns.size === nextTurns.size
    if (sameMap) {
      for (const [turn, value] of nextTurns) {
        if (previousTurns.get(turn) !== value) {
          sameMap = false
          break
        }
      }
    }
    this.timeline =
      sameMap && turnOrder === this.timeline.turnOrder
        ? this.timeline
        : { turnOrder, turns: nextTurns }
    this.coordinates = coordinates
    this.locations = new Map()
    this.seqsByTurn = new Map()
    for (const event of events) {
      const coords = this.coordinates.get(event.seq)
      if (coords?.turn !== undefined) this.indexTurnSeq(coords.turn, event.seq)
      this.locations.set(event.seq, this.resolve(event.seq))
    }
    this.currentTurn = currentTurn
    this.currentStep = currentStep

    const changed = new Set<number>()
    for (const event of events) {
      if (
        !sameLocation(
          previousLocations.get(event.seq),
          this.locations.get(event.seq),
        )
      )
        changed.add(event.seq)
    }
    return changed
  }

  /**
   * Append one Turn/Step boundary, revisiting only the owning Turn.
   * @returns seqs whose Location reference changed.
   */
  appendBoundary(event: SessionEvent): ReadonlySet<number> {
    const data = event.data as { turn: number; step?: number }
    const explicit = payloadCoordinates(event)
    if (event.type === 'turn/start') {
      this.currentTurn = data.turn
      this.currentStep = undefined
    } else if (event.type === 'step/start') {
      this.currentTurn = data.turn
      this.currentStep = data.step
    }
    if (explicit.turn !== undefined) {
      if (this.currentTurn !== explicit.turn) this.currentStep = undefined
      this.currentTurn = explicit.turn
      if (explicit.step !== undefined) this.currentStep = explicit.step
    }
    const turnNumber = explicit.turn ?? this.currentTurn
    if (turnNumber === undefined) return new Set()
    const stepNumber =
      event.type === 'turn/start' || event.type === 'turn/end'
        ? undefined
        : (explicit.step ??
          (turnNumber === this.currentTurn ? this.currentStep : undefined))
    this.coordinates.set(event.seq, {
      turn: turnNumber,
      ...(stepNumber === undefined ? {} : { step: stepNumber }),
    })
    this.indexTurnSeq(turnNumber, event.seq)

    const previousTurn = this.timeline.turns.get(turnNumber)
    let steps = previousTurn?.steps ?? []
    if (
      (event.type === 'step/start' || event.type === 'step/end') &&
      data.step !== undefined
    ) {
      const number = data.step
      const previousStep = steps.find((candidate) => candidate.step === number)
      const candidate: StepLocation = {
        turn: turnNumber,
        step: number,
        start:
          event.type === 'step/start'
            ? (event as SessionEvent<'step/start'>)
            : previousStep?.start,
        end:
          event.type === 'step/end'
            ? (event as SessionEvent<'step/end'>)
            : previousStep?.end,
        status:
          event.type === 'step/end' || previousStep?.end !== undefined
            ? 'closed'
            : 'open',
      }
      const nextStep = sameStep(previousStep, candidate)
        ? (previousStep as StepLocation)
        : candidate
      const index = steps.findIndex((step) => step.step === number)
      steps =
        index < 0
          ? [...steps, nextStep]
          : steps.map((step, at) => (at === index ? nextStep : step))
    }
    const candidate: TurnLocation = {
      turn: turnNumber,
      start:
        event.type === 'turn/start'
          ? (event as SessionEvent<'turn/start'>)
          : previousTurn?.start,
      end:
        event.type === 'turn/end'
          ? (event as SessionEvent<'turn/end'>)
          : previousTurn?.end,
      status:
        event.type === 'turn/end' || previousTurn?.end !== undefined
          ? 'closed'
          : event.type === 'turn/start' || previousTurn?.start !== undefined
            ? 'open'
            : 'unknown',
      steps,
    }
    const turn = sameTurn(previousTurn, candidate)
      ? (previousTurn as TurnLocation)
      : candidate
    if (turn !== previousTurn) {
      const turns = new Map(this.timeline.turns)
      turns.set(turnNumber, turn)
      const turnOrder =
        previousTurn === undefined
          ? [...this.timeline.turnOrder, turnNumber]
          : this.timeline.turnOrder
      this.timeline = { turnOrder, turns }
    }

    const changed = new Set<number>()
    for (const seq of this.seqsByTurn.get(turnNumber) ?? []) {
      const previous = this.locations.get(seq)
      const next = this.resolve(seq)
      this.locations.set(seq, next)
      if (!sameLocation(previous, next)) changed.add(seq)
    }

    if (
      event.type === 'step/end' &&
      this.currentTurn === data.turn &&
      this.currentStep === data.step
    )
      this.currentStep = undefined
    if (event.type === 'turn/end' && this.currentTurn === data.turn) {
      this.currentTurn = undefined
      this.currentStep = undefined
    }
    return changed
  }

  /** Index one non-boundary tail event without rescanning the window. */
  appendNonBoundary(event: SessionEvent): void {
    const explicit = payloadCoordinates(event)
    if (explicit.session === true) {
      this.coordinates.set(event.seq, {})
      this.locations.set(event.seq, SESSION_LOCATION)
      return
    }
    if (explicit.turn !== undefined) {
      if (this.currentTurn !== explicit.turn) this.currentStep = undefined
      this.currentTurn = explicit.turn
      if (explicit.step !== undefined) this.currentStep = explicit.step
    }
    const turn = explicit.turn ?? this.currentTurn
    const step =
      explicit.step ??
      (turn === this.currentTurn ? this.currentStep : undefined)
    this.coordinates.set(event.seq, {
      ...(turn === undefined ? {} : { turn }),
      ...(turn === undefined || step === undefined ? {} : { step }),
    })
    if (turn !== undefined) this.indexTurnSeq(turn, event.seq)
    this.locations.set(event.seq, this.resolve(event.seq))
  }

  private indexTurnSeq(turn: number, seq: number): void {
    const current = this.seqsByTurn.get(turn) ?? new Set<number>()
    current.add(seq)
    this.seqsByTurn.set(turn, current)
  }

  private resolve(seq: number): ConversationLocation {
    const coords = this.coordinates.get(seq)
    if (coords?.turn === undefined) return SESSION_LOCATION
    const turn = this.timeline.turns.get(coords.turn)
    if (turn === undefined) return UNRESOLVED_LOCATION
    if (coords.step === undefined) return { kind: 'turn', turn }
    const step = turn.steps.find((candidate) => candidate.step === coords.step)
    return step === undefined
      ? { kind: 'turn', turn }
      : { kind: 'step', turn, step }
  }
}
