// Trajectory request-header facts (ported from the dsh
// trajectory-request-header-definition) plus Emperor's per-request route
// (`request/context`). A header's change kind is classified against the
// previous header in the window; a window whose first header is not the
// session's initial one records no change (it is not the initial prompt).
import type {
  ConversationDefinition,
  ConversationMatch,
} from '../../../conversation/assembler'
import { isEvent } from '../../../conversation/events'
import type {
  ConversationPromptSnapshot,
  RequestPromptChange,
  TrajectoryRequestHeaderState,
} from '../contract'
import { trajectoryLocation, trajectoryNode } from './common'

const HEADER_KIND = 'trajectory-request-header'

function requestPrompt(match: ConversationMatch): ConversationPromptSnapshot {
  if (!isEvent(match.event, 'request/header'))
    throw new Error('trajectory-request-header start requires request/header')
  const header = match.event.data.header
  const tools: unknown = header.tools
  return {
    config: header.config,
    system: header.system ?? '',
    tools: Array.isArray(tools)
      ? (tools as ConversationPromptSnapshot['tools'])
      : [],
  }
}

/** Classify a header against the previous prompt state of the window. */
export function promptChangeOf(
  previous: ConversationPromptSnapshot | undefined,
  prompt: ConversationPromptSnapshot,
  match: ConversationMatch,
): RequestPromptChange | undefined {
  const event = match.event
  if (!isEvent(event, 'request/header')) return undefined
  if (previous === undefined && event.data.reason !== 'initial')
    return undefined
  const systemChanged =
    previous !== undefined && previous.system !== prompt.system
  const toolsChanged =
    previous !== undefined &&
    JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (previous !== undefined && !systemChanged && !toolsChanged)
    return undefined
  return {
    seq: event.seq,
    time: event.time,
    kind:
      previous === undefined
        ? 'initial'
        : systemChanged && toolsChanged
          ? 'system-and-tools'
          : systemChanged
            ? 'system'
            : 'tools',
    ...(previous === undefined ? {} : { previous }),
  }
}

export const trajectoryRequestHeaderDefinition: ConversationDefinition<TrajectoryRequestHeaderState> =
  {
    kind: HEADER_KIND,
    target: 'trajectory',
    match: (event) =>
      isEvent(event, 'request/header')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
      const prompt = requestPrompt(match)
      const previous =
        reader.previous<TrajectoryRequestHeaderState>(HEADER_KIND)?.state.prompt
      const change = promptChangeOf(previous, prompt, match)
      return {
        seq: match.event.seq,
        time: match.event.time,
        prompt,
        location: trajectoryLocation(match.location),
        ...(change === undefined ? {} : { change }),
      }
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined
        ? null
        : trajectoryNode(context, context.state.seq, {
            kind: 'request-header',
            header: context.state,
          }),
  }

/** Route (provider / model / context window) reported for one request. */
export const trajectoryRequestContextDefinition: ConversationDefinition<ConversationMatch> =
  {
    kind: 'trajectory-request-context',
    target: 'trajectory',
    match: (event) =>
      isEvent(event, 'request/context')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => match,
    update: (context) => context.state,
    buildViewNode: (context) => {
      const event = context.state?.event
      if (event === undefined || !isEvent(event, 'request/context')) return null
      return trajectoryNode(context, event.seq, {
        kind: 'request-context',
        seq: event.seq,
        context: event.data,
        location: trajectoryLocation(context.state?.location),
      })
    },
  }
