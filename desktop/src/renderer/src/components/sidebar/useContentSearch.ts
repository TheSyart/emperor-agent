/**
 * Content search for the sidebar search box (UI-S11, from UI-S02): a pause
 * of CONTENT_SEARCH_DELAY_MS after the last keystroke asks Core
 * `sessions.search` for sessions whose own messages or replies contain the
 * query. A newer query drops an older answer; a failure shows no hits.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { core } from '../../api/http'

export interface ContentHit {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  snippet: string
}

export const CONTENT_SEARCH_DELAY_MS = 250

export function useContentSearch(query: Ref<string>) {
  const hits = ref<ContentHit[]>([])
  const pending = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  function cancel(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    generation += 1
  }

  async function search(text: string, run: number): Promise<void> {
    try {
      const result = (await core('sessions.search', {
        query: text,
        limit: 20,
      })) as { hits?: ContentHit[] }
      if (run === generation) hits.value = result.hits ?? []
    } catch {
      if (run === generation) hits.value = []
    } finally {
      if (run === generation) pending.value = false
    }
  }

  watch(
    () => query.value.trim(),
    (text) => {
      cancel()
      const run = generation
      hits.value = []
      pending.value = Boolean(text)
      if (!text) return
      timer = setTimeout(() => {
        timer = null
        void search(text, run)
      }, CONTENT_SEARCH_DELAY_MS)
    },
  )
  onScopeDispose(cancel)

  return { hits, pending }
}
