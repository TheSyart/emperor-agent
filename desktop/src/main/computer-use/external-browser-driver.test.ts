import { describe, expect, it, vi } from 'vitest'
import type { NmBridgeEvent, NmBridgeServer } from './nm-bridge'
import { ExternalBrowserDriver } from './external-browser-driver'

const targetId = '12345678-1234-1234-1234-123456789012'
const pairingId = 'pairing-1'

function fixture() {
  const listeners = new Set<(event: NmBridgeEvent) => void>()
  const request = vi.fn(
    async (
      _pairingId: string,
      method: string,
      _params?: unknown,
      _timeoutMs?: number,
      _signal?: AbortSignal,
    ) => {
      if (method === 'target.list')
        return {
          targets: [
            {
              targetId,
              tabId: 7,
              windowId: 2,
              origin: 'https://example.com',
              generation: 1,
            },
          ],
        }
      if (method === 'target.observe')
        return {
          targetId,
          generation: 1,
          revision: 1,
          origin: 'https://example.com',
          viewport: { width: 800, height: 600, scale: 1 },
          elements: [
            { ref: 'r1.1', role: 'button', name: 'Go', actions: ['click'] },
          ],
          truncated: false,
          redactions: 0,
        }
      throw new Error('unavailable')
    },
  )
  const bridge = {
    subscribe: (listener: (event: NmBridgeEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    readyPairings: () => [pairingId],
    request,
  } as unknown as NmBridgeServer
  return {
    bridge,
    request,
    emit: (event: NmBridgeEvent) => {
      for (const listener of listeners) listener(event)
    },
  }
}

describe('external browser attachment', () => {
  it('ends an element wait when its budget expires during observation', async () => {
    const { bridge, emit, request } = fixture()
    const originalRequest = request.getMockImplementation()!
    request.mockImplementation(async (profileId, method, ...args) => {
      if (method !== 'target.observe')
        return originalRequest(profileId, method, ...args)
      const signal = args[2]
      if (!signal) throw new Error('missing observation signal')
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve({
            targetId,
            generation: 1,
            revision: 1,
            origin: 'https://example.com',
            viewport: { width: 800, height: 600, scale: 1 },
            elements: [
              {
                ref: 'r1.1',
                role: 'button',
                name: 'Ready',
                actions: ['click'],
              },
            ],
            truncated: false,
            redactions: 0,
          })
        }, 400)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error('cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    })
    const driver = new ExternalBrowserDriver(bridge)
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    await driver.claimAttachedTarget(
      targetId,
      'owner-1',
      new AbortController().signal,
    )

    const result = await driver.wait(
      {
        targetId,
        generation: 1,
        condition: { kind: 'element', name: 'Ready', state: 'present' },
        timeoutMs: 100,
      },
      new AbortController().signal,
    )

    expect(result.satisfied).toBe(false)
    expect(result.revision).toBe(0)
    expect(driver.snapshot(targetId)).toMatchObject({ revision: 0 })
    driver.dispose()
  })

  it.each([
    { width: -1, height: 600, scale: 1 },
    { width: 800, height: 600, scale: '2' },
  ])(
    'rejects an invalid extension viewport before publishing it: %j',
    async (viewport) => {
      const { bridge, emit, request } = fixture()
      const driver = new ExternalBrowserDriver(bridge)
      emit({
        type: 'target-attached',
        pairingId,
        targetId,
        tabId: 7,
        windowId: 2,
        origin: 'https://example.com',
        generation: 1,
      })
      await driver.claimAttachedTarget(
        targetId,
        'owner-1',
        new AbortController().signal,
      )
      const malformed = {
        targetId,
        generation: 1,
        revision: 1,
        origin: 'https://example.com',
        viewport,
        elements: [],
        truncated: false,
        redactions: 0,
      } as unknown as Awaited<ReturnType<typeof request>>
      request.mockResolvedValueOnce(malformed)

      await expect(
        driver.observe(
          {
            targetId,
            generation: 1,
            budget: {
              maxElements: 200,
              maxTextBytes: 1_000,
              maxDepth: 8,
              timeoutMs: 3_000,
            },
            includeText: false,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
      expect(driver.snapshot(targetId)).toMatchObject({ revision: 0 })
      driver.dispose()
    },
  )

  it('rejects duplicate element refs before publishing an observation', async () => {
    const { bridge, emit, request } = fixture()
    const originalRequest = request.getMockImplementation()!
    request.mockImplementation(async (pairing, method) => {
      if (method === 'target.observe')
        return {
          targetId,
          generation: 1,
          revision: 1,
          origin: 'https://example.com',
          viewport: { width: 800, height: 600, scale: 1 },
          elements: [
            { ref: 'r1.1', role: 'button', name: 'First', actions: ['click'] },
            { ref: 'r1.1', role: 'button', name: 'Second', actions: ['click'] },
          ],
          truncated: false,
          redactions: 0,
        }
      return originalRequest(pairing, method)
    })
    const driver = new ExternalBrowserDriver(bridge)
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    await driver.claimAttachedTarget(
      targetId,
      'owner-1',
      new AbortController().signal,
    )

    await expect(
      driver.observe(
        {
          targetId,
          generation: 1,
          budget: {
            maxElements: 200,
            maxTextBytes: 1_000,
            maxDepth: 8,
            timeoutMs: 3_000,
          },
          includeText: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    expect(driver.snapshot(targetId)).toMatchObject({ revision: 0 })
    driver.dispose()
  })

  it('never advertises an attachment with a non-canonical web origin', () => {
    const { bridge, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    for (const origin of [
      'https://user@example.com',
      'https://example.com/',
      'https://example.com/path',
      'https://example.com?key=value',
      'https://EXAMPLE.com',
      'https://example.com:443',
      'http://example.com:80',
      'chrome://extensions',
    ]) {
      emit({
        type: 'target-attached',
        pairingId,
        targetId,
        tabId: 7,
        windowId: 2,
        origin,
        generation: 1,
      })
      expect(driver.listAttached(), origin).toEqual([])
    }
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'http://127.0.0.1:8765',
      generation: 1,
    })
    expect(driver.listAttached()).toMatchObject([
      { targetId, origin: 'http://127.0.0.1:8765' },
    ])
    driver.dispose()
  })

  it('does not let another pairing replace or retire an existing target ID', () => {
    const { bridge, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    const lost: string[] = []
    driver.subscribe((event) => {
      if (event.type === 'lost') lost.push(event.targetId)
    })
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    emit({
      type: 'target-attached',
      pairingId: 'pairing-2',
      targetId,
      tabId: 9,
      windowId: 3,
      origin: 'https://other.example',
      generation: 1,
    })
    expect(driver.listAttached()).toMatchObject([
      { targetId, profileId: pairingId, tabId: 7 },
    ])
    expect(lost).toEqual([])
    emit({
      type: 'target-lost',
      pairingId: 'pairing-2',
      targetId,
      generation: 1,
      reason: 'spoofed',
    })
    expect(driver.listAttached()).toHaveLength(1)
    expect(lost).toEqual([])
    emit({
      type: 'target-lost',
      pairingId,
      targetId,
      generation: 1,
      reason: 'closed',
    })
    expect(driver.listAttached()).toEqual([])
    expect(lost).toEqual([targetId])
    driver.dispose()
  })

  it('invalidates an older handle when Chrome reuses the same tab ID', () => {
    const { bridge, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    const lost: string[] = []
    driver.subscribe((event) => {
      if (event.type === 'lost') lost.push(event.targetId)
    })
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    const replacement = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    emit({
      type: 'target-attached',
      pairingId,
      targetId: replacement,
      tabId: 7,
      windowId: 3,
      origin: 'https://different.example',
      generation: 2,
    })
    expect(driver.snapshot(targetId)).toBeNull()
    expect(driver.listAttached()).toMatchObject([
      { targetId: replacement, generation: 2 },
    ])
    expect(lost).toEqual([targetId])
    driver.dispose()
  })

  it('keeps a claimed target when its attachment event is delivered twice', async () => {
    const { bridge, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    const attached: NmBridgeEvent = {
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    }
    const lost: string[] = []
    driver.subscribe((event) => {
      if (event.type === 'lost') lost.push(event.targetId)
    })
    emit(attached)
    await driver.claimAttachedTarget(
      targetId,
      'owner-1',
      new AbortController().signal,
    )

    emit(attached)

    expect(driver.listAttached()).toMatchObject([
      { targetId, generation: 1, claimedBy: 'owner-1' },
    ])
    expect(lost).toEqual([])
    driver.dispose()
  })

  it('ignores a delayed older attachment for the same tab slot', () => {
    const { bridge, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    const lost: string[] = []
    driver.subscribe((event) => {
      if (event.type === 'lost') lost.push(event.targetId)
    })
    const newer = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    emit({
      type: 'target-attached',
      pairingId,
      targetId: newer,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 2,
    })

    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })

    expect(driver.listAttached()).toMatchObject([
      { targetId: newer, generation: 2 },
    ])
    expect(lost).toEqual([])
    driver.dispose()
  })

  it('shows only authenticated attachments and drops changed or stale tab identities', async () => {
    const { bridge, request, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    const signal = new AbortController().signal
    expect(driver.listAttached()).toEqual([])
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    expect(driver.listAttached()).toMatchObject([{ targetId, claimedBy: null }])
    await driver.claimAttachedTarget(targetId, 'owner-1', signal)
    expect(driver.listAttached()[0]?.claimedBy).toBe('owner-1')
    await expect(
      driver.claimAttachedTarget(targetId, 'owner-2', signal),
    ).rejects.toMatchObject({ code: 'TARGET_BUSY' })
    emit({
      type: 'target-lost',
      pairingId,
      targetId,
      generation: 0,
      reason: 'old',
    })
    expect(driver.listAttached()).toHaveLength(1)
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 2,
    })
    expect(driver.listAttached()[0]?.claimedBy).toBeNull()
    request.mockResolvedValueOnce({
      targets: [
        {
          targetId,
          tabId: 7,
          windowId: 2,
          origin: 'https://example.com',
          generation: 1,
        },
      ],
    })
    await expect(
      driver.claimAttachedTarget(targetId, 'owner-1', signal),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(driver.listAttached()).toEqual([])
    driver.dispose()
  })

  it('journals a possible side effect and reports unknown outcome on lost acknowledgement', async () => {
    const { bridge, request, emit } = fixture()
    const driver = new ExternalBrowserDriver(bridge)
    const signal = new AbortController().signal
    emit({
      type: 'target-attached',
      pairingId,
      targetId,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    await driver.claimAttachedTarget(targetId, 'owner', signal)
    const observed = await driver.observe(
      {
        targetId,
        generation: 1,
        budget: {
          maxElements: 10,
          maxTextBytes: 0,
          maxDepth: 4,
          timeoutMs: 3000,
        },
        includeText: false,
      },
      signal,
    )
    expect(observed.elements[0]?.name).toBe('Go')
    const dispatched = vi.fn()
    await expect(
      driver.act(
        {
          operationId: 'op',
          targetId,
          generation: 1,
          expectedRevision: 0,
          action: { kind: 'click', ref: 'r1.1' },
          deadlineMs: 3000,
        },
        { dispatched },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE_ELEMENT' })
    expect(dispatched).not.toHaveBeenCalled()
    await expect(
      driver.act(
        {
          operationId: 'op',
          targetId,
          generation: 1,
          expectedRevision: 1,
          action: { kind: 'click', ref: 'r1.1' },
          deadlineMs: 3000,
        },
        { dispatched },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(dispatched).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      pairingId,
      'target.act',
      expect.objectContaining({ expectedRevision: 1 }),
      3000,
      signal,
    )
    emit({
      type: 'ready',
      pairingId,
      extensionId: 'a'.repeat(32),
      workerEpoch: 2,
    })
    expect(driver.listAttached()).toEqual([])
    driver.dispose()
  })
})
