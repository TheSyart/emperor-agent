/**
 * Launch handshake of the macOS Computer Use Helper (SEC-09, MAIN-15).
 *
 * Main listens on a fresh socket in its private run directory, then has
 * LaunchServices start the Helper with a one-time 32-byte secret on the
 * Helper's stdin (a FIFO main holds open), never in argv. The Helper
 * connects and the two prove they hold the secret:
 *
 *   main   → `challenge { nonce: serverNonce }`
 *   Helper → `hello { …, nonce: clientNonce, proof: helloProof }`
 *   main   → `welcome { proof: welcomeProof }`
 *
 * A peer that cannot prove it is dropped and main keeps waiting; a Helper
 * that gets a wrong welcome proof hangs up. The Swift Helper computes the
 * same proofs (`HelperCore/LaunchHandshake.swift`); `fixtures/handshake.json`
 * pins both.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** A nonce or proof on the wire: 32 bytes as 64 lowercase hex digits. */
export const LAUNCH_TOKEN = /^[0-9a-f]{64}$/

export function isLaunchToken(value: unknown): value is string {
  return typeof value === 'string' && LAUNCH_TOKEN.test(value)
}

/** The secret line on the Helper's stdin: 64 hex digits and a newline. */
export function launchSecretLine(secret: Buffer): string {
  return `${secret.toString('hex')}\n`
}

/** The inverse of {@link launchSecretLine}; throws on anything else. */
export function parseLaunchSecret(line: string): Buffer {
  const text = line.endsWith('\n') ? line.slice(0, -1) : line
  if (!LAUNCH_TOKEN.test(text)) throw new Error('invalid launch secret')
  return Buffer.from(text, 'hex')
}

function proof(
  secret: Buffer,
  label: string,
  serverNonce: string,
  clientNonce: string,
): string {
  return createHmac('sha256', secret)
    .update(`${label}\0${serverNonce}\0${clientNonce}`)
    .digest('hex')
}

/** What the Helper sends in `hello`. */
export function helloProof(
  secret: Buffer,
  serverNonce: string,
  clientNonce: string,
): string {
  return proof(secret, 'emperor-helper-hello', serverNonce, clientNonce)
}

/** What main sends in `welcome`. */
export function welcomeProof(
  secret: Buffer,
  serverNonce: string,
  clientNonce: string,
): string {
  return proof(secret, 'emperor-main-welcome', serverNonce, clientNonce)
}

/** Constant-time comparison of two launch tokens. */
export function sameLaunchToken(left: unknown, right: string): boolean {
  if (!isLaunchToken(left) || !isLaunchToken(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
