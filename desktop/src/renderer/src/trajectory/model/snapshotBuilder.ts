// Keyed `trajectory` target builder (ported from the dsh
// trajectory-snapshot-builder): folds the independently assembled
// contributions into the stage-oriented `TrajectorySnapshot`.
//
// Emperor additions: removals are honoured (the engine may drop a node when
// a Context stops materializing), `request/context` routes are attached to
// their step's request, and a flush that changes no contribution keeps the
// previous snapshot identity.
import type { RequestContext, ToolSchema } from '@emperor/core/runtime-contract'
import type {
  ConversationViewBuilder,
  ConversationViewDefinition,
} from '../../conversation/assembler'
import type {
  TrajectoryAssistantNode,
  TrajectoryAssistantRequest,
  TrajectoryConversationViewNode,
  TrajectoryEventNode,
  TrajectoryLocation,
  TrajectoryRequestHeaderState,
  TrajectoryRequestView,
  TrajectoryRunningCall,
  TrajectorySnapshot,
  TrajectoryToolCallBlock,
  ConversationPromptSnapshot,
} from './contract'

const EMPTY_LIST: readonly never[] = []

/** Stable empty target used until a session has assembled records. */
export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  eventNodes: EMPTY_LIST,
  eventLocations: new Map(),
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  partial: null,
  runningCalls: EMPTY_LIST,
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function locationStepKey(location: TrajectoryLocation): string | undefined {
  return location.kind === 'step'
    ? stepKey(location.turn, location.step)
    : undefined
}

function headerFor(
  request: TrajectoryAssistantRequest,
  headersByStep: ReadonlyMap<string, TrajectoryRequestHeaderState>,
  previous: TrajectoryRequestHeaderState | undefined,
): TrajectoryRequestHeaderState | undefined {
  return (
    headersByStep.get(stepKey(request.turn, request.step)) ??
    (previous !== undefined && previous.seq < request.startSeq
      ? previous
      : undefined)
  )
}

function applyHeader(
  request: TrajectoryAssistantRequest,
  header: TrajectoryRequestHeaderState | undefined,
  includeChange: boolean,
  route: RequestContext | undefined,
): TrajectoryAssistantRequest {
  const withRoute = route === undefined ? request : { ...request, route }
  return header === undefined
    ? withRoute
    : {
        ...withRoute,
        prompt: header.prompt,
        requestConfig: header.prompt.config,
        ...(includeChange && header.change !== undefined
          ? { promptChange: header.change }
          : {}),
      }
}

function withRequestConfig(
  node: TrajectoryAssistantNode,
  prompt: ConversationPromptSnapshot | undefined,
): TrajectoryAssistantNode {
  return prompt === undefined ? node : { ...node, requestConfig: prompt.config }
}

function captureSchemas(
  block: TrajectoryToolCallBlock,
  toolsByName: ReadonlyMap<string, ToolSchema>,
  output: Map<string, ToolSchema>,
): void {
  const name = 'kind' in block ? block.call?.name : block.name
  const schema = name === undefined ? undefined : toolsByName.get(name)
  if (schema !== undefined) output.set(block.callId, schema)
  for (const child of block.subCalls) captureSchemas(child, toolsByName, output)
}

function indexTools(
  tools: readonly ToolSchema[],
): ReadonlyMap<string, ToolSchema> {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function interruptCompactions(
  requests: TrajectoryRequestView[],
  boundaries: readonly { seq: number; time: number }[],
): void {
  let nextRequest = 0
  const runningCompactions: number[] = []
  for (const boundary of boundaries) {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest]
      if (request === undefined || request.startSeq >= boundary.seq) break
      if (request.purpose === 'compaction' && request.status === 'running')
        runningCompactions.push(nextRequest)
      nextRequest++
    }
    let index = runningCompactions.pop()
    while (index !== undefined && requests[index]?.status !== 'running')
      index = runningCompactions.pop()
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      status: 'error',
      error: 'Compaction was interrupted before completion.',
    }
  }
}

function applyTurnErrors(
  requests: TrajectoryRequestView[],
  endings: readonly { turn: number; time: number; error?: string }[],
): void {
  const lastAssistantByTurn = new Map<number, number>()
  for (const [index, request] of requests.entries()) {
    if (request.purpose === 'assistant')
      lastAssistantByTurn.set(request.turn, index)
  }
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = lastAssistantByTurn.get(ending.turn)
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      status: 'error',
      error: ending.error,
    }
  }
}

function compareContributions(
  left: TrajectoryConversationViewNode,
  right: TrajectoryConversationViewNode,
): number {
  return (
    left.anchorSeq - right.anchorSeq ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  )
}

/** Simple keyed builder retaining the stage-oriented Trajectory snapshot. */
export class TrajectorySnapshotBuilder implements ConversationViewBuilder<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> {
  readonly empty = EMPTY_TRAJECTORY_SNAPSHOT
  private readonly nodes = new Map<string, TrajectoryConversationViewNode>()
  private readonly positions = new Map<string, number>()
  private contributions: TrajectoryConversationViewNode[] = []
  private current: TrajectorySnapshot = EMPTY_TRAJECTORY_SNAPSHOT

  replace(input: {
    readonly nodes: readonly TrajectoryConversationViewNode[]
  }): TrajectorySnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    this.rebuildContributions()
    this.current = this.snapshot()
    return this.current
  }

  apply(input: {
    readonly upserts: readonly TrajectoryConversationViewNode[]
    readonly removals?: readonly string[]
  }): TrajectorySnapshot {
    const removals = input.removals ?? []
    if (input.upserts.length === 0 && removals.length === 0) return this.current
    let structural = false
    for (const key of removals) {
      if (this.nodes.delete(key)) structural = true
    }
    for (const node of input.upserts) {
      const previous = this.nodes.get(node.key)
      this.nodes.set(node.key, node)
      if (previous === undefined || previous.anchorSeq !== node.anchorSeq) {
        structural = true
        continue
      }
      const position = this.positions.get(node.key)
      if (position === undefined) structural = true
      else this.contributions[position] = node
    }
    if (structural) this.rebuildContributions()
    this.current = this.snapshot()
    return this.current
  }

  private snapshot(): TrajectorySnapshot {
    const headersByStep = new Map<string, TrajectoryRequestHeaderState>()
    const routesByStep = new Map<string, RequestContext>()
    for (const contribution of this.contributions) {
      const data = contribution.data
      if (data.kind === 'request-header') {
        const key = locationStepKey(data.header.location)
        if (key !== undefined) headersByStep.set(key, data.header)
      } else if (data.kind === 'request-context') {
        const key = locationStepKey(data.location)
        if (key !== undefined) routesByStep.set(key, data.context)
      }
    }
    const finalized: TrajectoryEventNode[] = []
    const eventLocations = new Map<number, TrajectoryLocation>()
    const requests: TrajectoryRequestView[] = []
    const boundaries: { seq: number; time: number }[] = []
    const turnEndings: { turn: number; time: number; error?: string }[] = []
    const callSchemas = new Map<string, ToolSchema>()
    const consumedPromptChanges = new Set<number>()
    let previousHeader: TrajectoryRequestHeaderState | undefined
    let previousTools: ReadonlyMap<string, ToolSchema> = new Map()
    let partial: TrajectorySnapshot['partial'] = null
    const runningCalls: TrajectoryRunningCall[] = []

    for (const contribution of this.contributions) {
      const data = contribution.data
      switch (data.kind) {
        case 'request-header':
          previousHeader = data.header
          previousTools = indexTools(data.header.prompt.tools)
          break
        case 'request-context':
          break
        case 'node':
          finalized.push(data.node)
          eventLocations.set(data.node.seq, contribution.location)
          break
        case 'assistant': {
          const header =
            data.request === undefined
              ? undefined
              : headerFor(data.request, headersByStep, previousHeader)
          if (data.node !== undefined)
            finalized.push(withRequestConfig(data.node, header?.prompt))
          if (data.partial !== null) partial = data.partial
          if (data.request !== undefined) {
            const includeChange =
              header?.change !== undefined &&
              !consumedPromptChanges.has(header.seq)
            requests.push(
              applyHeader(
                data.request,
                header,
                includeChange,
                routesByStep.get(stepKey(data.request.turn, data.request.step)),
              ),
            )
            if (includeChange && header !== undefined)
              consumedPromptChanges.add(header.seq)
          }
          break
        }
        case 'tool':
          if ('kind' in data.root) finalized.push(data.root)
          else runningCalls.push(data.root)
          if (
            previousHeader !== undefined &&
            previousHeader.seq < contribution.anchorSeq
          )
            captureSchemas(data.root, previousTools, callSchemas)
          break
        case 'compaction':
          requests.push(data.request)
          break
        case 'session-end':
          boundaries.push({ seq: data.seq, time: data.time })
          break
        case 'turn-end':
          turnEndings.push({
            turn: data.turn,
            time: data.time,
            ...(data.error === undefined ? {} : { error: data.error }),
          })
          break
      }
    }

    requests.sort((left, right) => left.startSeq - right.startSeq)
    interruptCompactions(requests, boundaries)
    applyTurnErrors(requests, turnEndings)
    finalized.sort((left, right) => left.seq - right.seq)
    return {
      eventNodes: finalized,
      eventLocations,
      requests,
      callSchemas,
      partial,
      runningCalls,
    }
  }

  private rebuildContributions(): void {
    this.contributions = [...this.nodes.values()].sort(compareContributions)
    this.positions.clear()
    for (const [index, contribution] of this.contributions.entries())
      this.positions.set(contribution.key, index)
  }
}

/** `trajectory` target factory. */
export const trajectoryViewDefinition: ConversationViewDefinition<
  TrajectoryConversationViewNode,
  TrajectorySnapshot
> = {
  target: 'trajectory',
  create: () => new TrajectorySnapshotBuilder(),
}
