// Lazy entry point of the trajectory UI: the ledger, timeline, inspector
// and trajectory model stay out of the chat bundle until the Trajectory tab
// first renders.
import { defineAsyncComponent } from 'vue'

/** Async TrajectoryView (props: sessionId, focusCallId?, store?). */
export const TrajectoryViewAsync = defineAsyncComponent(
  () => import('./TrajectoryView.vue'),
)
