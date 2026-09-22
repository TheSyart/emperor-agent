/** Mark an unreachable closed-union branch; throws with the offending value rendered. */
export function assertNever(value: never, context?: string): never {
  const rendered =
    (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(
    `unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`,
  )
}
