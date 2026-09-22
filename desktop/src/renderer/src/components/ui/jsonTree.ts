/** Pure helpers behind JsonTree.vue. */
export type JsonKind =
  'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'other'

export function jsonKind(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object':
      return 'object'
    case 'string':
      return 'string'
    case 'number':
    case 'bigint':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'other'
  }
}

export function jsonEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, i) => [String(i), item])
  if (value && typeof value === 'object') return Object.entries(value)
  return []
}

export function formatJsonPrimitive(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  return String(value)
}

/** Collapsed one-line preview: `{a: 1, b: "x", …}` / `[3]`. */
export function jsonPreview(value: unknown, budget = 48): string {
  if (Array.isArray(value)) return `Array(${value.length})`
  const entries = jsonEntries(value)
  if (entries.length === 0) return '{}'
  let out = '{'
  for (const [index, [key, child]] of entries.entries()) {
    const kind = jsonKind(child)
    const shown =
      kind === 'object'
        ? '{…}'
        : kind === 'array'
          ? '[…]'
          : formatJsonPrimitive(child)
    const part = `${index ? ', ' : ''}${key}: ${shown}`
    if (out.length + part.length > budget) return `${out}${index ? ', ' : ''}…}`
    out += part
  }
  return `${out}}`
}
