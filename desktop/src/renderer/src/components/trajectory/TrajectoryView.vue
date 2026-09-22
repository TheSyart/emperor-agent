<script setup lang="ts">
/**
 * TrajectoryView — the Trajectory tab of a conversation (dsh
 * ui-trajectory TrajectoryView): toolbar, timeline overview and the
 * turn-aware ledger over the session's raw events. The inspector is a
 * separate component (inspector/TrajectoryInspector.vue) the host renders
 * in its details column; both share one controller per session
 * (useTrajectory). `inlineInspector` renders it in a resizable split pane
 * instead (gallery / standalone use).
 *
 * Props: sessionId; focusCallId? (Inspect deep link `?call=`: selected and
 * scrolled into view once loaded); inlineInspector?; store?
 * (ConversationStore — tests / gallery).
 * Emits: select(recordId | null), open-subagent(sessionId),
 * inspect-applied(callId).
 */
import type { ConversationStore } from '../../conversation/store'
import TrajectorySession from './TrajectorySession.vue'

withDefaults(
  defineProps<{
    sessionId: string
    focusCallId?: string | null
    inlineInspector?: boolean
    store?: ConversationStore
  }>(),
  { focusCallId: null, inlineInspector: false, store: undefined },
)
defineEmits<{
  select: [recordId: string | null]
  'open-subagent': [sessionId: string]
  'inspect-applied': [callId: string]
}>()
</script>

<template>
  <TrajectorySession
    :key="sessionId"
    :session-id="sessionId"
    :focus-call-id="focusCallId"
    :inline-inspector="inlineInspector"
    :store="store"
    @select="$emit('select', $event)"
    @open-subagent="$emit('open-subagent', $event)"
    @inspect-applied="$emit('inspect-applied', $event)"
  />
</template>
