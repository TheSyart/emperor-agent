/**
 * Field labels that mark a value as sensitive although the page or app did
 * not use a password field: a revealed password, a one-time code, a card
 * security code. Drivers mask such values in observations (spec 00 §6.4);
 * typing into the field is still allowed.
 */

const SENSITIVE_HINT =
  /pass(?:word|wd|code|phrase)?|pwd|\botp\b|totp|2fa|mfa|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|\bcvv|\bcvc|\bpin\b|密码|口令|验证码|校验码|动态码|安全码/i

/** Whether any of `labels` (name, id, placeholder, accessible name…) hints at a secret. */
export function looksSensitive(
  ...labels: ReadonlyArray<string | undefined>
): boolean {
  return labels.some(
    (value) =>
      value !== undefined && value !== '' && SENSITIVE_HINT.test(value),
  )
}

/** The placeholder observations use in place of a masked value. */
export function maskedValue(raw: string): string {
  return raw === '' ? '' : '[has content]'
}
