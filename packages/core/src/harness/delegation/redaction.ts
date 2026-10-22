export function redactExecutorText(
  text: string,
  secrets: readonly string[] = [],
): string {
  let result = text
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[REDACTED]')
  return result
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(
      /((?:access_token|refresh_token|api_key|apikey)\s*["']?\s*[:=]\s*["']?)[^\s"']+/gi,
      '$1[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
}
