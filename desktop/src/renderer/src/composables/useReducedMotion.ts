import { onBeforeUnmount, ref, type Ref } from 'vue'

// Central reduced-motion signal. All springs and AppTransition presets consult
// this so individual components never write their own prefers-reduced-motion
// handling. `watch:false` callers can read the current value without a listener.

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return null
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}

export function useReducedMotion(): Ref<boolean> {
  const reduced = ref(query()?.matches ?? false)
  const mql = query()
  if (mql) {
    const onChange = (event: MediaQueryListEvent) => {
      reduced.value = event.matches
    }
    mql.addEventListener('change', onChange)
    onBeforeUnmount(() => mql.removeEventListener('change', onChange))
  }
  return reduced
}

/** Non-reactive snapshot, for one-off imperative checks (e.g. inside springs). */
export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false
}
