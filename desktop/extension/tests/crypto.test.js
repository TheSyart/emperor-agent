import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createPairOffer,
  equalToken,
  finishPairOffer,
  pairingProof,
  authenticationProof,
  createTraffic,
  seal,
  open,
} from '../crypto.js'
import {
  fromBase64Url,
  toBase64Url,
  validFrame,
  safeOrigin,
} from '../protocol.js'

const encoder = new TextEncoder()

async function hkdf(bytes, salt, info) {
  const key = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, [
    'deriveBits',
  ])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      key,
      256,
    ),
  )
}

test('MV3 manifest has fixed worker and no blanket host grant or network API', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../manifest.json', import.meta.url)),
  )
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background.type, 'module')
  assert.deepEqual(manifest.permissions, [
    'nativeMessaging',
    'tabs',
    'scripting',
    'storage',
  ])
  // Chrome rejects debugger as optional; the M5 content-script path does not use it.
  assert.equal(manifest.optional_permissions, undefined)
  assert.ok(!manifest.permissions.includes('debugger'))
  assert.equal(manifest.host_permissions, undefined)
  assert.equal(manifest.content_scripts, undefined)
})

test('P-256 pairing derives the same secret and six-digit code on both sides', async () => {
  const offer = await createPairOffer('abcdefghijklmnopabcdefghijklmnop')
  const mainKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
  const mainPublic = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', mainKeys.publicKey)),
  )
  const mainNonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const answer = {
    pairingId: 'pairing_12345678',
    publicKey: mainPublic,
    nonce: mainNonce,
  }
  const extension = await finishPairOffer(offer, answer)
  const extensionPublic = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(offer.publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const sharedMain = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: extensionPublic },
      mainKeys.privateKey,
      256,
    ),
  )
  const transcript = JSON.stringify([
    'emperor-browser-pair-v1',
    offer.extensionId,
    answer.pairingId,
    offer.publicKey,
    answer.publicKey,
    offer.nonce,
    answer.nonce,
  ])
  const mainSecret = toBase64Url(
    await hkdf(
      sharedMain,
      encoder.encode(transcript),
      'emperor-browser-pair-v1:secret',
    ),
  )
  assert.equal(extension.secret, mainSecret)
  assert.match(extension.code, /^\d{6}$/)
  assert.equal(
    equalToken(
      await pairingProof(mainSecret, transcript, 'main-approved'),
      await pairingProof(
        extension.secret,
        extension.transcript,
        'main-approved',
      ),
    ),
    true,
  )
  assert.equal(
    equalToken(
      await authenticationProof(mainSecret, offer.nonce, answer.nonce, 'main'),
      await authenticationProof(
        extension.secret,
        offer.nonce,
        answer.nonce,
        'main',
      ),
    ),
    true,
  )
})

test('traffic is encrypted and rejects tampering or replay', async () => {
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const traffic = await createTraffic(secret, 'extnonce', 'mainnonce')
  const frame = await seal(traffic, 'pairing_12345678', {
    type: 'event',
    name: 'target.attached',
    data: { origin: 'https://example.com' },
  })
  assert.equal(JSON.stringify(frame).includes('example.com'), false)
  const inboundKeyBytes = await hkdf(
    fromBase64Url(secret),
    encoder.encode(
      JSON.stringify([
        'emperor-browser-pair-v1',
        'traffic',
        'extnonce',
        'mainnonce',
      ]),
    ),
    'emperor-browser-pair-v1:main-to-extension',
  )
  const inboundKey = await crypto.subtle.importKey(
    'raw',
    inboundKeyBytes,
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setBigUint64(4, 1n)
  const aad = encoder.encode(
    JSON.stringify([
      'emperor-browser-pair-v1',
      'pairing_12345678',
      1,
      'main-to-extension',
    ]),
  )
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    inboundKey,
    encoder.encode(
      JSON.stringify({
        type: 'request',
        id: 1,
        method: 'tabs.discover',
        params: {},
        deadlineMs: 1000,
      }),
    ),
  )
  const incoming = {
    type: 'secure',
    pairingId: 'pairing_12345678',
    counter: 1,
    ciphertext: toBase64Url(new Uint8Array(encrypted)),
  }
  assert.equal(
    (await open(traffic, 'pairing_12345678', incoming)).method,
    'tabs.discover',
  )
  await assert.rejects(open(traffic, 'pairing_12345678', incoming), /sequence/)
  await assert.rejects(
    open(traffic, 'wrong-pairing', { ...incoming, counter: 2 }),
    /sequence/,
  )
})

test('wire frame and origins accept only fixed shapes', () => {
  assert.equal(
    validFrame({
      type: 'request',
      id: 1,
      method: 'target.observe',
      params: {},
      deadlineMs: 1000,
    }),
    true,
  )
  assert.equal(
    validFrame({
      type: 'request',
      id: 1,
      method: 'eval',
      params: 'alert(1)',
      deadlineMs: 1000,
    }),
    false,
  )
  assert.equal(
    safeOrigin('https://example.com/path?token=secret'),
    'https://example.com',
  )
  assert.equal(safeOrigin('chrome://settings'), null)
})
