import { ref, shallowRef } from 'vue'
import type { ReferencePreview } from '@emperor/core/api'
import type { DisplayResource } from './resourceModel'
export function createResourcePreviewState(
  request: (
    sessionId: string,
    resource: DisplayResource,
    signal: AbortSignal,
  ) => Promise<ReferencePreview>,
) {
  const preview = shallowRef<ReferencePreview | null>(null)
  const loading = ref(false)
  let generation = 0
  let controller: AbortController | null = null
  return {
    preview,
    loading,
    async load(sessionId: string, resource: DisplayResource) {
      const current = ++generation
      controller?.abort()
      controller = new AbortController()
      const signal = controller.signal
      preview.value = null
      loading.value = true
      try {
        const result = await request(sessionId, resource, signal)
        if (current === generation) preview.value = result
      } catch {
        if (current === generation)
          preview.value = {
            state: 'error',
            reason: '暂时无法补充详情，可稍后重试。',
            updatedAt: Date.now(),
          }
      } finally {
        if (current === generation) loading.value = false
      }
    },
    clear() {
      generation++
      controller?.abort()
      controller = null
      preview.value = null
      loading.value = false
    },
  }
}
