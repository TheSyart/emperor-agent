import { onBeforeUnmount, ref, type Ref } from 'vue'

/** Write text to the clipboard; resolves false when the platform refuses. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Copy-with-confirmation state for the block primitives: `copied` flips true
 * for `holdMs` after a successful copy, then resets.
 */
export function useCopyFeedback(
  source: () => string,
  holdMs = 1000,
): { copied: Ref<boolean>; copy: () => Promise<void> } {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  async function copy() {
    if (copied.value) return
    if (!(await writeClipboard(source()))) return
    copied.value = true
    timer = setTimeout(() => {
      copied.value = false
    }, holdMs)
  }
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })
  return { copied, copy }
}
