/**
 * 独立 reviewer verdict 解析。
 * 解析 ```verdict ...``` JSON 块（最后一个生效）。
 */
const VERDICT_BLOCK = /```verdict\s*([\s\S]*?)```/gi

export interface ReviewerVerdict {
  passed: boolean
  summary: string
  commands: string[]
  commandEvidence: Array<Record<string, unknown>>
}

export function verdictToPayload(v: ReviewerVerdict): Record<string, unknown> {
  return {
    passed: v.passed,
    summary: v.summary,
    commands: [...v.commands],
    command_evidence: [...v.commandEvidence],
  }
}

export function parseReviewerVerdict(
  text: string | null | undefined,
): ReviewerVerdict | null {
  if (!text) return null
  const blocks = [...text.matchAll(VERDICT_BLOCK)].map((m) => m[1]!)
  if (!blocks.length) return null
  const raw = blocks[blocks.length - 1]!.trim() // last block wins
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('passed' in data)
  )
    return null
  const obj = data as Record<string, unknown>
  const commands = ((obj.commands ?? []) as unknown[])
    .map((item) => String(item))
    .filter((item) => item.trim())
  const evidence = ((obj.command_evidence ?? []) as unknown[]).filter(
    (item) => item && typeof item === 'object',
  ) as Array<Record<string, unknown>>
  return {
    passed: Boolean(obj.passed),
    summary: String(obj.summary ?? '').slice(0, 1000),
    commands,
    commandEvidence: evidence,
  }
}
