import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NmBridgeServer,
  PAIRING_UNKNOWN,
  type NmBridgeEvent,
  type NmHostManifests,
} from './nm-bridge'
import { EMPEROR_EXTENSION_ID } from './nm-manifest'
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

describe('Native Messaging pairing protocol', () => {
  it('names PAIRING_UNKNOWN the same on both sides', () => {
    expect(PAIRING_UNKNOWN).toBe('PAIRING_UNKNOWN')
    const extension = readFileSync(
      new URL('../../../extension/protocol.js', import.meta.url),
      'utf8',
    )
    expect(extension).toContain(
      `export const PAIRING_UNKNOWN = '${PAIRING_UNKNOWN}'`,
    )
  })
})

/** Connects a raw client to the bridge's socket. */
async function connect(socketPath: string): Promise<Client> {
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return new Client(socket)
}

function nonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    'base64url',
  )
}

/**
 * Pair a fresh client with `bridge` through the real extension crypto and
 * authenticate it; `ready` is merged into bridge.ready's data.
 */
async function pairedClient(
  bridge: NmBridgeServer,
  options: { browser?: unknown; ready?: Record<string, unknown> } = {},
) {
  const socket = createConnection(bridge.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const client = new Client(socket)
  const ext: any = await import(
    /* @vite-ignore */ new URL('../../../extension/crypto.js', import.meta.url)
      .href
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
      ...(options.browser === undefined ? {} : { browser: options.browser }),
    },
    deadlineMs: 15000,
  })
  const answer = await client.next()
  const pairingId: string = answer.result.pairingId
  const pair = await ext.finishPairOffer(offer, answer.result)
  client.send({ type: 'event', name: 'pair.displayed', data: { pairingId } })
  await eventually(() => bridge.pendingPairings()[0]?.displayed === true)
  const pending = bridge.pendingPairings()[0]!
  expect(await bridge.approvePairing(pairingId)).toBe(true)
  await client.next() // pair.approved
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
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString('base64url')
  client.send({
    type: 'request',
    id: 2,
    method: 'auth.begin',
    params: { protocol: 1, pairingId, nonce },
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
        nonce,
        auth.result.nonce,
        'extension',
      ),
    },
    deadlineMs: 15000,
  })
  expect((await client.next()).result.accepted).toBe(true)
  const traffic = await ext.createTraffic(pair.secret, nonce, auth.result.nonce)
  client.send(
    await ext.seal(traffic, pairingId, {
      type: 'event',
      name: 'bridge.ready',
      data: {
        protocol: 1,
        extensionId: offer.extensionId,
        workerEpoch: 1,
        ...options.ready,
      },
    }),
  )
  await eventually(() => bridge.readyPairings().includes(pairingId))
  return {
    client,
    pairingId,
    pending,
    /** The next frame from main, decrypted. */
    next: async () => ext.open(traffic, pairingId, await client.next()),
    reply: async (frame: unknown) =>
      client.send(await ext.seal(traffic, pairingId, frame)),
  }
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
        // Still the experimental driver, just not able to act here.
        expect(new ExternalBrowserDriver(second).capability()).toMatchObject({
          stage: 'experimental',
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

    it('answers PAIRING_UNKNOWN for a pairing it does not hold, PERMISSION_DENIED otherwise', async () => {
      const records = new Map<string, BrowserPairing>()
      records.set('pairing-1', {
        pairingId: 'pairing-1',
        extensionId: 'a'.repeat(32),
        secret: Buffer.alloc(32, 9).toString('base64url'),
        createdAt: '2026-10-01T00:00:00.000Z',
      })
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(records),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
      })
      await bridge.start()
      client = await connect(bridge.socketPath)
      const begin = (id: number, params: Record<string, unknown>) =>
        client!.send({
          type: 'request',
          id,
          method: 'auth.begin',
          params,
          deadlineMs: 15000,
        })
      // Never paired here, or cleared with a version 1 store: pair again.
      begin(1, { protocol: 1, pairingId: 'pairing-gone', nonce: nonce() })
      expect(await client.next()).toMatchObject({
        id: 1,
        ok: false,
        error: { code: 'PAIRING_UNKNOWN', message: 'PAIRING_UNKNOWN' },
      })
      // Malformed requests are refused as before; a pairing is never dropped.
      begin(2, { protocol: 2, pairingId: 'pairing-1', nonce: nonce() })
      expect(await client.next()).toMatchObject({
        id: 2,
        error: { code: 'PERMISSION_DENIED' },
      })
      begin(3, { protocol: 1, pairingId: 'pairing-1', nonce: 'short' })
      expect(await client.next()).toMatchObject({
        id: 3,
        error: { code: 'PERMISSION_DENIED' },
      })
      // A store that cannot be read fails closed, not as unknown.
      const failing = new NmBridgeServer({
        pairings: {
          ...memoryPairings(records),
          get: async () => {
            throw new Error('pairing file permissions are not 0600')
          },
        },
        socketPath: join(directory, 'failing.sock'),
        heartbeatMs: 0,
      })
      await failing.start()
      try {
        const other = await connect(failing.socketPath)
        other.send({
          type: 'request',
          id: 4,
          method: 'auth.begin',
          params: { protocol: 1, pairingId: 'pairing-1', nonce: nonce() },
          deadlineMs: 15000,
        })
        expect(await other.next()).toMatchObject({
          id: 4,
          error: { code: 'PERMISSION_DENIED' },
        })
        other.socket.destroy()
      } finally {
        await failing.stop()
      }
      // The known pairing still authenticates.
      begin(5, { protocol: 1, pairingId: 'pairing-1', nonce: nonce() })
      expect(await client.next()).toMatchObject({ id: 5, ok: true })
      expect(records.has('pairing-1')).toBe(true)
    })

    it('drops a connection that sends a frame over 64 KiB before it authenticates (SEC-10)', async () => {
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(new Map()),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
      })
      await bridge.start()
      client = await connect(bridge.socketPath)
      const closed = new Promise<void>((resolve) =>
        client!.socket.once('close', () => resolve()),
      )
      // A 1 MiB frame: the header alone is enough to refuse it.
      const header = Buffer.alloc(4)
      if (littleEndian) header.writeUInt32LE(1024 * 1024)
      else header.writeUInt32BE(1024 * 1024)
      client.socket.write(Buffer.concat([header, Buffer.alloc(1024, 0x20)]))
      await expect(
        Promise.race([
          closed.then(() => 'closed'),
          new Promise((resolve) => setTimeout(() => resolve('open'), 2_000)),
        ]),
      ).resolves.toBe('closed')
      // A frame of exactly 64 KiB is still read (and refused as malformed
      // JSON the usual way), so the limit is the frame size, not the socket.
      const other = await connect(bridge.socketPath)
      const body = Buffer.alloc(64 * 1024, 0x20)
      body.write('{"type":"event","name":"pair.displayed","data":{}}')
      const prefix = Buffer.alloc(4)
      if (littleEndian) prefix.writeUInt32LE(body.length)
      else prefix.writeUInt32BE(body.length)
      const otherClosed = new Promise<void>((resolve) =>
        other.socket.once('close', () => resolve()),
      )
      other.socket.write(Buffer.concat([prefix, body]))
      // pair.displayed without a pending pairing is a protocol error: the
      // frame was parsed (not dropped for its size) and the socket closes.
      await otherClosed
      other.socket.destroy()
    })

    /** A bridge with a settable clock and a raw `pair.begin` sender. */
    async function pairingBridge() {
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      const clock = { now: 1_000_000 }
      const server = new NmBridgeServer({
        pairings: memoryPairings(new Map()),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
        now: () => clock.now,
      })
      bridge = server
      await server.start()
      const ext: any = await import(
        /* @vite-ignore */ new URL(
          '../../../extension/crypto.js',
          import.meta.url,
        ).href
      )
      const clients: Client[] = []
      const begin = async (id: number) => {
        const offer = await ext.createPairOffer('a'.repeat(32))
        const next = await connect(server.socketPath)
        clients.push(next)
        next.send({
          type: 'request',
          id,
          method: 'pair.begin',
          params: {
            protocol: 1,
            extensionId: offer.extensionId,
            publicKey: offer.publicKey,
            nonce: offer.nonce,
          },
          deadlineMs: 15000,
        })
        return { client: next, answer: await next.next() }
      }
      /** The extension gave up: its pending pairing goes with the socket. */
      const drop = async (item: { client: Client }) => {
        const pending = server.pendingPairings().length
        item.client.socket.destroy()
        await eventually(() => server.pendingPairings().length < pending)
      }
      return {
        server,
        clock,
        begin,
        drop,
        close: () => {
          for (const item of clients) item.socket.destroy()
        },
      }
    }

    it('holds at most 3 pairings waiting for the user (SEC-10)', async () => {
      const t = await pairingBridge()
      try {
        const waiting = [await t.begin(1), await t.begin(2), await t.begin(3)]
        for (const item of waiting)
          expect(item.answer).toMatchObject({ ok: true })
        expect(t.server.pendingPairings()).toHaveLength(3)
        const fourth = await t.begin(4)
        expect(fourth.answer).toMatchObject({
          id: 4,
          ok: false,
          error: { code: 'PERMISSION_DENIED' },
        })
        expect(t.server.pendingPairings()).toHaveLength(3)
        // One answered or gone: there is room again.
        await t.drop(waiting[0]!)
        expect((await t.begin(5)).answer).toMatchObject({ id: 5, ok: true })
      } finally {
        t.close()
      }
    })

    it('refuses the seventh pair.begin within one minute (SEC-10)', async () => {
      const t = await pairingBridge()
      try {
        for (let id = 1; id <= 6; id++) {
          const item = await t.begin(id)
          expect(item.answer).toMatchObject({ id, ok: true })
          await t.drop(item)
          t.clock.now += 5_000
        }
        const seventh = await t.begin(7)
        expect(seventh.answer).toMatchObject({
          id: 7,
          ok: false,
          error: { code: 'PERMISSION_DENIED' },
        })
        expect(t.server.pendingPairings()).toHaveLength(0)
        // A minute after the first one, a pairing may start again.
        t.clock.now = 1_000_000 + 60_001
        expect((await t.begin(8)).answer).toMatchObject({ id: 8, ok: true })
      } finally {
        t.close()
      }
    })

    it('records only chrome or edge as the browser that paired', async () => {
      const records = new Map<string, BrowserPairing>()
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(records),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
      })
      await bridge.start()
      const ext: any = await import(
        /* @vite-ignore */ new URL(
          '../../../extension/crypto.js',
          import.meta.url,
        ).href
      )
      const pair = async (id: number, browser: unknown) => {
        const offer = await ext.createPairOffer('a'.repeat(32))
        client = await connect(bridge!.socketPath)
        client.send({
          type: 'request',
          id,
          method: 'pair.begin',
          params: {
            protocol: 1,
            extensionId: offer.extensionId,
            publicKey: offer.publicKey,
            nonce: offer.nonce,
            browser,
          },
          deadlineMs: 15000,
        })
        const answer = await client.next()
        const pairingId = answer.result.pairingId as string
        client.send({
          type: 'event',
          name: 'pair.displayed',
          data: { pairingId },
        })
        await eventually(() =>
          bridge!
            .pendingPairings()
            .some((item) => item.pairingId === pairingId && item.displayed),
        )
        const pending = bridge!
          .pendingPairings()
          .find((item) => item.pairingId === pairingId)
        expect(await bridge!.approvePairing(pairingId)).toBe(true)
        client.socket.destroy()
        return { pending, stored: records.get(pairingId) }
      }
      const edge = await pair(1, 'edge')
      expect(edge.pending?.browser).toBe('edge')
      expect(edge.stored?.browser).toBe('edge')
      const chrome = await pair(2, 'chrome')
      expect(chrome.stored?.browser).toBe('chrome')
      // Anything else is display metadata Emperor does not know: left out.
      const odd = await pair(3, 'firefox')
      expect(odd.pending).not.toHaveProperty('browser')
      expect(odd.stored).not.toHaveProperty('browser')
      const none = await pair(4, undefined)
      expect(none.stored).not.toHaveProperty('browser')
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
      // Revoked in Emperor: unknown from now on, so the extension pairs again.
      expect(await client.next()).toMatchObject({
        ok: false,
        error: { code: 'PAIRING_UNKNOWN' },
      })
      driver.dispose()
    })

    it('labels a pairing with its browser and the ready extension with its version', async () => {
      const records = new Map<string, BrowserPairing>()
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(records),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
      })
      const events: NmBridgeEvent[] = []
      bridge.subscribe((event) => events.push(event))
      await bridge.start()
      const edge = await pairedClient(bridge, {
        browser: 'edge',
        ready: { version: '0.2.0', browser: 'edge' },
      })
      client = edge.client
      expect(edge.pending.browser).toBe('edge')
      expect(records.get(edge.pairingId)?.browser).toBe('edge')
      expect(await bridge.storedPairings()).toEqual([
        expect.objectContaining({ pairingId: edge.pairingId, browser: 'edge' }),
      ])
      expect(
        JSON.stringify(await bridge.storedPairings()).includes('secret'),
      ).toBe(false)
      expect(events.find((event) => event.type === 'ready')).toMatchObject({
        version: '0.2.0',
        browser: 'edge',
      })
      // Anything but chrome or edge, or a malformed version, is dropped.
      const odd = await pairedClient(bridge, {
        browser: 'safari',
        ready: { version: 'latest', browser: 'netscape' },
      })
      odd.client.socket.destroy()
      expect(odd.pending.browser).toBeUndefined()
      expect(records.get(odd.pairingId)?.browser).toBeUndefined()
      const oddReady = events.filter((event) => event.type === 'ready').at(-1)
      expect(oddReady).not.toHaveProperty('version')
      expect(oddReady).not.toHaveProperty('browser')
    })

    it('relays uninstall and reload to the extension, and tells it about a revoke', async () => {
      const records = new Map<string, BrowserPairing>()
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(records),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
      })
      await bridge.start()
      const paired = await pairedClient(bridge, { browser: 'chrome' })
      client = paired.client
      for (const method of ['extension.reload', 'extension.uninstall']) {
        const answer = bridge.request(paired.pairingId, method, {}, 2_000)
        const request = await paired.next()
        expect(request).toMatchObject({ type: 'request', method })
        await paired.reply({
          type: 'response',
          id: request.id,
          ok: true,
          result: { done: true },
        })
        await expect(answer).resolves.toEqual({ done: true })
      }
      await expect(
        bridge.request(paired.pairingId, 'extension.anything', {}),
      ).rejects.toThrow('CAPABILITY_DISABLED')
      await bridge.revokePairing(paired.pairingId)
      // The connected extension hears it first, so it forgets quietly.
      expect(await paired.next()).toEqual({
        type: 'event',
        name: 'pair.revoked',
        data: { pairingId: paired.pairingId },
      })
      expect(records.has(paired.pairingId)).toBe(false)
      expect(bridge.readyPairings()).toEqual([])
    })

    it('removes and lists the host manifests for Settings', async () => {
      const calls: string[] = []
      const manifests: NmHostManifests = {
        reconcile: async () => [],
        register: async () => [],
        unregister: async () => [],
        removeAll: async () => {
          calls.push('removeAll')
          return []
        },
        inspect: async () => [
          {
            browser: 'chrome',
            directory: '/x',
            file: '/x/m.json',
            state: {
              kind: 'emperor',
              path: '/h',
              extensionIds: [EMPEROR_EXTENSION_ID],
              text: '',
            },
          },
          {
            browser: 'edge',
            directory: '/y',
            file: '/y/m.json',
            state: {
              kind: 'emperor',
              path: '/h',
              extensionIds: ['b'.repeat(32)],
              text: '',
            },
          },
          {
            browser: 'chromium',
            directory: '/z',
            file: '/z/m.json',
            state: { kind: 'foreign' },
          },
        ],
      }
      directory = await mkdtemp(join(tmpdir(), 'eanm-test-'))
      await chmod(directory, 0o700)
      bridge = new NmBridgeServer({
        pairings: memoryPairings(new Map()),
        socketPath: join(directory, 'nm.sock'),
        heartbeatMs: 0,
        manifests,
      })
      // Not the socket owner yet: never touch another instance's manifests.
      await bridge.removeHostManifests()
      expect(calls).toEqual([])
      await bridge.start()
      await bridge.removeHostManifests()
      expect(calls).toEqual(['removeAll'])
      expect(await bridge.hostRegistrations()).toEqual(['chrome'])
      // A store that cannot be read lists nothing instead of throwing.
      const broken = new NmBridgeServer({
        pairings: {
          ...memoryPairings(new Map()),
          list: async () => {
            throw new Error('unreadable')
          },
        },
        socketPath: join(directory, 'other.sock'),
      })
      expect(await broken.storedPairings()).toEqual([])
    })
  },
)
