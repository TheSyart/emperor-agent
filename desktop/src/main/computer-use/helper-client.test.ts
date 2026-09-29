import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from 'node:net'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  FrameDecoder,
  encodeBlobFrame,
  encodeJsonFrame,
} from '../../../../packages/core/src/harness/computer-use/protocol/framing'
import { HelperClient } from './helper-client'

const hello = {
  type: 'hello',
  protocol: 1,
  helperVersion: 'test',
  platform: 'macos',
  arch: 'arm64',
  capabilities: [],
  permissions: { accessibility: 'unknown' },
}
const nonce = '0123456789abcdef0123456789abcdef'

async function fakeHelper(
  onMessage: (message: Record<string, unknown>, socket: Socket) => void,
  greeting: Record<string, unknown> = hello,
): Promise<{ client: HelperClient; socket: Socket; close(): Promise<void> }> {
  const path = `/tmp/emperor-cu-${randomUUID()}.sock`
  let peer!: Socket
  const server: Server = createServer((socket) => {
    peer = socket
    // Disconnect tests deliberately tear down the client while the fake
    // helper may still be replying to releaseAll. A real helper handles a
    // closed peer; the fixture must also consume that expected EPIPE.
    socket.on('error', () => undefined)
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== 'json') throw new Error('Expected JSON')
        onMessage(frame.value as Record<string, unknown>, socket)
      }
    })
    socket.write(Buffer.from(encodeJsonFrame(greeting)))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  const stream = createConnection(path)
  const client = new HelperClient(stream, {
    platform: 'macos',
    nonce,
    heartbeatMs: 30,
    maxMissedPings: 3,
  })
  return {
    client,
    get socket() {
      return peer
    },
    async close() {
      stream.destroy()
      peer?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(path).catch(() => undefined)
    },
  }
}

describe('HelperClient', () => {
  it('validates hello, sends nonce welcome, and validates request results', async () => {
    const received: Record<string, unknown>[] = []
    const helper = await fakeHelper((message, socket) => {
      received.push(message)
      if (message.type === 'request')
        socket.write(
          Buffer.from(
            encodeJsonFrame({
              type: 'response',
              id: message.id,
              ok: true,
              result: { permissions: { accessibility: 'granted' } },
            }),
          ),
        )
      if (message.type === 'ping')
        socket.write(
          Buffer.from(encodeJsonFrame({ type: 'pong', seq: message.seq })),
        )
    })
    try {
      expect((await helper.client.ready).platform).toBe('macos')
      await vi.waitFor(() =>
        expect(received[0]).toEqual({ type: 'welcome', protocol: 1, nonce }),
      )
      expect(await helper.client.request('permissions.status', {})).toEqual({
        permissions: { accessibility: 'granted' },
      })
      expect(helper.client.diagnostics()).toMatchObject({
        connected: true,
        protocol: 1,
        helperVersion: 'test',
        pendingRequests: 0,
      })
    } finally {
      await helper.close()
    }
  })

  it('rejects protocol mismatch and wrong platform before becoming ready', async () => {
    for (const greeting of [
      { ...hello, protocol: 2 },
      { ...hello, platform: 'linux' },
    ]) {
      const helper = await fakeHelper(() => undefined, greeting)
      try {
        await expect(helper.client.ready).rejects.toThrow()
      } finally {
        await helper.close()
      }
    }
  })

  it('receives screenshot blobs after a validated response', async () => {
    const helper = await fakeHelper((message, socket) => {
      if (message.type !== 'request') return
      const result = {
        screenshotId: 'shot',
        generation: 1,
        revision: 2,
        width: 10,
        height: 10,
        scale: 1,
        blobId: 'png-1',
      }
      socket.write(
        Buffer.from(
          encodeJsonFrame({
            type: 'response',
            id: message.id,
            ok: true,
            result,
          }),
        ),
      )
      socket.write(
        Buffer.from(encodeBlobFrame('png-1', Uint8Array.of(1, 2, 3))),
      )
    })
    try {
      await helper.client.ready
      const response = await helper.client.requestWithBlobs(
        'observe.screenshot',
        { targetId: 't', generation: 1, modelCopy: false, modelMaxEdge: 1024 },
      )
      expect(response.result.blobId).toBe('png-1')
      expect(response.blobs.get('png-1')).toEqual(Uint8Array.of(1, 2, 3))
    } finally {
      await helper.close()
    }
  })

  it('waits for a preview blob only when the helper sends a new frame', async () => {
    let calls = 0
    const helper = await fakeHelper((message, socket) => {
      if (message.type !== 'request') return
      calls += 1
      const result =
        calls === 1
          ? { seq: 4, live: true, blobId: 'jpg-1', width: 8, height: 6 }
          : { seq: 4, live: true }
      socket.write(
        Buffer.from(
          encodeJsonFrame({
            type: 'response',
            id: message.id,
            ok: true,
            result,
          }),
        ),
      )
      if (calls === 1)
        socket.write(Buffer.from(encodeBlobFrame('jpg-1', Uint8Array.of(9))))
    })
    try {
      await helper.client.ready
      const params = { targetId: 't', generation: 1, maxEdge: 480 }
      const fresh = await helper.client.requestWithBlobs(
        'target.preview',
        params,
      )
      expect(fresh.blobs.get('jpg-1')).toEqual(Uint8Array.of(9))
      const same = await helper.client.requestWithBlobs('target.preview', {
        ...params,
        afterSeq: 4,
      })
      expect(same.result).toEqual({ seq: 4, live: true })
      expect(same.blobs.size).toBe(0)
    } finally {
      await helper.close()
    }
  })

  it('cancels a dispatched request and asks the helper to release input', async () => {
    const received: string[] = []
    const helper = await fakeHelper((message, socket) => {
      if (message.type === 'request') {
        received.push(message.method as string)
        if (message.method === 'input.releaseAll')
          socket.write(
            Buffer.from(
              encodeJsonFrame({
                type: 'response',
                id: message.id,
                ok: true,
                result: {},
              }),
            ),
          )
      } else if (message.type === 'cancel') received.push('cancel')
    })
    try {
      await helper.client.ready
      const controller = new AbortController()
      const request = helper.client.request(
        'target.release',
        { targetId: 'target' },
        { signal: controller.signal },
      )
      await vi.waitFor(() => expect(received).toContain('target.release'))
      controller.abort()
      await expect(request).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      await vi.waitFor(() =>
        expect(received).toEqual([
          'target.release',
          'cancel',
          'input.releaseAll',
        ]),
      )
    } finally {
      await helper.close()
    }
  })

  it('enforces request deadlines and rejects outstanding work on disconnect', async () => {
    const received: string[] = []
    const helper = await fakeHelper((message, socket) => {
      if (message.type === 'request') {
        received.push(message.method as string)
        if (message.method === 'input.releaseAll')
          socket.write(
            Buffer.from(
              encodeJsonFrame({
                type: 'response',
                id: message.id,
                ok: true,
                result: {},
              }),
            ),
          )
      } else if (message.type === 'cancel') received.push('cancel')
    })
    try {
      await helper.client.ready
      await expect(
        helper.client.request(
          'target.release',
          { targetId: 'a' },
          { deadlineMs: 20 },
        ),
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      await vi.waitFor(() => expect(received).toContain('input.releaseAll'))
      const pending = helper.client.request('target.release', { targetId: 'b' })
      void pending.catch(() => undefined)
      await vi.waitFor(() =>
        expect(
          received.filter((method) => method === 'target.release'),
        ).toHaveLength(2),
      )
      helper.socket.destroy()
      await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(helper.client.diagnostics().pendingRequests).toBe(0)
    } finally {
      await helper.close()
    }
  })

  it('releases input before shutdown', async () => {
    const received: string[] = []
    const helper = await fakeHelper((message, socket) => {
      if (message.type === 'request') {
        received.push(message.method as string)
        socket.write(
          Buffer.from(
            encodeJsonFrame({
              type: 'response',
              id: message.id,
              ok: true,
              result: {},
            }),
          ),
        )
      }
    })
    try {
      await helper.client.ready
      await helper.client.close()
      expect(received).toEqual(['input.releaseAll', 'shutdown'])
    } finally {
      await helper.close()
    }
  })

  it('asks a replacement helper to release what a crashed one held', async () => {
    const params: unknown[] = []
    const helper = await fakeHelper((message, socket) => {
      if (message.type === 'request' && message.method === 'input.releaseAll') {
        params.push(message.params)
        socket.write(
          Buffer.from(
            encodeJsonFrame({
              type: 'response',
              id: message.id,
              ok: true,
              result: {},
            }),
          ),
        )
      }
    })
    try {
      await helper.client.ready
      await helper.client.releaseAll({ recovery: true })
      await helper.client.releaseAll()
      expect(params).toEqual([{ recovery: true }, {}])
    } finally {
      await helper.close()
    }
  })

  it('tolerates exactly three missed heartbeats before declaring the helper lost', async () => {
    const pings: unknown[] = []
    const helper = await fakeHelper((message) => {
      if (message.type === 'ping') pings.push(message.seq)
    })
    try {
      await helper.client.ready
      const lost = new Promise((resolve) =>
        helper.client.onDisconnected(resolve),
      )
      await expect(lost).resolves.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        message: 'Helper heartbeat lost',
      })
      await vi.waitFor(() => expect(pings).toEqual([1, 2, 3]))
    } finally {
      await helper.close()
    }
  })

  it('stays connected while the helper answers heartbeats', async () => {
    const helper = await fakeHelper((message, socket) => {
      if (message.type === 'ping')
        socket.write(
          Buffer.from(encodeJsonFrame({ type: 'pong', seq: message.seq })),
        )
    })
    try {
      await helper.client.ready
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(helper.client.diagnostics()).toMatchObject({
        connected: true,
        lastErrorCode: null,
      })
    } finally {
      await helper.close()
    }
  })

  it('reports a helper that closes before hello as a rejected or exited peer', async () => {
    const path = `/tmp/emperor-cu-${randomUUID()}.sock`
    const server: Server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    const stream = createConnection(path)
    try {
      const client = new HelperClient(stream, { platform: 'macos', nonce })
      await expect(client.ready).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        message:
          'Helper closed the connection before hello (peer rejected or helper exited)',
      })
    } finally {
      stream.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(path).catch(() => undefined)
    }
  })

  it('fails pending work after three missed heartbeats', async () => {
    const helper = await fakeHelper(() => undefined)
    try {
      await helper.client.ready
      const request = helper.client.request('target.release', {
        targetId: 'target',
      })
      await expect(request).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
      expect(helper.client.diagnostics()).toMatchObject({
        connected: false,
        lastErrorCode: 'DRIVER_UNAVAILABLE',
      })
    } finally {
      await helper.close()
    }
  })

  it('does not retain or echo secret request params in diagnostics', async () => {
    const helper = await fakeHelper((message, socket) => {
      if (message.type === 'request')
        socket.write(
          Buffer.from(
            encodeJsonFrame({
              type: 'response',
              id: message.id,
              ok: false,
              error: {
                code: 'DRIVER_UNAVAILABLE',
                message: 'secret would be unsafe',
              },
            }),
          ),
        )
    })
    try {
      await helper.client.ready
      const error = helper.client.request('act.fillSecret', {
        operationId: 'op',
        targetId: 't',
        generation: 1,
        expectedRevision: 1,
        ref: 'r1.1',
        field: 'password',
        secret: 'hunter2',
        binding: { bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
      })
      await expect(error).rejects.toThrow('Helper request failed')
      expect(JSON.stringify(helper.client.diagnostics())).not.toContain(
        'hunter2',
      )
    } finally {
      await helper.close()
    }
  })

  it('reports only allowlisted, content-free helper failure reasons', async () => {
    const messages = [
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Bring target window to the foreground',
        reason: 'target-app-not-frontmost',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Bring target window to the front',
        reason: 'target-window-not-focused',
        hint: 'Another window of this app, often a dialog, has focus. Observe it or ask the user to close it; no input was sent.',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Finder input point could not be verified',
        reason: 'target-input-point-unverified',
        hint: 'Move the target window clear of overlays, observe again, and stop if the input point is still blocked.',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Focused element is not an editable text control',
        reason: 'focused-text-editor-unavailable',
        hint: "Pass the text field's ref from the latest observation (apps such as VS Code do not report their focused input), observe again, then retry the text input.",
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Frontmost application could not be verified',
        reason: 'frontmost-app-unverified',
        hint: 'The frontmost app could not be identified, so no input was sent. Observe again; if this repeats, ask the user to bring the target window forward.',
      },
      {
        code: 'OUTCOME_UNKNOWN',
        message: 'Target changed after dispatch',
        reason: 'post-dispatch-target-recheck-failed',
      },
      {
        code: 'OUTCOME_UNKNOWN',
        message: 'Action dispatched but effect is unconfirmed',
        reason: 'post-dispatch-no-revision',
      },
      {
        code: 'OUTCOME_UNKNOWN',
        message: 'Background key delivery unconfirmed',
        reason: 'background-delivery-unconfirmed',
        hint: 'The keys may not have reached the app. Observe first; retry once only if the text is absent.',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Target app is in the background',
        reason: 'foreground-required',
        hint: 'The app is in the background and this step needs the front, so nothing was sent. Prefer a background route (an element with a press action, desktop_fill, desktop_menu_select); otherwise call desktop_activate (in per-item mode the user is asked), then retry.',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Background keys are ignored by this app',
        reason: 'background-keys-ignored',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Menu needs the app in front',
        reason: 'menu-needs-front',
      },
      {
        code: 'INVALID_REQUEST',
        message: 'Menu item not found',
        reason: 'menu-item-not-found',
        hint: 'List the menu with desktop_menu and use the exact titles it returns.',
      },
      {
        code: 'PERMISSION_REQUIRED',
        message: 'Accessibility permission is required',
        reason: 'accessibility-permission-missing',
      },
      {
        code: 'OUTCOME_UNKNOWN',
        message: 'Target window closed after dispatch',
        reason: 'target-closed-after-dispatch',
      },
      {
        code: 'PERMISSION_REQUIRED',
        message: 'Screen recording permission is required',
        reason: 'screen-recording-permission-missing',
      },
      {
        code: 'CAPABILITY_DISABLED',
        message: 'App has no menu bar',
        reason: 'no-menu-bar',
      },
      {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Bring target window to the front; secret=not-for-logs',
        reason: undefined,
      },
    ] as const
    let next = 0
    const helper = await fakeHelper((message, socket) => {
      if (message.type !== 'request') return
      const response = messages[next++]!
      socket.write(
        Buffer.from(
          encodeJsonFrame({
            type: 'response',
            id: message.id,
            ok: false,
            error: { code: response.code, message: response.message },
          }),
        ),
      )
    })
    try {
      await helper.client.ready
      for (const expected of messages) {
        const failure = helper.client.request('target.release', {
          targetId: 'target',
        })
        await expect(failure).rejects.toMatchObject({
          code: expected.code,
          reason: expected.reason,
          ...('hint' in expected ? { hint: expected.hint } : {}),
        })
        await expect(failure).rejects.toThrow('Helper request failed')
      }
      expect(JSON.stringify(helper.client.diagnostics())).not.toContain(
        'not-for-logs',
      )
    } finally {
      await helper.close()
    }
  })
})
