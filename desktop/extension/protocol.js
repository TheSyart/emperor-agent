export const PROTOCOL = 1
export const HOST_NAME = 'com.emperor.agent.browser'
export const MAX_JSON_BYTES = 900_000 // Chrome: native host -> extension is limited to 1 MB.
export const MAX_INPUT_TEXT = 16_384

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validFrame(value) {
  if (
    !isObject(value) ||
    !['request', 'response', 'event', 'cancel', 'ping', 'pong'].includes(
      value.type,
    )
  )
    return false
  if (value.type === 'request')
    return (
      Number.isSafeInteger(value.id) &&
      value.id >= 0 &&
      typeof value.method === 'string' &&
      value.method.length <= 64 &&
      isObject(value.params) &&
      Number.isSafeInteger(value.deadlineMs) &&
      value.deadlineMs > 0 &&
      value.deadlineMs <= 120_000
    )
  if (value.type === 'response')
    return (
      Number.isSafeInteger(value.id) &&
      value.id >= 0 &&
      typeof value.ok === 'boolean' &&
      (value.ok ? 'result' in value : isObject(value.error))
    )
  if (value.type === 'event')
    return (
      typeof value.name === 'string' &&
      value.name.length <= 64 &&
      isObject(value.data)
    )
  return (
    Number.isSafeInteger(value.id ?? value.seq) && (value.id ?? value.seq) >= 0
  )
}

export function safeOrigin(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.origin
      : null
  } catch {
    return null
  }
}

export function error(code, message, retryable = false) {
  return { code, message, retryable }
}

export function toBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > 4096
  )
    throw new Error('Invalid base64url')
  const binary = atob(
    value.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (value.length % 4)) % 4),
  )
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length))
}
