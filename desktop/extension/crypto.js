import { fromBase64Url, randomBytes, toBase64Url } from './protocol.js'

const encoder = new TextEncoder()
const PAIR_LABEL = 'emperor-browser-pair-v1'

async function hkdf(bytes, salt, info, length = 256) {
  const key = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, [
    'deriveBits',
  ])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      key,
      length,
    ),
  )
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(message)),
  )
}

function pairingTranscript(
  extensionId,
  pairingId,
  extensionPublicKey,
  mainPublicKey,
  extensionNonce,
  mainNonce,
) {
  return JSON.stringify([
    PAIR_LABEL,
    extensionId,
    pairingId,
    extensionPublicKey,
    mainPublicKey,
    extensionNonce,
    mainNonce,
  ])
}

export async function createPairOffer(extensionId) {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)),
  )
  const nonce = toBase64Url(randomBytes(16))
  return { privateKey: keys.privateKey, extensionId, publicKey, nonce }
}

export async function finishPairOffer(offer, answer) {
  if (
    typeof answer?.pairingId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(answer.pairingId)
  )
    throw new Error('Invalid pairing ID')
  const mainPublicBytes = fromBase64Url(answer.publicKey)
  const mainNonce = fromBase64Url(answer.nonce)
  if (mainPublicBytes.length !== 65 || mainNonce.length !== 16)
    throw new Error('Invalid pairing response')
  const mainPublicKey = await crypto.subtle.importKey(
    'raw',
    mainPublicBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: mainPublicKey },
      offer.privateKey,
      256,
    ),
  )
  const transcript = pairingTranscript(
    offer.extensionId,
    answer.pairingId,
    offer.publicKey,
    answer.publicKey,
    offer.nonce,
    answer.nonce,
  )
  const secret = await hkdf(
    shared,
    encoder.encode(transcript),
    PAIR_LABEL + ':secret',
  )
  const sasDigest = await hmac(secret, PAIR_LABEL + ':sas:' + transcript)
  const sasNumber =
    ((sasDigest[0] * 2 ** 24 +
      (sasDigest[1] << 16) +
      (sasDigest[2] << 8) +
      sasDigest[3]) >>>
      0) %
    1_000_000
  return {
    pairingId: answer.pairingId,
    secret: toBase64Url(secret),
    code: String(sasNumber).padStart(6, '0'),
    transcript,
  }
}

export async function pairingProof(secret, transcript, side) {
  if (!['main-approved', 'extension-ready'].includes(side))
    throw new Error('Invalid proof side')
  return toBase64Url(
    await hmac(
      fromBase64Url(secret),
      PAIR_LABEL + ':' + side + ':' + transcript,
    ),
  )
}

export async function authenticationProof(
  secret,
  extensionNonce,
  mainNonce,
  side,
) {
  if (!['main', 'extension'].includes(side))
    throw new Error('Invalid proof side')
  return toBase64Url(
    await hmac(
      fromBase64Url(secret),
      JSON.stringify([PAIR_LABEL, 'auth', side, extensionNonce, mainNonce]),
    ),
  )
}

export function equalToken(left, right) {
  try {
    const a = fromBase64Url(left)
    const b = fromBase64Url(right)
    if (a.length !== b.length) return false
    let mismatch = 0
    for (let index = 0; index < a.length; index++)
      mismatch |= a[index] ^ b[index]
    return mismatch === 0
  } catch {
    return false
  }
}

export async function createTraffic(secret, extensionNonce, mainNonce) {
  const salt = encoder.encode(
    JSON.stringify([PAIR_LABEL, 'traffic', extensionNonce, mainNonce]),
  )
  const raw = fromBase64Url(secret)
  const outbound = await hkdf(raw, salt, PAIR_LABEL + ':extension-to-main')
  const inbound = await hkdf(raw, salt, PAIR_LABEL + ':main-to-extension')
  return {
    encryptKey: await crypto.subtle.importKey(
      'raw',
      outbound,
      'AES-GCM',
      false,
      ['encrypt'],
    ),
    decryptKey: await crypto.subtle.importKey(
      'raw',
      inbound,
      'AES-GCM',
      false,
      ['decrypt'],
    ),
    sent: 0,
    received: 0,
  }
}

function ivFor(counter) {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter))
  return iv
}

function aad(pairingId, counter, direction) {
  return encoder.encode(
    JSON.stringify([PAIR_LABEL, pairingId, counter, direction]),
  )
}

export async function seal(traffic, pairingId, payload) {
  const counter = ++traffic.sent
  const plaintext = encoder.encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivFor(counter),
      additionalData: aad(pairingId, counter, 'extension-to-main'),
    },
    traffic.encryptKey,
    plaintext,
  )
  return {
    type: 'secure',
    pairingId,
    counter,
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  }
}

export async function open(traffic, pairingId, frame) {
  if (
    frame?.type !== 'secure' ||
    frame.pairingId !== pairingId ||
    !Number.isSafeInteger(frame.counter) ||
    frame.counter !== traffic.received + 1
  )
    throw new Error('Invalid secure frame sequence')
  const ciphertext = fromBase64Url(frame.ciphertext)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivFor(frame.counter),
      additionalData: aad(pairingId, frame.counter, 'main-to-extension'),
    },
    traffic.decryptKey,
    ciphertext,
  )
  traffic.received = frame.counter
  return JSON.parse(new TextDecoder().decode(plaintext))
}
