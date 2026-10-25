/**
 * The address Core grants a file of the Files pane (files.mediaUrl,
 * `app://workspace-media/<token>`; BUG-05, BUG-10) and what the pane does
 * with it.
 *
 * useMediaAddress: what a player or picture loads (none while the target
 * is null: an inline picture). A failed load asks once
 * more: a new address means the grant ran out (ten minutes), the same one
 * that the file cannot be shown here (`unplayable`); a file removed
 * meanwhile is `missing`. `loaded()` after a success allows the next retry.
 *
 * useFileActions: 「用默认应用打开」 and 「在访达中显示」 — a fresh address,
 * then main acts on the file it names (never a program or script for
 * opening; main checks that again).
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import type { FilePreviewInput } from '@emperor/core/api'
import { core } from '../../api/http'
import { openWorkspaceMedia, revealWorkspaceMedia } from '../../api/backend'

const MISSING = new Set([
  'workspace_path_missing',
  'reference_attachment_unknown',
])

export type MediaAddressState =
  'loading' | 'ready' | 'unplayable' | 'missing' | 'failed'

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useMediaAddress(target: () => FilePreviewInput | null) {
  const url = ref('')
  const state = ref<MediaAddressState>('loading')
  const failure = ref('')
  let generation = 0
  /** A failed load already asked for a new address (reset once one loads). */
  let retried = false

  /** An address; null when it failed (state says why) or went stale. */
  async function address(): Promise<string | null> {
    const asked = generation
    const input = target()
    if (!input) return null
    try {
      const result = await core('files.mediaUrl', { ...input })
      return asked === generation ? result.url : null
    } catch (cause) {
      if (asked !== generation) return null
      const code = (cause as { code?: unknown }).code
      state.value =
        typeof code === 'string' && MISSING.has(code) ? 'missing' : 'failed'
      failure.value = message(cause)
      return null
    }
  }

  async function load(): Promise<void> {
    generation += 1
    retried = false
    failure.value = ''
    if (!target()) {
      url.value = ''
      state.value = 'ready'
      return
    }
    state.value = 'loading'
    const next = await address()
    if (next === null) return
    url.value = next
    state.value = 'ready'
  }

  /** A load failed: true when a new address is being tried. */
  async function failed(): Promise<boolean> {
    if (state.value !== 'ready') return false
    if (!retried) {
      retried = true
      const next = await address()
      if (next === null) return false
      if (next !== url.value) {
        url.value = next
        return true
      }
    }
    state.value = 'unplayable'
    return false
  }

  function loaded(): void {
    retried = false
  }

  watch(
    () => JSON.stringify(target()),
    () => void load(),
    { immediate: true },
  )
  onBeforeUnmount(() => {
    generation += 1
  })

  return { url, state, failure, failed, loaded }
}

export function useFileActions(target: () => FilePreviewInput) {
  const busy = ref<'open' | 'reveal' | null>(null)
  const failure = ref('')

  async function act(action: 'open' | 'reveal'): Promise<void> {
    busy.value = action
    failure.value = ''
    try {
      const { url } = await core('files.mediaUrl', { ...target() })
      if (action === 'open') await openWorkspaceMedia(url)
      else await revealWorkspaceMedia(url)
    } catch (cause) {
      failure.value = message(cause)
    } finally {
      busy.value = null
    }
  }

  return {
    busy,
    failure,
    open: () => act('open'),
    reveal: () => act('reveal'),
  }
}
