/**
 * Keys stay out of what discovery returns: vendor error text is scrubbed
 * before it becomes a message, and a listed id that looks like a credential
 * is dropped rather than shown (some gateways echo tokens or account keys
 * into model ids).
 */

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|or-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[^\s,;"']+/gi,
]

const MIN_SECRET_LENGTH = 8

function usable(secrets: readonly string[]): string[] {
  return secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
}

/** Vendor text with the connection's secrets and token-shaped strings removed. */
export function scrubSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let output = text
  for (const secret of usable(secrets))
    output = output.split(secret).join('***')
  for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, '***')
  return output
}

/**
 * Whether a listed model id carries something credential-like: one of the
 * connection's secrets, a known token format, or a long random segment
 * (32+ letters and digits mixing upper case, lower case and digits).
 * Ordinary ids (`ep-20260101123456-abcde`, `org/Model-7B-Instruct-v0.2`,
 * hex digests) do not match.
 */
export function looksLikeSecret(
  id: string,
  secrets: readonly string[] = [],
): boolean {
  for (const secret of usable(secrets)) if (id.includes(secret)) return true
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(id)) return true
  }
  return id
    .split(/[-_.:/@\s]+/)
    .some(
      (segment) =>
        segment.length >= 32 &&
        /^[A-Za-z0-9]+$/.test(segment) &&
        /[a-z]/.test(segment) &&
        /[A-Z]/.test(segment) &&
        /\d/.test(segment),
    )
}
