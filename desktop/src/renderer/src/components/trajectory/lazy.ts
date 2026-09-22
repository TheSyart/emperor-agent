// Lazy entry points of the trajectory UI: the ledger, timeline, inspector
// and trajectory model stay out of the chat bundle until the Trajectory tab
// (or its inspector) first renders.
import { defineAsyncComponent } from 'vue'

/** Async TrajectoryView (props: sessionId, focusCallId?, inlineInspector?, store?). */
export const TrajectoryViewAsync = defineAsyncComponent(
  () => import('./TrajectoryView.vue'),
)

/** Async TrajectoryInspector (props: sessionId, store?, closable?). */
export const TrajectoryInspectorAsync = defineAsyncComponent(
  () => import('./inspector/TrajectoryInspector.vue'),
)
