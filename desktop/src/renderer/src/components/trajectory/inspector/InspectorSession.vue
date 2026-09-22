<script setup lang="ts">
/**
 * InspectorSession — binds InspectorPanel to one session's shared
 * controller (keyed by TrajectoryInspector on sessionId).
 *
 * Props: sessionId; store?; closable.
 * Emits: open-subagent(sessionId), close.
 */
import type { ConversationStore } from '../../../conversation/store'
import { useTrajectory } from '../useTrajectory'
import InspectorPanel from './InspectorPanel.vue'

const props = defineProps<{
  sessionId: string
  store?: ConversationStore
  closable: boolean
}>()
defineEmits<{ 'open-subagent': [sessionId: string]; close: [] }>()

const controller = useTrajectory(
  props.sessionId,
  props.store === undefined ? {} : { store: props.store },
)
</script>

<template>
  <InspectorPanel
    :controller="controller"
    :closable="closable"
    @open-subagent="$emit('open-subagent', $event)"
    @close="$emit('close')"
  />
</template>
