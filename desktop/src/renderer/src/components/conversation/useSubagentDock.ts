// The subagent status bar's state for ConversationView (UI-S14). The rows
// come from the conversation (the groups ChatTimeline reports, with which
// of them are on screen) and their status from the agent list the
// environment card reads, so the bar, the rows and the card agree. A
// running direct child whose starting call is not in the loaded window is
// listed too. The bar appears once that state has held for a moment (no
// flash while the reader scrolls past a group or the history loads) and
// goes at once.
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import type { AgentView } from '@emperor/core/runtime-contract'
import { conversationContextKey } from '../../conversation/assembler'
import type { ChatSnapshot } from '../../conversation/types'
import { useAgentTree } from '../sidebar/agentTree'
import {
  subagentAgentId,
  subagentDockState,
  subagentRowOf,
  subagentRowOfAgent,
  type SubagentDockState,
  type TimelineAgents,
} from './subagentRows'

const NONE: TimelineAgents = { groups: [], visible: [] }
const HIDDEN: SubagentDockState = { shown: false, rows: [], target: null }
/** How long the bar's conditions hold before it appears. */
export const SUBAGENT_DOCK_DELAY_MS = 300

export function useSubagentDock(input: {
  snapshot: () => ChatSnapshot
  /** The viewed session (its direct children are its subagents). */
  sessionId: () => string
  /** Its root: the agent list's key. */
  rootSessionId: () => string
  /** Off for child sessions and the hero. */
  enabled: () => boolean
}): {
  report: (state: TimelineAgents) => void
  state: ComputedRef<SubagentDockState>
  shown: Ref<boolean>
} {
  const flow = shallowRef<TimelineAgents>(NONE)
  const agentTree = useAgentTree()
  watch(input.sessionId, () => {
    flow.value = NONE
  })

  const state = computed<SubagentDockState>(() => {
    if (!input.enabled()) return HIDDEN
    const root = input.rootSessionId()
    const tree = agentTree.trees[root]
    const listed = (id: string | undefined): AgentView | undefined => {
      const agent = id === undefined ? undefined : tree?.byId[id]
      return agent?.rootSessionId === root ? agent : undefined
    }
    const nodes = input.snapshot().nodes
    const represented = new Set<string>()
    const groups = flow.value.groups.map((group) => ({
      id: group.id,
      rows: group.members.flatMap((key) => {
        const node = nodes.get(key)
        if (node?.kind !== 'tool') return []
        const id = subagentAgentId(node.data)
        if (id !== undefined) represented.add(id)
        return [subagentRowOf(node.data, listed(id))]
      }),
    }))
    const session = input.sessionId()
    const orphans = (tree?.agents ?? [])
      .filter(
        (agent) =>
          agent.parentAgentId === session &&
          (agent.phase === 'running' || agent.phase === 'waiting') &&
          !represented.has(agent.id) &&
          // Its starting call is loaded: the flow shows it (a workflow…).
          !(
            agent.parentCallId !== undefined &&
            nodes.has(conversationContextKey('tool', agent.parentCallId))
          ),
      )
      .map(subagentRowOfAgent)
    return subagentDockState({
      groups,
      orphans,
      visible: flow.value.visible,
    })
  })

  const shown = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(
    () => state.value.shown,
    (next) => {
      clearTimeout(timer)
      if (!next) {
        shown.value = false
        return
      }
      timer = setTimeout(() => {
        shown.value = true
      }, SUBAGENT_DOCK_DELAY_MS)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => clearTimeout(timer))

  return {
    report: (next) => {
      flow.value = next
    },
    state,
    shown,
  }
}
