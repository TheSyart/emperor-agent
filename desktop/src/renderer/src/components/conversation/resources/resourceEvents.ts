import type { DisplayResource } from './resourceModel'

export interface ResourceRequest {
  resource: DisplayResource
  sessionId?: string
}
export function requestResourceOpen(
  resource: DisplayResource,
  sessionId?: string,
): void {
  window.dispatchEvent(
    new CustomEvent<ResourceRequest>('emperor:resource-open', {
      detail: { resource, sessionId },
    }),
  )
}
export function requestResourceDetail(
  resource: DisplayResource,
  sessionId?: string,
): void {
  window.dispatchEvent(
    new CustomEvent<ResourceRequest>('emperor:resource-detail', {
      detail: { resource, sessionId },
    }),
  )
}
