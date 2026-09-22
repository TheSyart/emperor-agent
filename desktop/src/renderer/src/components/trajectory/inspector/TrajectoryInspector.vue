<script setup lang="ts">
/**
 * TrajectoryInspector — host entry of the trajectory inspector. Rendered by
 * the host in the details column while the Trajectory tab is active (and
 * inline by TrajectoryView when `inlineInspector`); it binds to the same
 * shared controller as the ledger via useTrajectory(sessionId), so
 * selecting a ledger row fills it.
 *
 * Props: sessionId; store? (ConversationStore — tests / gallery);
 * closable? (default true).
 * Emits: open-subagent(sessionId), close.
 */
import type { ConversationStore } from '../../../conversation/store'
import InspectorSession from './InspectorSession.vue'

withDefaults(
  defineProps<{
    sessionId: string
    store?: ConversationStore
    closable?: boolean
  }>(),
  { store: undefined, closable: true },
)
defineEmits<{ 'open-subagent': [sessionId: string]; close: [] }>()
</script>

<template>
  <InspectorSession
    :key="sessionId"
    :session-id="sessionId"
    :store="store"
    :closable="closable"
    @open-subagent="$emit('open-subagent', $event)"
    @close="$emit('close')"
  />
</template>
