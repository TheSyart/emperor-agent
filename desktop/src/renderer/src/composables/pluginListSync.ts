/**
 * Keeps the bootstrap plugin list current wherever the user is: Core's
 * `plugins_changed` re-reads `plugins.list` (one read per burst). The
 * composer's `@` list, message chips and the GitHub tabs read that list,
 * not only the plugins page.
 */
import type { Ref } from 'vue'
import { onCoreEvent } from '../api/backend'
import { core } from '../api/http'
import type { BootstrapPayload } from '../types'

export function followPluginList(
  boot: Ref<BootstrapPayload | null>,
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = onCoreEvent((event) => {
    if (
      (event as { event?: unknown } | null)?.event !== 'plugins_changed' ||
      pending !== null
    )
      return
    pending = setTimeout(async () => {
      pending = null
      try {
        const list = await core('plugins.list')
        // A fresh array, so views update even when the bridge hands back the same one.
        if (boot.value) boot.value.plugins = [...list]
      } catch {
        // The next change or a refresh reads it again.
      }
    }, 80)
  })
  return () => {
    unsubscribe()
    if (pending !== null) clearTimeout(pending)
    pending = null
  }
}
