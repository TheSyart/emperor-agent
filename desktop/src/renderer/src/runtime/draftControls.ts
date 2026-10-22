/**
 * The start page shows its draft's own plan mode and preset, and no goal:
 * never the previous chat's (FIX-13). ConversationView applies it when a
 * draft comes on screen (in the chat chunk, outside the first-load budget).
 */
import type { Ref } from 'vue'
import type { BootstrapPayload, ControlPayload, SessionInfo } from '../types'

/**
 * The draft's settings at once over the control shown now, then over the
 * defaults Core reports (`control.get(null)`). `draft` is the draft while
 * it is still on screen.
 */
export async function showDraftControls(
  boot: Ref<BootstrapPayload | null>,
  draft: () => SessionInfo | undefined,
  defaults: () => Promise<unknown>,
): Promise<void> {
  const show = (control?: unknown) => {
    const shown = draft()
    if (!boot.value || !shown) return
    const base = (control ?? boot.value.control) as ControlPayload | undefined
    const preset = shown.preset ?? base?.preset ?? 'workspace-write'
    boot.value.control = {
      ...base,
      preset,
      mode: preset,
      plan: shown.plan === true,
      pending: null,
    }
    boot.value.goals = { active: null }
  }
  show()
  show(await defaults().catch(() => undefined))
}
