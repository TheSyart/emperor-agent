import type { ToolStatus } from '../../types'

export function subagentNodeOpen(subagent: {
  status?: ToolStatus | string
}): boolean {
  return (
    subagent.status === 'running' ||
    subagent.status === 'error' ||
    subagent.status === 'error_aborted'
  )
}
