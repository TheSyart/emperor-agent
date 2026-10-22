import { nextTick, shallowRef } from 'vue'
import type { WorkspaceFileRequest } from '../workspace/workspaceState'

export interface ViewerImage {
  id: string
  src: string
  name: string
  caption?: string
  file?: WorkspaceFileRequest
}
export interface ImageViewerRequest {
  owner: string
  items: readonly ViewerImage[]
  index?: number
  dispose?: () => void
}
export const imageViewer = shallowRef<
  (ImageViewerRequest & { trigger: HTMLElement | null }) | null
>(null)

export function safeViewerSource(src: string): boolean {
  return (
    /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(src) ||
    /^app:\/\/attachments\/att_\d{4}-\d{2}_[a-f\d]{8}\/raw$/.test(src) ||
    /^blob:(?:app:\/\/bundle|https?:\/\/[^/]+)\/[\w-]+$/.test(src)
  )
}
/**
 * Where a click on an image goes: the in-app viewer for sources it accepts,
 * the user's browser for remote http(s) images (and SVG), nowhere otherwise.
 */
export function imageClickTarget(src: string): 'viewer' | 'external' | 'none' {
  if (safeViewerSource(src)) return 'viewer'
  return /^https?:\/\//i.test(src) ? 'external' : 'none'
}
export function openImageViewer(request: ImageViewerRequest): void {
  const items = request.items.filter((item) => safeViewerSource(item.src))
  const selected = request.items[request.index ?? 0]
  if (
    !items.length ||
    !request.owner ||
    !selected ||
    !safeViewerSource(selected.src)
  ) {
    // The caller handed over blob URLs it expects the viewer to release.
    request.dispose?.()
    closeImageViewer()
    return
  }
  imageViewer.value?.dispose?.()
  imageViewer.value = {
    ...request,
    items,
    index: Math.max(
      0,
      items.findIndex((item) => item === selected),
    ),
    trigger:
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  }
}
export function closeImageViewer(): void {
  imageViewer.value?.dispose?.()
  const trigger = imageViewer.value?.trigger
  imageViewer.value = null
  void nextTick(() => {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  })
}
