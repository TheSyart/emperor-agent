// One shared second clock for the running subagent rows (UI-S14): every row
// that runs reads the same `now`, and the interval exists only while one of
// them is on the page.
import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'

const now = ref(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

function join(): void {
  users++
  if (timer !== undefined) return
  now.value = Date.now()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}

function leave(): void {
  users = Math.max(0, users - 1)
  if (users > 0 || timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

/**
 * The current time, ticking once a second while `running()` is true; a row
 * that has ended reads it once and does not re-render with the clock.
 */
export function useSubagentNow(running: () => boolean): ComputedRef<number> {
  let joined = false
  watch(
    running,
    (value) => {
      if (value && !joined) join()
      if (!value && joined) leave()
      joined = value
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    if (joined) leave()
    joined = false
  })
  return computed(() => (running() ? now.value : Date.now()))
}
