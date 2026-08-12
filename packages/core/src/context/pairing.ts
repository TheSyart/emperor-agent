/**
 * context_pipeline: tool_call↔tool_result 配对。
 */
export interface OpenAiMsg {
  role: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
  [k: string]: unknown
}

export function pairToolCalls(
  history: OpenAiMsg[],
): [OpenAiMsg[], number, number] {
  const cleaned: OpenAiMsg[] = []
  const expected: [string, string][] = []
  let filled = 0
  let dropped = 0

  function flushExpected(): void {
    for (const [id, name] of expected) {
      cleaned.push({
        role: 'tool',
        tool_call_id: id,
        name,
        content: '(tool execution interrupted)',
      })
      filled++
    }
    expected.length = 0
  }

  for (const message of history) {
    const copied = { ...message }
    const role = copied.role
    if (role === 'tool') {
      const toolCallId = copied.tool_call_id
      const idx = expected.findIndex(([eid]) => eid === toolCallId)
      if (idx < 0) {
        dropped++
        continue
      }
      cleaned.push(copied)
      expected.splice(idx, 1)
      continue
    }
    flushExpected()
    cleaned.push(copied)
    if (role === 'assistant') {
      for (const tc of (copied.tool_calls as any[]) ?? []) {
        const fn = tc.function ?? {}
        expected.push([tc.id ?? '', fn.name ?? ''])
      }
    }
  }
  flushExpected()
  return [cleaned, filled, dropped]
}
