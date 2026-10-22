/**
 * Dot states (DS-04): green done, amber warning, red error, the gold
 * running pulse (the one running indicator a screen shows), grey idle, and
 * the orange of approvals and plans waiting for the user (attention).
 */
export type DotState =
  'ok' | 'warn' | 'error' | 'running' | 'idle' | 'attention'

/** Map run / tool / job status strings onto the five dot states. */
export function dotFromStatus(status: string | undefined): DotState {
  switch (status) {
    case 'running':
    case 'pending':
    case 'streaming':
    case 'ongoing':
      return 'running'
    case 'error':
    case 'failed':
    case 'denied':
      return 'error'
    case 'warning':
    case 'warn':
    case 'waiting':
    case 'interrupted':
      return 'warn'
    case 'idle':
    case 'queued':
      return 'idle'
    default:
      return 'ok'
  }
}
