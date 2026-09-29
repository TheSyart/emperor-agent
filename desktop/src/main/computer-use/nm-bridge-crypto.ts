/** The main-process half of desktop/extension/crypto.js (wire protocol v1). */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const LABEL = 'emperor-browser-pair-v1'

export function token(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function parseToken(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('invalid token')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== length || token(decoded) !== value)
    throw new Error('invalid token length')
  return decoded
}

function derive(input: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', input, salt, info, 32))
}

function mac(secret: Buffer, text: string): Buffer {
  return createHmac('sha256', secret).update(text).digest()
}

export function matchingToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false
  try {
    const a = Buffer.from(expected, 'base64url')
    const b = Buffer.from(actual, 'base64url')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export interface PairOffer {
  readonly protocol: number
  readonly extensionId: string
  readonly publicKey: string
  readonly nonce: string
}

export interface PendingPair {
  readonly pairingId: string
  readonly extensionId: string
  readonly publicKey: string
  readonly nonce: string
  readonly secret: string
  readonly code: string
  readonly transcript: string
}

export function createPair(offer: PairOffer): PendingPair {
  if (offer.protocol !== 1 || !/^[a-p]{32}$/.test(offer.extensionId))
    throw new Error('invalid pair offer')
  const extensionPublic = parseToken(offer.publicKey, 65)
  const extensionNonce = parseToken(offer.nonce, 16)
  if (extensionPublic[0] !== 4) throw new Error('invalid P-256 point')
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const publicKey = token(ecdh.getPublicKey(undefined, 'uncompressed'))
  const nonce = token(randomBytes(16))
  const pairingId = token(randomBytes(16))
  const transcript = JSON.stringify([
    LABEL,
    offer.extensionId,
    pairingId,
    offer.publicKey,
    publicKey,
    offer.nonce,
    nonce,
  ])
  const shared = ecdh.computeSecret(extensionPublic)
  const secretBytes = derive(shared, Buffer.from(transcript), `${LABEL}:secret`)
  shared.fill(0)
  const digest = mac(secretBytes, `${LABEL}:sas:${transcript}`)
  const code = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
  const secret = token(secretBytes)
  secretBytes.fill(0)
  extensionNonce.fill(0)
  return {
    pairingId,
    extensionId: offer.extensionId,
    publicKey,
    nonce,
    secret,
    code,
    transcript,
  }
}

export function pairProof(
  secret: string,
  transcript: string,
  side: 'main-approved' | 'extension-ready',
): string {
  return token(mac(parseToken(secret, 32), `${LABEL}:${side}:${transcript}`))
}

export function authProof(
  secret: string,
  extensionNonce: string,
  mainNonce: string,
  side: 'main' | 'extension',
): string {
  return token(
    mac(
      parseToken(secret, 32),
      JSON.stringify([LABEL, 'auth', side, extensionNonce, mainNonce]),
    ),
  )
}

export interface Traffic {
  readonly inboundKey: Buffer
  readonly outboundKey: Buffer
  received: number
  sent: number
}

export function createTraffic(
  secret: string,
  extensionNonce: string,
  mainNonce: string,
): Traffic {
  parseToken(extensionNonce, 16)
  parseToken(mainNonce, 16)
  const salt = Buffer.from(
    JSON.stringify([LABEL, 'traffic', extensionNonce, mainNonce]),
  )
  const raw = parseToken(secret, 32)
  const traffic = {
    inboundKey: derive(raw, salt, `${LABEL}:extension-to-main`),
    outboundKey: derive(raw, salt, `${LABEL}:main-to-extension`),
    received: 0,
    sent: 0,
  }
  raw.fill(0)
  return traffic
}

function iv(counter: number): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(BigInt(counter), 4)
  return nonce
}

function aad(pairingId: string, counter: number, direction: string): Buffer {
  return Buffer.from(JSON.stringify([LABEL, pairingId, counter, direction]))
}

export function seal(
  traffic: Traffic,
  pairingId: string,
  message: unknown,
): { type: 'secure'; pairingId: string; counter: number; ciphertext: string } {
  const counter = ++traffic.sent
  const cipher = createCipheriv('aes-256-gcm', traffic.outboundKey, iv(counter))
  cipher.setAAD(aad(pairingId, counter, 'main-to-extension'))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(message)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return { type: 'secure', pairingId, counter, ciphertext: token(ciphertext) }
}

export function open(
  traffic: Traffic,
  pairingId: string,
  frame: unknown,
): unknown {
  if (
    !frame ||
    typeof frame !== 'object' ||
    !('type' in frame) ||
    frame.type !== 'secure' ||
    !('pairingId' in frame) ||
    frame.pairingId !== pairingId ||
    !('counter' in frame) ||
    !Number.isSafeInteger(frame.counter) ||
    frame.counter !== traffic.received + 1 ||
    !('ciphertext' in frame) ||
    typeof frame.ciphertext !== 'string'
  )
    throw new Error('invalid secure frame sequence')
  const secure = frame as {
    counter: number
    ciphertext: string
  }
  const bytes = Buffer.from(secure.ciphertext, 'base64url')
  if (bytes.length < 16) throw new Error('invalid secure frame')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    traffic.inboundKey,
    iv(secure.counter),
  )
  decipher.setAAD(aad(pairingId, secure.counter, 'extension-to-main'))
  decipher.setAuthTag(bytes.subarray(bytes.length - 16))
  const plaintext = Buffer.concat([
    decipher.update(bytes.subarray(0, -16)),
    decipher.final(),
  ])
  traffic.received = secure.counter
  return JSON.parse(plaintext.toString('utf8'))
}
