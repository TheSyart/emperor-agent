export async function enforceAgentCompletionContract(input: {
  final: string
  requiredSections: readonly string[]
  runRepair(prompt: string): Promise<string>
}): Promise<string> {
  const required = normalizedSections(input.requiredSections)
  if (required.length === 0) return input.final
  const missing = missingSections(input.final, required)
  if (missing.length === 0) return input.final

  const repaired = await input.runRepair(
    [
      'Your response does not satisfy the AgentDefinition completion contract.',
      `Rewrite the complete final response once and include these missing sections: ${missing.join(', ')}.`,
      'Use explicit Markdown headings or a heading followed by a colon. Do not omit evidence or invent results.',
    ].join('\n'),
  )
  const stillMissing = missingSections(repaired, required)
  if (stillMissing.length === 0) return repaired
  return [
    `[ERR] AgentDefinition completion contract remains incomplete after one repair. Missing: ${stillMissing.join(', ')}`,
    repaired,
  ].join('\n\n')
}

export function missingAgentCompletionSections(
  final: string,
  requiredSections: readonly string[],
): string[] {
  return missingSections(final, normalizedSections(requiredSections))
}

function normalizedSections(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function missingSections(final: string, required: readonly string[]): string[] {
  const lines = String(final ?? '').split(/\r?\n/)
  return required.filter(
    (section) =>
      !lines.some((line) => {
        const normalized = line
          .trim()
          .replace(/^#{1,6}\s*/, '')
          .trim()
        return (
          normalized === section ||
          normalized.startsWith(`${section}:`) ||
          normalized.startsWith(`${section}：`)
        )
      }),
  )
}
