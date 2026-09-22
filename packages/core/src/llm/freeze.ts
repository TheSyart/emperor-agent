/**
 * Deep-freeze a value in place with an iterative traversal, guarding cycles.
 * AbortSignal objects are skipped: they are a request's live cancellation
 * channel and freezing them breaks abort.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    for (const key of Object.keys(node)) {
      pending.push((node as Record<string, unknown>)[key])
    }
  }
  return value
}

/** Detach a JSON-shaped value from its source and deep-freeze the copy. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}
