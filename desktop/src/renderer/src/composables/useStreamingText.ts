// Render cadence of streaming text (FIX-04, UI-15). While `streaming()` is
// true the returned ref follows `text()` at most once per `ms`: a change
// after a quiet spell shows at once, later ones wait for the end of the
// window and show the latest text. When the stream ends it follows at once.
import {
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  watch,
  type Ref,
} from 'vue'

/** One streaming render per this many milliseconds, at most. */
export const STREAMING_RENDER_MS = 80

export function useStreamingText(
  text: () => string,
  streaming: () => boolean,
  ms = STREAMING_RENDER_MS,
): Readonly<Ref<string>> {
  const shown = shallowRef(text())
  let last = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined

  function publish(): void {
    clearTimeout(timer)
    timer = undefined
    last = Date.now()
    shown.value = text()
  }

  watch([text, streaming], ([, live]) => {
    if (!live) {
      publish()
      return
    }
    if (timer !== undefined) return
    const wait = last + ms - Date.now()
    if (wait <= 0) publish()
    else timer = setTimeout(publish, wait)
  })
  if (getCurrentScope() !== undefined) onScopeDispose(() => clearTimeout(timer))
  return shown
}
