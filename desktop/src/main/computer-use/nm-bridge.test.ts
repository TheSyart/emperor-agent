import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NmBridgeServer,
  type NmBridgeEvent,
  type NmHostManifests,
} from './nm-bridge'
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

function manifestRecorder(fail = false): {
  manifests: NmHostManifests
  calls: unknown[][]
} {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      if (fail) throw new Error('disk full')
      return []
    }
  return {
    calls,
    manifests: {
      reconcile: record('reconcile'),
      register: record('register'),
      unregister: record('unregister'),
    },
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
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

describe.skipIf(process.platform !== 'darwin')(
  'Native Messaging main bridge',
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

    it('degrades instead of failing when another Emperor holds the socket', async () => {
      const records = new Map<string, BrowserPairing>()
      records.set('pairing-1', {
        pairingId: 'pairing-1',
        extensionId: 'a'.repeat(32),
        secret: 's'.repeat(43),
        createdAt: '2026-09-26T00:00:00.000Z',
      })
      const pairings = memoryPairings(records)
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      const socketPath = join(directory, 'nm.sock')
      const owner = manifestRecorder()
      bridge = new NmBridgeServer({
        pairings,
        socketPath,
        heartbeatMs: 0,
        manifests: owner.manifests,
      })
      await bridge.start()
      // The socket owner repoints manifests for its pairings at startup.
      expect(owner.calls).toEqual([['reconcile', ['a'.repeat(32)]]])
      const degraded = manifestRecorder()
      const second = new NmBridgeServer({
        pairings,
        socketPath,
        heartbeatMs: 0,
        retryMs: 20,
        manifests: degraded.manifests,
      })
      try {
        await expect(second.startOrDegrade()).resolves.toBe(false)
        // A second instance must not steal the browser's host registration.
        expect(degraded.calls).toEqual([])
        expect(second.unavailableReason).toMatch(/already in use/)
        await expect(second.connectBrowsers()).resolves.toEqual({
          browsers: [],
          reason: 'unavailable',
        })
        expect(degraded.calls).toEqual([])
        await expect(second.revokePairing('pairing-1')).rejects.toThrow(
          'DRIVER_UNAVAILABLE',
        )
        expect(records.has('pairing-1')).toBe(true)
        expect(degraded.calls).toEqual([])
        expect(new ExternalBrowserDriver(second).capability()).toMatchObject({
          stage: 'unavailable',
          available: false,
          reason: expect.stringContaining('另一个 Emperor'),
        })
        // The first instance keeps serving until it exits. The degraded
        // instance then becomes the owner without an application restart.
        expect(bridge.unavailableReason).toBeNull()
        await bridge.stop()
        await eventually(() => second.unavailableReason === null)
        expect(degraded.calls).toEqual([['reconcile', ['a'.repeat(32)]]])
        const recovered = createConnection(socketPath)
        await expect(
          new Promise<void>((resolve, reject) => {
            recovered.once('connect', resolve)
            recovered.once('error', reject)
          }),
        ).resolves.toBeUndefined()
        recovered.destroy()
      } finally {
        await second.stop()
      }
    })

    it('keeps the socket until an in-flight pairing revocation is persisted', async () => {
      const records = new Map<string, BrowserPairing>()
      records.set('pairing-1', {
        pairingId: 'pairing-1',
        extensionId: 'a'.repeat(32),
        secret: 's'.repeat(43),
        createdAt: '2026-09-26T00:00:00.000Z',
      })
      let enteredRemove!: () => void
      const removing = new Promise<void>((resolve) => {
        enteredRemove = resolve
      })
      let finishRemove!: () => void
      const canRemove = new Promise<void>((resolve) => {
        finishRemove = resolve
      })
      const pairings: PairingStore = {
        ...memoryPairings(records),
        remove: async (pairingId) => {
          enteredRemove()
          await canRemove
          records.delete(pairingId)
        },
      }
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      const socketPath = join(directory, 'nm.sock')
      bridge = new NmBridgeServer({
        pairings,
        socketPath,
        heartbeatMs: 0,
      })
      await bridge.start()
      const second = new NmBridgeServer({
        pairings,
        socketPath,
        heartbeatMs: 0,
        retryMs: 20,
      })
      let revocation: Promise<void> | null = null
      let stopping: Promise<void> | null = null
      try {
        expect(await second.startOrDegrade()).toBe(false)
        revocation = bridge.revokePairing('pairing-1')
        await removing
        stopping = bridge.stop()
        expect(
          await Promise.race([
            stopping.then(() => 'stopped'),
            new Promise((resolve) => setTimeout(() => resolve('waiting'), 60)),
          ]),
        ).toBe('waiting')
        expect(second.isListening).toBe(false)
      } finally {
        finishRemove()
        await Promise.allSettled([revocation, stopping].filter(Boolean))
        await second.stop()
      }
      expect(records.has('pairing-1')).toBe(false)
    })

    it('keeps the socket while a browser host registration is in flight', async () => {
      let enteredRegister!: () => void
      const registering = new Promise<void>((resolve) => {
        enteredRegister = resolve
      })
      let finishRegister!: () => void
      const canRegister = new Promise<void>((resolve) => {
        finishRegister = resolve
      })
      const manifests: NmHostManifests = {
        reconcile: async () => [],
        register: async () => {
          enteredRegister()
          await canRegister
          return []
        },
        unregister: async () => [],
      }
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      const socketPath = join(directory, 'nm.sock')
      bridge = new NmBridgeServer({
        pairings: memoryPairings(new Map()),
        socketPath,
        heartbeatMs: 0,
        manifests,
      })
      await bridge.start()
      const second = new NmBridgeServer({
        pairings: memoryPairings(new Map()),
        socketPath,
        heartbeatMs: 0,
        retryMs: 20,
      })
      let registration: ReturnType<NmBridgeServer['connectBrowsers']> | null =
        null
      let stopping: Promise<void> | null = null
      try {
        expect(await second.startOrDegrade()).toBe(false)
        registration = bridge.connectBrowsers()
        await registering
        stopping = bridge.stop()
        expect(
          await Promise.race([
            stopping.then(() => 'stopped'),
            new Promise((resolve) => setTimeout(() => resolve('waiting'), 60)),
          ]),
        ).toBe('waiting')
        expect(second.isListening).toBe(false)
      } finally {
        finishRegister()
        await Promise.allSettled([registration, stopping].filter(Boolean))
        await second.stop()
      }
    })

    it('keeps pairing and revocation working when manifest upkeep fails', async () => {
      const records = new Map<string, BrowserPairing>()
      const pairing = {
        pairingId: 'pairing-1',
        extensionId: 'b'.repeat(32),
        secret: 's'.repeat(43),
        createdAt: '2026-09-26T00:00:00.000Z',
      }
      records.set(pairing.pairingId, pairing)
      records.set('pairing-2', {
        ...pairing,
        pairingId: 'pairing-2',
        extensionId: 'c'.repeat(32),
      })
      const failing = manifestRecorder(true)
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(records),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
        manifests: failing.manifests,
      })
      await expect(bridge.start()).resolves.toBeUndefined()
      await expect(
        bridge.revokePairing('unknown-pairing'),
      ).resolves.toBeUndefined()
      await expect(bridge.revokePairing('pairing-1')).resolves.toBeUndefined()
      expect(records.has('pairing-1')).toBe(false)
      expect(failing.calls).toEqual([
        ['reconcile', ['b'.repeat(32), 'c'.repeat(32)]],
        // An unknown pairing changes no manifest; a real one narrows it.
        ['unregister', 'b'.repeat(32), ['c'.repeat(32)]],
      ])
    })

    it('requires UI code approval, authenticates and loses attached tabs on disconnect', async () => {
      const records = new Map<string, BrowserPairing>()
      const pairings = memoryPairings(records)
      const manifestLog = manifestRecorder()
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings,
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
        manifests: manifestLog.manifests,
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
      // Import the actual extension crypto for cross-process protocol parity.
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
      expect(answer.ok).toBe(true)
      const extensionPair = await ext.finishPairOffer(offer, answer.result)
      expect(bridge.pendingPairings()[0]?.code).toBe(extensionPair.code)
      expect(await bridge.approvePairing(answer.result.pairingId)).toBe(false)
      client.send({
        type: 'event',
        name: 'pair.displayed',
        data: { pairingId: answer.result.pairingId },
      })
      await eventually(() => bridge!.pendingPairings()[0]?.displayed === true)
      expect(await bridge.approvePairing(answer.result.pairingId)).toBe(true)
      // Startup reconciled no pairings; approval admits the extension.
      expect(manifestLog.calls).toEqual([
        ['reconcile', []],
        ['register', 'a'.repeat(32), ['a'.repeat(32)]],
      ])
      const approved = await client.next()
      expect(approved.data.proof).toBe(
        await ext.pairingProof(
          extensionPair.secret,
          extensionPair.transcript,
          'main-approved',
        ),
      )
      client.send({
        type: 'event',
        name: 'pair.ready',
        data: {
          pairingId: answer.result.pairingId,
          proof: await ext.pairingProof(
            extensionPair.secret,
            extensionPair.transcript,
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
        params: {
          protocol: 1,
          pairingId: answer.result.pairingId,
          nonce: extensionNonce,
        },
        deadlineMs: 15000,
      })
      const auth = await client.next()
      expect(auth.result.proof).toBe(
        await ext.authenticationProof(
          extensionPair.secret,
          extensionNonce,
          auth.result.nonce,
          'main',
        ),
      )
      client.send({
        type: 'request',
        id: 3,
        method: 'auth.finish',
        params: {
          pairingId: answer.result.pairingId,
          proof: await ext.authenticationProof(
            extensionPair.secret,
            extensionNonce,
            auth.result.nonce,
            'extension',
          ),
        },
        deadlineMs: 15000,
      })
      expect((await client.next()).result.accepted).toBe(true)
      const traffic = await ext.createTraffic(
        extensionPair.secret,
        extensionNonce,
        auth.result.nonce,
      )
      client.send(
        await ext.seal(traffic, answer.result.pairingId, {
          type: 'event',
          name: 'bridge.ready',
          data: { protocol: 1, extensionId: offer.extensionId, workerEpoch: 1 },
        }),
      )
      await eventually(() => events.some((event) => event.type === 'ready'))
      const targetId = '12345678-1234-1234-1234-123456789012'
      client.send(
        await ext.seal(traffic, answer.result.pairingId, {
          type: 'event',
          name: 'target.attached',
          data: {
            targetId,
            tabId: 7,
            windowId: 2,
            origin: 'https://example.com',
            generation: 5,
          },
        }),
      )
      await eventually(() => driver.listAttached().length === 1)

      const claimed = driver.claimAttachedTarget(
        targetId,
        'session-1',
        new AbortController().signal,
      )
      const listRequest = await ext.open(
        traffic,
        answer.result.pairingId,
        await client.next(),
      )
      expect(listRequest.method).toBe('target.list')
      client.send(
        await ext.seal(traffic, answer.result.pairingId, {
          type: 'response',
          id: listRequest.id,
          ok: true,
          result: {
            targets: [
              {
                targetId,
                tabId: 7,
                windowId: 2,
                origin: 'https://example.com',
                generation: 5,
                revision: 0,
              },
            ],
          },
        }),
      )
      expect((await claimed).kind).toBe('external-tab')
      expect(driver.listAttached()[0]?.claimedBy).toBe('session-1')

      const observation = driver.observe(
        {
          targetId,
          generation: 5,
          budget: {
            maxElements: 200,
            maxTextBytes: 0,
            maxDepth: 8,
            timeoutMs: 3000,
          },
          includeText: false,
        },
        new AbortController().signal,
      )
      const observeRequest = await ext.open(
        traffic,
        answer.result.pairingId,
        await client.next(),
      )
      expect(observeRequest.method).toBe('target.observe')
      client.send(
        await ext.seal(traffic, answer.result.pairingId, {
          type: 'response',
          id: observeRequest.id,
          ok: true,
          result: {
            targetId,
            generation: 5,
            revision: 1,
            origin: 'https://example.com',
            viewport: { width: 800, height: 600, scale: 1 },
            elements: [
              { ref: 'r1.1', role: 'button', name: 'Go', actions: ['click'] },
            ],
            truncated: false,
            redactions: 0,
          },
        }),
      )
      expect((await observation).elements[0]?.name).toBe('Go')
      expect(driver.snapshot(targetId)?.revision).toBe(1)

      await bridge.revokePairing(answer.result.pairingId)
      expect(records.has(answer.result.pairingId)).toBe(false)
      // Last pairing revoked in Emperor: remove the manifests.
      expect(manifestLog.calls.at(-1)).toEqual([
        'unregister',
        'a'.repeat(32),
        [],
      ])
      await eventually(() => driver.listAttached().length === 0)
      expect(events.some((event) => event.type === 'revoked')).toBe(true)
      const retrySocket = createConnection(bridge.socketPath)
      await new Promise<void>((resolve, reject) => {
        retrySocket.once('connect', resolve)
        retrySocket.once('error', reject)
      })
      client = new Client(retrySocket)
      client.send({
        type: 'request',
        id: 4,
        method: 'auth.begin',
        params: {
          protocol: 1,
          pairingId: answer.result.pairingId,
          nonce: extensionNonce,
        },
      })
      expect(await client.next()).toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      })
      driver.dispose()
    })
  },
)
