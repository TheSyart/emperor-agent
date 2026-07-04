import { ref } from 'vue'
import { core } from '../api/http'
import type { TokensPayload } from '../types'

export function useTokens(showToast: (message: string) => void) {
  const data = ref<TokensPayload | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function load(silent = false) {
    try {
      loading.value = true
      error.value = ''
      data.value = await core<TokensPayload>('memory.tokens')
      if (!silent) showToast('Token 统计已刷新')
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      if (!silent) showToast(`Token 统计加载失败：${error.value}`)
    } finally {
      loading.value = false
    }
  }

  return { data, loading, error, load }
}
