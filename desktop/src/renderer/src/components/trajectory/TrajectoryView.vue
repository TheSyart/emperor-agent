<script setup lang="ts">
/**
 * TrajectoryView — the Trajectory tab of a conversation (dsh
 * ui-trajectory TrajectoryView): toolbar, timeline overview, the
 * turn-aware ledger over the session's raw events and, right of it, the
 * resizable inspector column (the app's only inspector; open state and
 * width live in frameState). Ledger and inspector share one controller per
 * session (useTrajectory).
 *
 * Props: sessionId; focusCallId? (Inspect deep link `?call=`: selected and
 * scrolled into view once loaded, paging older history in when needed);
 * store? (ConversationStore — tests / gallery).
 * Emits: select(recordId | null), open-subagent(sessionId),
 * inspect-applied(callId).
 */
import type { ConversationStore } from '../../conversation/store'
import TrajectorySession from './TrajectorySession.vue'

withDefaults(
  defineProps<{
    sessionId: string
    focusCallId?: string | null
    store?: ConversationStore
  }>(),
  { focusCallId: null, store: undefined },
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
    :store="store"
    @select="$emit('select', $event)"
    @open-subagent="$emit('open-subagent', $event)"
    @inspect-applied="$emit('inspect-applied', $event)"
  />
</template>
