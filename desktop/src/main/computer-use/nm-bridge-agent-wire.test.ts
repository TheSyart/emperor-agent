// The Agent messages over the real encrypted bridge (PLAN-CAP-001 RV-09):
// pair and authenticate with the extension's own crypto, then check that
// main may send the new requests and that the new events reach the driver.
import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DriverEvent } from '@emperor/core/host-capabilities'
import { NmBridgeServer, type NmBridgeEvent } from './nm-bridge'
import type { BrowserPairing, PairingStore } from './nm-bridge-store'
import { ExternalBrowserDriver } from './external-browser-driver'

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

class Client {
  private buffer = Buffer.alloc(0)
  private readonly messages: unknown[] = []
  private readonly waiters: Array<(value: any) => void> = []

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.buffer.length >= 4) {
        const length = littleEndian
          ? this.buffer.readUInt32LE()
          : this.buffer.readUInt32BE()
        if (this.buffer.length < 4 + length) return
        const frame = JSON.parse(
          this.buffer.subarray(4, 4 + length).toString('utf8'),
        )
        this.buffer = this.buffer.subarray(4 + length)
        const waiter = this.waiters.shift()
        if (waiter) waiter(frame)
        else this.messages.push(frame)
      }
    })
  }

  send(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value))
    const prefix = Buffer.alloc(4)
    if (littleEndian) prefix.writeUInt32LE(body.length)
    else prefix.writeUInt32BE(body.length)
    this.socket.write(Buffer.concat([prefix, body]))
  }

  next(): Promise<any> {
    const queued = this.messages.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('client frame timeout')),
        3_000,
      )
      this.waiters.push((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }
}

function memoryPairings(records: Map<string, BrowserPairing>): PairingStore {
  return {
    get: async (id) => records.get(id) ?? null,
    list: async () =>
      [...records.values()].map(({ secret: _secret, ...item }) => item),
    put: async (item) => {
      records.set(item.pairingId, item)
    },
    remove: async (id) => {
      records.delete(id)
    },
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

describe.skipIf(process.platform !== 'darwin')(
  'the Agent messages over the bridge',
  () => {
    let bridge: NmBridgeServer | null = null
    let client: Client | null = null
    let directory: string | null = null

    afterEach(async () => {
      client?.socket.destroy()
      await bridge?.stop()
      if (directory) await rm(directory, { recursive: true, force: true })
      bridge = null
      client = null
      directory = null
    })

    it('carries tab.open out and a page move back in, sealed', async () => {
      directory = await mkdtemp(join(tmpdir(), 'eanm-agent-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(new Map()),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
      })
      const events: NmBridgeEvent[] = []
      bridge.subscribe((event) => events.push(event))
      await bridge.start()
      const socket = createConnection(bridge.socketPath)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      client = new Client(socket)
      const driver = new ExternalBrowserDriver(bridge)
      const driverEvents: DriverEvent[] = []
      driver.subscribe((event) => driverEvents.push(event))
      const ext: any = await import(
        /* @vite-ignore */ new URL(
          '../../../extension/crypto.js',
          import.meta.url,
        ).href
      )
      const offer = await ext.createPairOffer('a'.repeat(32))
      client.send({
        type: 'request',
        id: 1,
        method: 'pair.begin',
        params: {
          protocol: 1,
          extensionId: offer.extensionId,
          publicKey: offer.publicKey,
          nonce: offer.nonce,
        },
        deadlineMs: 15000,
      })
      const answer = await client.next()
      const pairingId = answer.result.pairingId
      const pair = await ext.finishPairOffer(offer, answer.result)
      client.send({
        type: 'event',
        name: 'pair.displayed',
        data: { pairingId },
      })
      await eventually(() => bridge!.pendingPairings()[0]?.displayed === true)
      expect(await bridge.approvePairing(pairingId)).toBe(true)
      await client.next()
      client.send({
        type: 'event',
        name: 'pair.ready',
        data: {
          pairingId,
          proof: await ext.pairingProof(
            pair.secret,
            pair.transcript,
            'extension-ready',
          ),
        },
      })
      await eventually(() => events.some((event) => event.type === 'paired'))
      const extensionNonce = Buffer.from(
        crypto.getRandomValues(new Uint8Array(16)),
      ).toString('base64url')
      client.send({
        type: 'request',
        id: 2,
        method: 'auth.begin',
        params: { protocol: 1, pairingId, nonce: extensionNonce },
        deadlineMs: 15000,
      })
      const auth = await client.next()
      client.send({
        type: 'request',
        id: 3,
        method: 'auth.finish',
        params: {
          pairingId,
          proof: await ext.authenticationProof(
            pair.secret,
            extensionNonce,
            auth.result.nonce,
            'extension',
          ),
        },
        deadlineMs: 15000,
      })
      expect((await client.next()).result.accepted).toBe(true)
      const traffic = await ext.createTraffic(
        pair.secret,
        extensionNonce,
        auth.result.nonce,
      )
      const seal = async (frame: unknown) =>
        client!.send(await ext.seal(traffic, pairingId, frame))
      const open = async () =>
        ext.open(traffic, pairingId, await client!.next())
      await seal({
        type: 'event',
        name: 'bridge.ready',
        data: { protocol: 1, extensionId: offer.extensionId, workerEpoch: 1 },
      })
      await eventually(() => events.some((event) => event.type === 'ready'))
      expect(driver.openProfile()).toBe(pairingId)

      // Main asks the extension to open a tab.
      const opening = driver.open(
        {
          profile: { kind: 'persistent', profileId: pairingId },
          url: 'https://github.com/emperor',
          ownerSessionId: 'session-1',
        },
        new AbortController().signal,
      )
      const request = await open()
      expect(request).toMatchObject({
        type: 'request',
        method: 'tab.open',
        params: { url: 'https://github.com/emperor' },
      })
      const targetId = '12345678-1234-4234-8234-123456789012'
      await seal({
        type: 'response',
        id: request.id,
        ok: true,
        result: {
          targetId,
          tabId: 41,
          windowId: 3,
          origin: 'https://github.com',
          generation: 2,
        },
      })
      expect((await opening).targetId).toBe(targetId)

      // The page moves by itself: the driver hears it and follows.
      await seal({
        type: 'event',
        name: 'target.navigated',
        data: { targetId, generation: 2, origin: 'https://docs.github.com' },
      })
      const follow = await open()
      expect(follow).toMatchObject({
        method: 'target.follow',
        params: { targetId, generation: 2, origin: 'https://docs.github.com' },
      })
      await seal({
        type: 'response',
        id: follow.id,
        ok: true,
        result: {
          targetId,
          generation: 3,
          origin: 'https://docs.github.com',
          revision: 0,
        },
      })
      await eventually(() =>
        driverEvents.some((event) => event.type === 'navigated'),
      )
      expect(driver.snapshot(targetId)).toMatchObject({
        generation: 3,
        url: 'https://docs.github.com',
      })
      // A malformed Agent event closes the connection.
      await seal({
        type: 'event',
        name: 'target.navigated',
        data: { targetId, generation: 3, origin: 'https://x.example/path' },
      })
      await eventually(() =>
        events.some((event) => event.type === 'disconnected'),
      )
      driver.dispose()
    })
  },
)
