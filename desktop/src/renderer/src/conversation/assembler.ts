// Incremental conversation assembly engine (ported from the dsh
// conversation-assembler, without the plugin registry).
//
// Independent Definitions each own one business state machine: `match`
// extracts a stable identity from a raw event, the engine groups matches
// into Contexts keyed by (definition kind, id), folds them through
// `start`/`update`, and materializes each Context into at most one view Node
// for the Definition's target ('chat' today, 'trajectory' from M6). View
// builders turn the materialized Nodes into one immutable snapshot per target.
//
// Deviations from dsh:
// - `prepend` (older page) is a full rebuild; only live `append` is
//   incremental.
// - Definitions may declare `links`: an event can route to another
//   Context through a (namespace, key) alias registered by an earlier or
//   later event (`subagent/settled` → the subagent tool call, `job/finished`
//   → the background bash call...). A linked event whose alias is not known
//   yet is parked and replayed into its Context once the alias arrives, so a
//   live append converges to the same state as a full rebuild.
// - Malformed logs (duplicate start, ...) are dropped instead of throwing.
// - Every flush reports the exact Node keys whose materialized value changed;
//   unchanged Nodes keep their object identity even across rebuilds.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import {
  ConversationLocationIndex,
  isLocationBoundary,
  type ConversationLocation,
  type ConversationTimeline,
} from './locationIndex'

/** View targets. `trajectory` is reserved for the M6 trajectory model. */
export type ConversationTarget = 'chat' | 'trajectory' | (string & {})

/** Definition-local identity and lifecycle role extracted from one event. */
export interface ConversationMatchResult {
  readonly id: string
  readonly role: 'start' | 'update'
}

/** An update routed through an alias registered by another event. */
export interface ConversationLinkedMatch {
  readonly via: { readonly ns: string; readonly key: string }
  readonly role: 'update'
}

/** One alias declared by an event: `(ns, key)` resolves to Context `id`. */
export interface ConversationLink {
  readonly ns: string
  readonly key: string
  readonly id: string
}

/** One event accepted by a Definition, with its current resolved Location. */
export interface ConversationMatch {
  readonly event: WireSessionEvent
  readonly role: 'start' | 'update'
  readonly location: ConversationLocation
}

/** Target-neutral materialized view Node. */
export interface ConversationViewNode {
  /** Engine-owned stable Context key. */
  readonly key: string
  readonly kind: string
  /** Definition-local identity. */
  readonly id: string
  readonly target: ConversationTarget
  /** Sortable render position (fractional offsets allowed). */
  readonly anchorSeq: number
  readonly visibility: 'visible' | 'hidden'
  readonly data: unknown
}

/** Immutable public view of an assembled Context. */
export interface ConversationNodeContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly matches: readonly ConversationMatch[]
  readonly start: ConversationMatch | undefined
  readonly state: State | undefined
  /** Last materialized Node per target (null when not materialized). */
  readonly current: ReadonlyMap<string, ConversationViewNode | null>
}

/** Read-only predecessor handed to a Definition's `start`. */
export interface ConversationPreviousContext<State = unknown> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly startSeq: number
  readonly state: Readonly<State>
  readonly matches: readonly ConversationMatch[]
}

/** Strictly-backward Context lookup available while a start is evaluated. */
export interface ConversationContextReader {
  /** Nearest started Context of `kind` whose start seq precedes this one. */
  previous<State>(kind: string): ConversationPreviousContext<State> | undefined
}

/** Requested cadence for publishing an accepted Match. */
export type ConversationPublication = 'none' | 'animation-frame' | 'immediate'

/** One independent event-to-Node state machine. */
export interface ConversationDefinition<State = unknown> {
  readonly kind: string
  /** View target this Definition materializes into; omit for state-only. */
  readonly target?: ConversationTarget
  /** Aliases this event registers for later/earlier linked matches. */
  links?(event: WireSessionEvent): readonly ConversationLink[]
  /** Pure identity extraction; no Context or history access. */
  match(
    event: WireSessionEvent,
  ): ConversationMatchResult | ConversationLinkedMatch | null
  /** Create State from the unique start Match. */
  start(
    context: ConversationNodeContext<State>,
    match: ConversationMatch,
    reader: ConversationContextReader,
  ): State
  /** Apply one post-start update Match (ascending log order). */
  update(
    context: ConversationNodeContext<State> & { readonly state: State },
    match: ConversationMatch,
  ): State
  /** Publication cadence of one accepted Match; default immediate. */
  publication?(match: ConversationMatch): ConversationPublication
  /**
   * Materialize this Context for the Definition's target. Also called for
   * Contexts whose start is outside the window (`state` undefined) so a
   * Definition can fall back to its updates.
   */
  buildViewNode?(
    context: ConversationNodeContext<State>,
  ): ConversationViewNode | null
}

/** Incremental per-session builder for one view target. */
export interface ConversationViewBuilder<
  Node extends ConversationViewNode = ConversationViewNode,
  Snapshot = unknown,
> {
  readonly empty: Snapshot
  /** Replace the complete materialized Node set. */
  replace(input: {
    readonly nodes: readonly Node[]
    readonly timeline: ConversationTimeline
  }): Snapshot
  /** Apply only changed/removed Nodes (timeline may also have moved). */
  apply(input: {
    readonly upserts: readonly Node[]
    readonly removals: readonly string[]
    readonly timeline: ConversationTimeline
  }): Snapshot
}

/** Factory of one isolated view builder per session. */
export interface ConversationViewDefinition<
  Node extends ConversationViewNode = ConversationViewNode,
  Snapshot = unknown,
> {
  readonly target: ConversationTarget
  create(): ConversationViewBuilder<Node, Snapshot>
}

/** What one flush changed for one target. */
export interface ConversationTargetChange {
  /** Keys whose materialized Node is new or changed. */
  readonly changed: readonly string[]
  /** Keys whose Node disappeared. */
  readonly removed: readonly string[]
  /** Whether the snapshot was rebuilt from scratch. */
  readonly replaced: boolean
}

/** Result of one flush; empty map when nothing was published. */
export interface ConversationFlushReport {
  readonly targets: ReadonlyMap<string, ConversationTargetChange>
}

/**
 * Stable collision-free Context key for one Definition-local identity.
 */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}

interface Dependency {
  readonly kind: string
  readonly key: string | undefined
  readonly revision: number | undefined
  readonly windowGap: boolean
}

interface InternalContext {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly definition: ConversationDefinition
  startSeq: number | undefined
  start: ConversationMatch | undefined
  matches: ConversationMatch[]
  state: unknown
  revision: number
  readonly current: Map<string, ConversationViewNode | null>
  dependencies: Map<string, Dependency>
}

interface ViewState {
  readonly target: string
  readonly builder: ConversationViewBuilder
  snapshot: unknown
  /** Last published Node per key (identity reused when unchanged). */
  readonly published: Map<string, ConversationViewNode>
}

interface LinkEntry {
  readonly seq: number
  readonly id: string
}

interface ParkedMatch {
  readonly definition: ConversationDefinition
  readonly event: WireSessionEvent
}

const PUBLICATION_RANK: Record<ConversationPublication, number> = {
  none: 0,
  'animation-frame': 1,
  immediate: 2,
}

const EMPTY_REPORT: ConversationFlushReport = { targets: new Map() }

/** Higher of two publication cadences. */
export function maximumPublication(
  left: ConversationPublication,
  right: ConversationPublication,
): ConversationPublication {
  return PUBLICATION_RANK[left] >= PUBLICATION_RANK[right] ? left : right
}

function warn(message: string): void {
  if (import.meta.env?.DEV) console.warn(`[conversation] ${message}`)
}

function linkKey(kind: string, ns: string, key: string): string {
  return `${kind}\u0000${ns}\u0000${key}`
}

function insertionIndex(
  contexts: readonly InternalContext[],
  seq: number,
): number {
  let low = 0
  let high = contexts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const candidate = contexts[middle]
    if (candidate !== undefined && (candidate.startSeq as number) < seq)
      low = middle + 1
    else high = middle
  }
  return low
}

function contextSnapshot<State>(
  context: InternalContext,
): ConversationNodeContext<State> {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    matches: context.matches,
    start: context.start,
    state: context.state as State | undefined,
    current: context.current,
  }
}

/** Structural equality used to keep unchanged Node identities. */
export function deepEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true
  if (depth > 64) return false
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  )
    return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!deepEqual(left[index], right[index], depth + 1)) return false
    }
    return true
  }
  if (Array.isArray(right)) return false
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map)) return false
    if (left.size !== right.size) return false
    for (const [key, value] of left) {
      if (!right.has(key) || !deepEqual(value, right.get(key), depth + 1))
        return false
    }
    return true
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).filter(
    (key) => leftRecord[key] !== undefined,
  )
  const rightKeys = Object.keys(rightRecord).filter(
    (key) => rightRecord[key] !== undefined,
  )
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!deepEqual(leftRecord[key], rightRecord[key], depth + 1)) return false
  }
  return true
}

/**
 * Session-owned incremental engine: assembles Contexts from one contiguous
 * event window and materializes every registered view target.
 */
export class ConversationAssembler {
  private readonly contexts = new Map<string, InternalContext>()
  private readonly contextsByKind = new Map<string, InternalContext[]>()
  private readonly contextsBySeq = new Map<number, Set<InternalContext>>()
  private readonly inputs = new Map<number, WireSessionEvent>()
  private readonly links = new Map<string, LinkEntry[]>()
  private readonly parked = new Map<string, ParkedMatch[]>()
  private readonly locationIndex = new ConversationLocationIndex()
  private readonly dirty = new Set<InternalContext>()
  private readonly revised = new Set<InternalContext>()
  private readonly dependents = new Map<string, Set<InternalContext>>()
  private readonly views = new Map<string, ViewState>()
  private hasMore = false
  private replacePending = true
  private timelineDirty = true
  private readonly definitions: ConversationDefinition[]

  constructor(
    definitions: readonly ConversationDefinition[],
    viewDefinitions: readonly ConversationViewDefinition[],
  ) {
    this.definitions = [...definitions]
    for (const definition of viewDefinitions) this.addView(definition)
  }

  /** Whether a view target is registered. */
  hasTarget(target: ConversationTarget): boolean {
    return this.views.has(target)
  }

  /**
   * Register more Definitions and view targets after construction (lazy
   * targets such as the trajectory). Already known Definition kinds and
   * targets are skipped; the loaded window is re-assembled so the new
   * Contexts see every event, and the next flush replaces every target.
   * @returns immediate publication, or none when nothing was added.
   */
  extend(
    definitions: readonly ConversationDefinition[],
    viewDefinitions: readonly ConversationViewDefinition[],
  ): ConversationPublication {
    const kinds = new Set(this.definitions.map((definition) => definition.kind))
    let added = false
    for (const definition of definitions) {
      if (kinds.has(definition.kind)) continue
      kinds.add(definition.kind)
      this.definitions.push(definition)
      added = true
    }
    for (const definition of viewDefinitions) {
      if (this.views.has(definition.target)) continue
      this.addView(definition)
      added = true
    }
    if (!added) return 'none'
    return this.replaceWindow(this.events(), this.hasMore)
  }

  private addView(definition: ConversationViewDefinition): void {
    const builder = definition.create()
    this.views.set(definition.target, {
      target: definition.target,
      builder,
      snapshot: builder.empty,
      published: new Map(),
    })
  }

  /** Whether older history remains outside the window. */
  get windowHasMore(): boolean {
    return this.hasMore
  }

  /** Current Turn/Step timeline. */
  timeline(): ConversationTimeline {
    return this.locationIndex.snapshot()
  }

  /** Events of the window in ascending seq order. */
  events(): WireSessionEvent[] {
    return [...this.inputs.values()].sort((left, right) => left.seq - right.seq)
  }

  /** Latest snapshot of one registered target. */
  snapshot<Snapshot = unknown>(target: ConversationTarget): Snapshot {
    return this.views.get(target)?.snapshot as Snapshot
  }

  /**
   * Replace the complete loaded window (open, gap repair, older page).
   * @returns immediate publication.
   */
  replaceWindow(
    events: readonly WireSessionEvent[],
    hasMore: boolean,
  ): ConversationPublication {
    this.contexts.clear()
    this.contextsByKind.clear()
    this.contextsBySeq.clear()
    this.inputs.clear()
    this.links.clear()
    this.parked.clear()
    this.dirty.clear()
    this.revised.clear()
    this.dependents.clear()
    this.hasMore = hasMore
    const sorted = [...events].sort((left, right) => left.seq - right.seq)
    for (const event of sorted) this.inputs.set(event.seq, event)
    this.locationIndex.rebuild(sorted)
    this.timelineDirty = true
    // Links first so an event resolves aliases declared later in the window.
    for (const event of sorted) this.registerLinks(event)
    for (const event of sorted) this.matchInput(event)
    this.replayDependencies()
    this.revised.clear()
    for (const context of this.contexts.values()) this.dirty.add(context)
    this.replacePending = true
    return 'immediate'
  }

  /** Add an older page (full rebuild over the merged window). */
  prepend(
    events: readonly WireSessionEvent[],
    hasMore: boolean,
  ): ConversationPublication {
    const merged = new Map(this.inputs)
    for (const event of events)
      if (!merged.has(event.seq)) merged.set(event.seq, event)
    return this.replaceWindow([...merged.values()], hasMore)
  }

  /**
   * Add one contiguous live tail event without rescanning the window.
   * @returns highest requested publication cadence.
   */
  append(event: WireSessionEvent): ConversationPublication {
    if (this.inputs.has(event.seq)) return 'none'
    this.revised.clear()
    this.inputs.set(event.seq, event)
    let publication: ConversationPublication = 'none'
    if (isLocationBoundary(event.type)) {
      const previousTimeline = this.locationIndex.snapshot()
      const changed = this.locationIndex.appendBoundary(event)
      if (this.locationIndex.snapshot() !== previousTimeline) {
        this.timelineDirty = true
        publication = 'immediate'
      }
      this.replayContexts(this.refreshMatchLocations(changed))
      if (changed.size > 0) publication = 'immediate'
    } else {
      this.locationIndex.appendNonBoundary(event)
    }
    publication = maximumPublication(publication, this.registerLinks(event))
    publication = maximumPublication(publication, this.matchInput(event))
    if (this.replayRevisedDependents()) publication = 'immediate'
    this.revised.clear()
    return publication
  }

  /**
   * Materialize dirty Contexts and advance every view builder.
   * @returns the keys each target changed (empty when nothing moved).
   */
  flush(): ConversationFlushReport {
    if (!this.replacePending && this.dirty.size === 0 && !this.timelineDirty)
      return EMPTY_REPORT
    const timeline = this.locationIndex.snapshot()
    const report = new Map<string, ConversationTargetChange>()
    if (this.replacePending) {
      const byTarget = new Map<string, ConversationViewNode[]>()
      for (const target of this.views.keys()) byTarget.set(target, [])
      for (const context of this.contexts.values()) {
        const target = context.definition.target
        if (target === undefined) continue
        const view = this.views.get(target)
        if (view === undefined) continue
        const node = this.stabilize(view, this.buildNode(context, target))
        context.current.set(target, node)
        if (node !== null) byTarget.get(target)?.push(node)
      }
      for (const view of this.views.values()) {
        const nodes = byTarget.get(view.target) ?? []
        const changed: string[] = []
        const next = new Map<string, ConversationViewNode>()
        for (const node of nodes) {
          if (view.published.get(node.key) !== node) changed.push(node.key)
          next.set(node.key, node)
        }
        const removed = [...view.published.keys()].filter(
          (key) => !next.has(key),
        )
        view.published.clear()
        for (const [key, node] of next) view.published.set(key, node)
        view.snapshot = view.builder.replace({ nodes, timeline })
        report.set(view.target, { changed, removed, replaced: true })
      }
      this.replacePending = false
      this.dirty.clear()
      this.timelineDirty = false
      return { targets: report }
    }

    const upserts = new Map<string, ConversationViewNode[]>()
    const removals = new Map<string, string[]>()
    for (const target of this.views.keys()) {
      upserts.set(target, [])
      removals.set(target, [])
    }
    for (const context of this.dirty) {
      const target = context.definition.target
      if (target === undefined) continue
      const view = this.views.get(target)
      if (view === undefined) continue
      const previous = view.published.get(context.key)
      const node = this.stabilize(view, this.buildNode(context, target))
      context.current.set(target, node)
      if (node === null) {
        if (previous !== undefined) {
          view.published.delete(context.key)
          removals.get(target)?.push(context.key)
        }
        continue
      }
      if (node === previous) continue
      view.published.set(node.key, node)
      upserts.get(target)?.push(node)
    }
    this.dirty.clear()
    const timelineDirty = this.timelineDirty
    this.timelineDirty = false
    for (const view of this.views.values()) {
      const changed = upserts.get(view.target) ?? []
      const removed = removals.get(view.target) ?? []
      if (changed.length === 0 && removed.length === 0 && !timelineDirty)
        continue
      view.snapshot = view.builder.apply({
        upserts: changed,
        removals: removed,
        timeline,
      })
      report.set(view.target, {
        changed: changed.map((node) => node.key),
        removed,
        replaced: false,
      })
    }
    return { targets: report }
  }

  private stabilize(
    view: ViewState,
    node: ConversationViewNode | null,
  ): ConversationViewNode | null {
    if (node === null) return null
    const previous = view.published.get(node.key)
    return previous !== undefined && deepEqual(previous, node) ? previous : node
  }

  private registerLinks(event: WireSessionEvent): ConversationPublication {
    let publication: ConversationPublication = 'none'
    for (const definition of this.definitions) {
      const declared = definition.links?.(event)
      if (declared === undefined) continue
      for (const link of declared) {
        const key = linkKey(definition.kind, link.ns, link.key)
        const entries = this.links.get(key) ?? []
        const entry = { seq: event.seq, id: link.id }
        const last = entries.at(-1)
        if (last === undefined || last.seq < event.seq) entries.push(entry)
        else {
          let index = entries.length
          while (index > 0 && (entries[index - 1] as LinkEntry).seq > event.seq)
            index--
          entries.splice(index, 0, entry)
        }
        this.links.set(key, entries)
        const parked = this.parked.get(key)
        if (parked === undefined) continue
        this.parked.delete(key)
        for (const item of parked) {
          publication = maximumPublication(
            publication,
            this.acceptMatch(item.definition, link.id, 'update', item.event),
          )
        }
      }
    }
    return publication
  }

  /** Alias target for an event at `seq`: latest before it, else first after. */
  private resolveLink(
    definition: ConversationDefinition,
    via: { ns: string; key: string },
    seq: number,
  ): string | undefined {
    const entries = this.links.get(linkKey(definition.kind, via.ns, via.key))
    if (entries === undefined || entries.length === 0) return undefined
    let chosen: LinkEntry | undefined
    for (const entry of entries) {
      if (entry.seq < seq) chosen = entry
      else break
    }
    return (chosen ?? entries.find((entry) => entry.seq > seq))?.id
  }

  private matchInput(event: WireSessionEvent): ConversationPublication {
    let publication: ConversationPublication = 'none'
    for (const definition of this.definitions) {
      const result = definition.match(event)
      if (result === null) continue
      if ('via' in result) {
        const id = this.resolveLink(definition, result.via, event.seq)
        if (id === undefined) {
          const key = linkKey(definition.kind, result.via.ns, result.via.key)
          const parked = this.parked.get(key) ?? []
          parked.push({ definition, event })
          this.parked.set(key, parked)
          continue
        }
        publication = maximumPublication(
          publication,
          this.acceptMatch(definition, id, 'update', event),
        )
        continue
      }
      publication = maximumPublication(
        publication,
        this.acceptMatch(definition, result.id, result.role, event),
      )
    }
    return publication
  }

  private acceptMatch(
    definition: ConversationDefinition,
    id: string,
    role: ConversationMatch['role'],
    event: WireSessionEvent,
  ): ConversationPublication {
    const key = conversationContextKey(definition.kind, id)
    let context = this.contexts.get(key)
    if (role === 'start' && context?.start !== undefined) {
      warn(`${key} received more than one start (seq ${event.seq})`)
      return 'none'
    }
    if (context === undefined) {
      context = {
        key,
        kind: definition.kind,
        id,
        definition,
        startSeq: undefined,
        start: undefined,
        matches: [],
        state: undefined,
        revision: 0,
        current: new Map(),
        dependencies: new Map(),
      }
      this.contexts.set(key, context)
    }
    const match: ConversationMatch = {
      event,
      role,
      location: this.locationIndex.locationOf(event),
    }
    const owners = this.contextsBySeq.get(event.seq) ?? new Set()
    owners.add(context)
    this.contextsBySeq.set(event.seq, owners)
    const last = context.matches.at(-1)
    const inOrder = last === undefined || last.event.seq < event.seq
    if (!inOrder) {
      if (context.matches.some((item) => item.event.seq === event.seq))
        return 'none'
      // A parked (linked) event arriving after later matches of its
      // Context: insert in log order and refold the Context.
      const index = context.matches.findIndex(
        (item) => item.event.seq > event.seq,
      )
      context.matches.splice(index, 0, match)
      if (role === 'start') {
        context.start = match
        context.startSeq = event.seq
        this.indexStartedContext(context)
      }
      if (context.start !== undefined && context.matches[0] !== context.start) {
        warn(`${key} received an update before its start (seq ${event.seq})`)
        context.matches = context.matches.filter(
          (item) => item.event.seq >= (context.startSeq as number),
        )
      }
      this.replayContext(context)
      return definition.publication?.(match) ?? 'immediate'
    }
    if (role === 'start' && context.matches.length > 0) {
      // Updates that precede their start belong to an earlier lifetime of
      // this id (outside or before the window); the start opens a fresh one.
      context.matches = []
    }
    context.matches.push(match)
    if (role === 'start') {
      context.startSeq = event.seq
      context.start = match
      this.indexStartedContext(context)
      this.replayContext(context)
    } else if (context.state !== undefined) {
      const typed = contextSnapshot(context) as ConversationNodeContext & {
        readonly state: unknown
      }
      context.state = this.requireState(
        definition,
        definition.update(typed, match),
        context.state,
      )
      context.revision++
      this.revised.add(context)
    }
    this.dirty.add(context)
    return definition.publication?.(match) ?? 'immediate'
  }

  private replayContexts(contexts: ReadonlySet<InternalContext>): void {
    const ordered = [...contexts].sort(
      (left, right) =>
        (left.startSeq ?? Number.POSITIVE_INFINITY) -
        (right.startSeq ?? Number.POSITIVE_INFINITY),
    )
    for (const context of ordered) {
      if (context.start === undefined) {
        context.state = undefined
        this.dirty.add(context)
        continue
      }
      this.replayContext(context)
    }
  }

  private replayContext(context: InternalContext): void {
    const start = context.start
    if (start === undefined) {
      context.state = undefined
      this.dirty.add(context)
      return
    }
    const dependencies = new Map<string, Dependency>()
    const reader = this.readerFor(start.event.seq, dependencies)
    context.state = undefined
    let state = this.requireState(
      context.definition,
      context.definition.start(contextSnapshot(context), start, reader),
      undefined,
    )
    context.state = state
    this.replaceDependencies(context, dependencies)
    for (let index = 1; index < context.matches.length; index++) {
      const match = context.matches[index]
      if (match === undefined || match.role !== 'update') continue
      const typed = contextSnapshot(context) as ConversationNodeContext & {
        readonly state: unknown
      }
      state = this.requireState(
        context.definition,
        context.definition.update(typed, match),
        state,
      )
      context.state = state
    }
    context.revision++
    this.revised.add(context)
    this.dirty.add(context)
  }

  private requireState(
    definition: ConversationDefinition,
    next: unknown,
    fallback: unknown,
  ): unknown {
    if (next === undefined) {
      warn(`definition "${definition.kind}" returned undefined state`)
      return fallback
    }
    return next
  }

  private replaceDependencies(
    context: InternalContext,
    dependencies: Map<string, Dependency>,
  ): void {
    for (const dependency of context.dependencies.values()) {
      if (dependency.key === undefined) continue
      const current = this.dependents.get(dependency.key)
      current?.delete(context)
      if (current?.size === 0) this.dependents.delete(dependency.key)
    }
    context.dependencies = dependencies
    for (const dependency of dependencies.values()) {
      if (dependency.key === undefined) continue
      const current = this.dependents.get(dependency.key) ?? new Set()
      current.add(context)
      this.dependents.set(dependency.key, current)
    }
  }

  private replayRevisedDependents(): boolean {
    const pending = [...this.revised]
    const affected = new Set<InternalContext>()
    for (let index = 0; index < pending.length; index++) {
      const dependency = pending[index]
      if (dependency === undefined) continue
      for (const dependent of this.dependents.get(dependency.key) ?? []) {
        if (affected.has(dependent)) continue
        affected.add(dependent)
        pending.push(dependent)
      }
    }
    this.replayContexts(affected)
    return affected.size > 0
  }

  private readerFor(
    beforeSeq: number,
    dependencies: Map<string, Dependency>,
  ): ConversationContextReader {
    return {
      previous: <State>(
        kind: string,
      ): ConversationPreviousContext<State> | undefined => {
        const predecessor = this.previousContext(kind, beforeSeq)
        dependencies.set(kind, {
          kind,
          key: predecessor?.key,
          revision: predecessor?.revision,
          windowGap: predecessor === undefined && this.hasMore,
        })
        if (predecessor?.state === undefined) return undefined
        const seq = predecessor.startSeq
        if (seq === undefined) return undefined
        return {
          key: predecessor.key,
          kind: predecessor.kind,
          id: predecessor.id,
          startSeq: seq,
          state: predecessor.state as Readonly<State>,
          matches: predecessor.matches,
        }
      },
    }
  }

  private previousContext(
    kind: string,
    beforeSeq: number,
  ): InternalContext | undefined {
    const candidates = this.contextsByKind.get(kind) ?? []
    const indexBefore = insertionIndex(candidates, beforeSeq)
    for (let index = indexBefore - 1; index >= 0; index--) {
      const candidate = candidates[index]
      if (candidate?.state !== undefined) return candidate
    }
    return undefined
  }

  private indexStartedContext(context: InternalContext): void {
    const seq = context.startSeq
    if (seq === undefined) return
    const candidates = (this.contextsByKind.get(context.kind) ?? []).filter(
      (candidate) => candidate !== context,
    )
    const previous = candidates.at(-1)
    if (previous === undefined || (previous.startSeq as number) < seq)
      candidates.push(context)
    else candidates.splice(insertionIndex(candidates, seq), 0, context)
    this.contextsByKind.set(context.kind, candidates)
  }

  private replayDependencies(): boolean {
    let replayed = false
    const ordered = [...this.contexts.values()]
      .filter((context) => context.startSeq !== undefined)
      .sort(
        (left, right) => (left.startSeq as number) - (right.startSeq as number),
      )
    for (const context of ordered) {
      if (context.state === undefined || context.dependencies.size === 0)
        continue
      const before = context.startSeq as number
      let changed = false
      for (const dependency of context.dependencies.values()) {
        const current = this.previousContext(dependency.kind, before)
        const windowGap = current === undefined && this.hasMore
        if (
          current?.key !== dependency.key ||
          current?.revision !== dependency.revision ||
          windowGap !== dependency.windowGap
        ) {
          changed = true
          break
        }
      }
      if (changed) {
        this.replayContext(context)
        replayed = true
      }
    }
    return replayed
  }

  private refreshMatchLocations(
    changedSeqs: ReadonlySet<number>,
  ): Set<InternalContext> {
    const affected = new Set<InternalContext>()
    if (changedSeqs.size === 0) return affected
    for (const seq of changedSeqs) {
      for (const context of this.contextsBySeq.get(seq) ?? [])
        affected.add(context)
    }
    for (const context of affected) {
      let start = context.start
      context.matches = context.matches.map((match): ConversationMatch => {
        if (!changedSeqs.has(match.event.seq)) return match
        const refreshed = {
          ...match,
          location: this.locationIndex.locationOf(match.event),
        }
        if (match === start) start = refreshed
        return refreshed
      })
      context.start = start
    }
    return affected
  }

  private buildNode(
    context: InternalContext,
    target: string,
  ): ConversationViewNode | null {
    const definition = context.definition
    if (definition.target !== target || definition.buildViewNode === undefined)
      return null
    const node = definition.buildViewNode(contextSnapshot(context))
    if (node === null) return null
    if (node.key !== context.key || node.target !== target) {
      warn(`definition "${context.kind}" built an unstable node`)
      return null
    }
    return node
  }
}
