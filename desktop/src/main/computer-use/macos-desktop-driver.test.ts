import { describe, expect, it, vi } from 'vitest'
import { UiError } from '@emperor/core/host-capabilities'
import type { HelperClient } from './helper-client'
import {
  HELPER_CRASH_LATCH_REASON,
  HELPER_LAUNCH_LATCH_REASON,
  MacosDesktopDriver,
  type HelperClock,
  type MacosDesktopDriverOptions,
} from './macos-desktop-driver'
import { DesktopComputerUsePort } from './port'

const SELF = {
  pid: 4242,
  executablePath:
    '/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent',
}

/** The helper accepts only windowRefs from its latest listing. */
async function bound(
  k: { driver: MacosDesktopDriver },
  signal = new AbortController().signal,
) {
  await k.driver.listWindows({}, signal)
  return await k.driver.bind(
    { windowRef: 'w-1', ownerSessionId: 's-1' },
    signal,
  )
}

function fixture(
  appId = 'com.apple.TextEdit',
  role = 'button',
  credentials?: MacosDesktopDriverOptions['credentials'],
  secretOutcome: 'filled' | 'unknown' = 'filled',
  pointer?: MacosDesktopDriverOptions['pointer'],
) {
  let disconnected: (() => void) | undefined
  let currentPermissions = {
    accessibility: 'denied',
    'screen-recording': 'denied',
  }
  let emit: (event: { name: string; data: unknown }) => void = () => undefined
  const request = vi.fn(
    async (method: string, params?: { operationId?: string }) => {
      if (method === 'apps.list')
        return {
          apps: [
            {
              appId,
              name: 'TextEdit',
              pid: 88,
              frontmost: true,
              hidden: false,
            },
          ],
        }
      if (method === 'windows.list')
        return {
          windows: [
            {
              windowRef: 'w-1',
              appId,
              appName: 'TextEdit',
              pid: 88,
              title: 'Untitled',
              minimized: false,
              main: true,
            },
          ],
        }
      if (method === 'target.bind')
        return {
          targetId: 't-1',
          generation: 1,
          revision: 1,
          appId,
          title: 'Untitled',
        }
      if (method === 'observe.semantic')
        return {
          generation: 1,
          revision: 2,
          title: 'Untitled',
          urlOrApp: appId,
          focus: true,
          frameOrWindowId: 'w-1',
          viewport: { width: 800, height: 600, scale: 2 },
          elements: [{ ref: 'r2.0', role, actions: ['press'] }],
          truncated: false,
          redactions: 0,
        }
      if (method === 'permissions.status')
        return { permissions: currentPermissions }
      if (method === 'front.restore') return { restored: true }
      if (method === 'target.capture')
        return { active: (params as { active?: boolean }).active === true }
      if (method === 'observe.menu')
        return {
          items: [
            { title: 'Command Palette...', enabled: true, submenu: false },
          ],
          truncated: false,
        }
      if (method === 'act') {
        emit({
          name: 'act.dispatched',
          data: { operationId: params?.operationId },
        })
        return { outcome: 'observed', afterRevision: 3, title: 'Changed' }
      }
      if (method === 'act.fillSecret') {
        emit({
          name: 'act.dispatched',
          data: { operationId: params?.operationId },
        })
        if (secretOutcome === 'unknown')
          throw Object.assign(new Error('secure field cannot be read back'), {
            code: 'OUTCOME_UNKNOWN',
          })
        return { filled: true }
      }
      return {}
    },
  )
  const client = {
    request,
    requestWithBlobs: vi.fn(async () => ({
      result: {
        screenshotId: 'shot-1',
        generation: 1,
        revision: 2,
        width: 800,
        height: 600,
        scale: 2,
        blobId: 'png-1',
      },
      blobs: new Map([['png-1', Uint8Array.from([137, 80, 78, 71])]]),
    })),
    onEvent: vi.fn((handler: typeof emit) => {
      emit = handler
      return () => {
        emit = () => undefined
      }
    }),
    onDisconnected: vi.fn((handler: () => void) => {
      disconnected = handler
      return () => undefined
    }),
    diagnostics: vi.fn(() => ({
      connected: true,
      helperVersion: '0.1.0',
      protocol: 1,
      capabilities: [
        'observe.semantic',
        'observe.menu',
        'target.capture',
        'front.restore',
        'act',
      ],
      lastErrorCode: null,
      permissions: {
        accessibility: 'denied',
        'screen-recording': 'denied',
      },
    })),
    releaseAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as HelperClient
  const driver = new MacosDesktopDriver({
    connect: async () => client,
    self: SELF,
    processPaths: async () => new Map(),
    ...(credentials ? { credentials } : {}),
    ...(pointer ? { pointer } : {}),
  })
  return {
    driver,
    request,
    client,
    emitHelper: (event: { name: string; data: unknown }) => emit(event),
    disconnect: () => disconnected?.(),
    setPermissions: (accessibility: 'granted' | 'denied') => {
      currentPermissions = {
        accessibility,
        'screen-recording': 'granted',
      }
    },
  }
}

describe('MacosDesktopDriver', () => {
  it('binds a discovered window and maps read-only helper results', async () => {
    const k = fixture()
    const signal = new AbortController().signal
    expect(await k.driver.listApps(signal)).toHaveLength(1)
    expect(await k.driver.listWindows({}, signal)).toHaveLength(1)
    const target = await bound(k, signal)
    expect(target).toMatchObject({
      targetId: 't-1',
      kind: 'desktop-window',
      appId: 'com.apple.TextEdit',
    })
    const observation = await k.driver.observe(
      {
        targetId: target.targetId,
        generation: 1,
        budget: {
          maxElements: 200,
          maxTextBytes: 8192,
          maxDepth: 8,
          timeoutMs: 3000,
        },
        includeText: true,
      },
      signal,
    )
    expect(observation.revision).toBe(2)
    expect(observation.elements[0]?.role).toBe('button')
    expect(k.driver.snapshot('t-1')?.revision).toBe(2)
    const screenshot = await k.driver.screenshot(
      { targetId: 't-1', generation: 1, modelCopy: false, modelMaxEdge: 1200 },
      signal,
    )
    expect(screenshot.png).toEqual(Uint8Array.from([137, 80, 78, 71]))
    expect(await k.driver.permissions()).toEqual({
      accessibility: 'denied',
      'screen-recording': 'denied',
    })
    expect(await k.driver.status()).toMatchObject({
      available: true,
      connected: true,
      helperVersion: '0.1.0',
      protocol: 1,
      permissions: { accessibility: 'denied', 'screen-recording': 'denied' },
    })
    k.disconnect()
    expect(k.driver.snapshot('t-1')).toBeNull()
  })

  it('uses refreshed helper permissions for the driver capability after TCC changes', async () => {
    const k = fixture()
    await k.driver.listApps(new AbortController().signal)
    expect(k.driver.capability().available).toBe(false)

    k.setPermissions('granted')
    expect((await k.driver.status()).permissions.accessibility).toBe('granted')
    expect(k.driver.capability()).toMatchObject({
      available: true,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
    })

    k.setPermissions('denied')
    await k.driver.permissions()
    expect(k.driver.capability().available).toBe(false)
  })

  it('refreshes TCC permissions when listing live Computer Use capabilities', async () => {
    const k = fixture()
    await k.driver.listApps(new AbortController().signal)
    k.setPermissions('granted')
    const port = new DesktopComputerUsePort({
      platform: 'darwin',
      desktop: () => k.driver,
    })

    expect((await port.capabilities())[2]).toMatchObject({
      driver: 'desktop',
      available: true,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
    })
  })

  it('rejects protected apps even if the helper unexpectedly binds one', async () => {
    const k = fixture()
    const original = k.request.getMockImplementation()!
    k.request.mockImplementation(async (method, params) =>
      method === 'target.bind'
        ? {
            targetId: 't-1',
            generation: 1,
            revision: 1,
            appId: 'com.apple.Passwords',
            title: 'Passwords',
          }
        : original(method, params),
    )
    await expect(bound(k)).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN' })
    expect(k.request).toHaveBeenCalledWith(
      'target.release',
      { targetId: 't-1' },
      expect.any(Object),
    )
    expect(k.driver.list()).toEqual([])
  })

  it('hides a listed protected app and refuses it without asking the helper to bind', async () => {
    const k = fixture('com.apple.Passwords')
    const signal = new AbortController().signal
    expect(await k.driver.listApps(signal)).toEqual([])
    expect(await k.driver.listWindows({}, signal)).toEqual([])
    await expect(
      k.driver.bind({ windowRef: 'w-1', ownerSessionId: 's-1' }, signal),
    ).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN' })
    expect(k.request).not.toHaveBeenCalledWith(
      'target.bind',
      expect.anything(),
      expect.anything(),
    )
  })

  it('refuses a windowRef that is not in the latest listing', async () => {
    const k = fixture()
    await expect(
      k.driver.bind(
        { windowRef: 'w-1', ownerSessionId: 's-1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(k.request).not.toHaveBeenCalledWith(
      'target.bind',
      expect.anything(),
      expect.anything(),
    )
  })

  it('refuses a bound window whose application differs from the listing', async () => {
    const k = fixture()
    const original = k.request.getMockImplementation()!
    k.request.mockImplementation(async (method, params) =>
      method === 'target.bind'
        ? {
            targetId: 't-1',
            generation: 1,
            revision: 1,
            appId: 'com.example.Other',
            title: 'Other',
          }
        : original(method, params),
    )
    await expect(bound(k)).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(k.request).toHaveBeenCalledWith(
      'target.release',
      { targetId: 't-1' },
      expect.any(Object),
    )
  })

  it('reads a menu only from a helper that declares it, and refuses older helpers', async () => {
    const k = fixture()
    const signal = new AbortController().signal
    await bound(k, signal)
    const listing = await k.driver.menu(
      { targetId: 't-1', generation: 1, path: ['View'] },
      signal,
    )
    expect(listing.items[0]?.title).toBe('Command Palette...')
    expect(k.request).toHaveBeenCalledWith(
      'observe.menu',
      { targetId: 't-1', generation: 1, path: ['View'] },
      expect.objectContaining({ deadlineMs: 5_000 }),
    )
    vi.mocked(k.client.diagnostics).mockReturnValue({
      ...k.client.diagnostics(),
      capabilities: ['observe.semantic', 'act'],
    })
    await expect(
      k.driver.menu({ targetId: 't-1', generation: 1, path: [] }, signal),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' })
    await expect(
      k.driver.menu({ targetId: 't-1', generation: 2, path: [] }, signal),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
  })

  it('turns the menu-bar Stop Sharing into a takeover and streams only bound windows', async () => {
    const k = fixture()
    const signal = new AbortController().signal
    await bound(k, signal)
    const events: unknown[] = []
    k.driver.subscribe((event) => events.push(event))
    expect(
      await k.driver.setCapture({ targetId: 't-1', generation: 1 }, true),
    ).toBe(true)
    expect(k.request).toHaveBeenCalledWith(
      'target.capture',
      { targetId: 't-1', generation: 1, active: true },
      expect.objectContaining({ deadlineMs: 10_000 }),
    )
    expect(
      await k.driver.setCapture({ targetId: 't-9', generation: 1 }, true),
    ).toBe(false)
    k.emitHelper({
      name: 'target.capture.stopped',
      data: { targetId: 't-1', reason: 'error' },
    })
    k.emitHelper({
      name: 'target.capture.stopped',
      data: { targetId: 't-1', reason: 'user' },
    })
    expect(events).toEqual([{ type: 'user-input', targetId: 't-1' }])
    vi.mocked(k.client.diagnostics).mockReturnValue({
      ...k.client.diagnostics(),
      capabilities: ['observe.semantic', 'act'],
    })
    expect(
      await k.driver.setCapture({ targetId: 't-1', generation: 1 }, true),
    ).toBe(false)
  })

  it('hands the front back through the helper only for a bound window', async () => {
    const k = fixture()
    const signal = new AbortController().signal
    await bound(k, signal)
    expect(
      await k.driver.restoreFront({ targetId: 't-1', generation: 1 }),
    ).toBe(true)
    expect(k.request).toHaveBeenCalledWith(
      'front.restore',
      { targetId: 't-1', generation: 1 },
      expect.objectContaining({ deadlineMs: 5_000 }),
    )
    expect(
      await k.driver.restoreFront({ targetId: 't-9', generation: 1 }),
    ).toBe(false)
  })

  it('rejects stale generation before contacting the helper', async () => {
    const k = fixture()
    await bound(k)
    const calls = k.request.mock.calls.length
    await expect(
      k.driver.observe(
        {
          targetId: 't-1',
          generation: 2,
          budget: {
            maxElements: 20,
            maxTextBytes: 1024,
            maxDepth: 2,
            timeoutMs: 500,
          },
          includeText: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(k.request).toHaveBeenCalledTimes(calls)
  })

  it('normalizes an unexpected native role into the shared vocabulary', async () => {
    const k = fixture('com.apple.TextEdit', 'AXNovelRole')
    const target = await bound(k)
    const observed = await k.driver.observe(
      {
        targetId: target.targetId,
        generation: target.generation,
        budget: {
          maxElements: 20,
          maxTextBytes: 1024,
          maxDepth: 2,
          timeoutMs: 500,
        },
        includeText: false,
      },
      new AbortController().signal,
    )
    expect(observed.elements[0]?.role).toBe('other')
  })

  it('journals the matching native dispatch event before accepting an action result', async () => {
    const k = fixture()
    const signal = new AbortController().signal
    const target = await bound(k, signal)
    const dispatched = vi.fn()
    const result = await k.driver.act(
      {
        operationId: 'op-1',
        targetId: target.targetId,
        generation: target.generation,
        expectedRevision: target.revision,
        action: { kind: 'click', ref: 'r1.1' },
        deadlineMs: 5_000,
      },
      { dispatched },
      signal,
    )
    expect(dispatched).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ outcome: 'observed', afterRevision: 3 })
    expect(k.driver.snapshot(target.targetId)).toMatchObject({
      revision: 3,
      title: 'Changed',
    })
  })

  it('moves the virtual pointer to where an action lands, stepping aside first for pointer actions', async () => {
    const signals: unknown[] = []
    const k = fixture(undefined, undefined, undefined, undefined, (signal) =>
      signals.push(signal),
    )
    const signal = new AbortController().signal
    const target = await bound(k, signal)
    const act = (operationId: string, action: object) =>
      k.driver.act(
        {
          operationId,
          targetId: target.targetId,
          generation: target.generation,
          expectedRevision: target.revision,
          action: action as never,
          deadlineMs: 5_000,
        },
        { dispatched: () => undefined },
        signal,
      )
    const pointer = { x: 120, y: 80, visible: true }
    const dispatchesAt = (afterRevision: number) =>
      (async (_method: string, params?: { operationId?: string }) => {
        k.emitHelper({
          name: 'act.dispatched',
          data: { operationId: params?.operationId, pointer },
        })
        return { outcome: 'observed', afterRevision }
      }) as never
    k.request.mockImplementationOnce(dispatchesAt(3))
    await act('op-p1', { kind: 'click', ref: 'r1.1' })
    expect(signals).toEqual([{ kind: 'hide' }, { kind: 'move', pointer }])

    // A click refused before dispatch: the pointer comes back where it was.
    signals.length = 0
    k.request.mockImplementationOnce(async () => {
      throw new UiError('STALE_TARGET', 'Point belongs to another window')
    })
    await expect(
      act('op-p2', {
        kind: 'clickPoint',
        point: { screenshotId: 's', x: 1, y: 1 },
      }),
    ).rejects.toMatchObject({
      code: 'STALE_TARGET',
    })
    expect(signals).toEqual([{ kind: 'hide' }, { kind: 'restore' }])

    // Typing does not hit-test: no stepping aside, just a move on dispatch.
    signals.length = 0
    k.request.mockImplementationOnce(dispatchesAt(4))
    await act('op-p3', { kind: 'typeText', text: 'hi', ref: 'r1.1' })
    expect(signals).toEqual([{ kind: 'move', pointer }])
  })

  it('tells the helper when the user let the window come forward this task', async () => {
    const k = fixture()
    const signal = new AbortController().signal
    const target = await bound(k, signal)
    const act = (operationId: string, bringForward?: boolean) =>
      k.driver.act(
        {
          operationId,
          targetId: target.targetId,
          generation: target.generation,
          expectedRevision: target.revision,
          action: { kind: 'press', key: 'Tab' },
          deadlineMs: 5_000,
          ...(bringForward === undefined ? {} : { bringForward }),
        },
        { dispatched: () => undefined },
        signal,
      )
    await act('op-f1', true)
    const params = (id: string) =>
      k.request.mock.calls.find(
        ([method, sent]) =>
          method === 'act' &&
          (sent as { operationId?: string }).operationId === id,
      )?.[1] as Record<string, unknown>
    expect(params('op-f1')).toMatchObject({ bringForward: true })
    await act('op-f2')
    expect(params('op-f2')).not.toHaveProperty('bringForward')
  })

  it('passes a secret only from main to the helper after an exact app binding check, then blocks screenshots', async () => {
    const handleId = `cred_${'a'.repeat(24)}`
    const secret = vi.fn(() => 'private-password')
    const credentials: NonNullable<MacosDesktopDriverOptions['credentials']> = {
      available: true,
      locked: false,
      secret,
      list: () => [
        {
          handleId,
          label: 'Writer',
          bindings: [
            {
              kind: 'app',
              bundleId: 'com.apple.TextEdit',
              path: '/System/Applications/TextEdit.app',
            },
          ],
          fields: ['password'],
          fillMode: 'confirm',
        },
      ],
    }
    const k = fixture('com.apple.TextEdit', 'button', credentials)
    const signal = new AbortController().signal
    const target = await bound(k, signal)
    const base = {
      operationId: 'op-1',
      targetId: target.targetId,
      generation: target.generation,
      expectedRevision: target.revision,
      ref: 'r1.1',
      handleId,
      field: 'password' as const,
    }
    await expect(
      k.driver.fillCredential(
        {
          ...base,
          binding: {
            kind: 'app',
            bundleId: 'com.other.App',
            path: '/Other.app',
          },
        },
        { dispatched: vi.fn() },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(secret).not.toHaveBeenCalled()
    const dispatched = vi.fn()
    expect(
      await k.driver.fillCredential(
        {
          ...base,
          binding: {
            kind: 'app',
            bundleId: 'com.apple.TextEdit',
            path: '/System/Applications/TextEdit.app',
          },
        },
        { dispatched },
        signal,
      ),
    ).toEqual({ filled: true, bindingMatched: 'com.apple.TextEdit' })
    expect(dispatched).toHaveBeenCalledOnce()
    expect(k.request).toHaveBeenCalledWith(
      'act.fillSecret',
      expect.objectContaining({
        secret: 'private-password',
        binding: {
          bundleId: 'com.apple.TextEdit',
          path: '/System/Applications/TextEdit.app',
        },
      }),
      expect.any(Object),
    )
    await expect(
      k.driver.screenshot(
        {
          targetId: target.targetId,
          generation: 1,
          modelCopy: true,
          modelMaxEdge: 1200,
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' })
  })

  it('blocks screenshots after a secret dispatch even when the helper reports an unknown outcome', async () => {
    const handleId = `cred_${'b'.repeat(24)}`
    const credentials: NonNullable<MacosDesktopDriverOptions['credentials']> = {
      available: true,
      locked: false,
      secret: () => 'private-password',
      list: () => [
        {
          handleId,
          label: 'Writer',
          bindings: [
            {
              kind: 'app',
              bundleId: 'com.apple.TextEdit',
              path: '/System/Applications/TextEdit.app',
            },
          ],
          fields: ['password'],
          fillMode: 'confirm',
        },
      ],
    }
    const k = fixture('com.apple.TextEdit', 'button', credentials, 'unknown')
    const signal = new AbortController().signal
    const target = await bound(k, signal)
    const dispatched = vi.fn()
    await expect(
      k.driver.fillCredential(
        {
          operationId: 'op-unknown',
          targetId: target.targetId,
          generation: target.generation,
          expectedRevision: target.revision,
          ref: 'r1.1',
          handleId,
          field: 'password',
          binding: {
            kind: 'app',
            bundleId: 'com.apple.TextEdit',
            path: '/System/Applications/TextEdit.app',
          },
        },
        { dispatched },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(dispatched).toHaveBeenCalledOnce()
    await expect(
      k.driver.screenshot(
        {
          targetId: target.targetId,
          generation: target.generation,
          modelCopy: true,
          modelMaxEdge: 1200,
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' })
  })
  it('masks one-time codes, and every field value after a credential fill', async () => {
    const handleId = `cred_${'c'.repeat(24)}`
    const credentials: NonNullable<MacosDesktopDriverOptions['credentials']> = {
      available: true,
      locked: false,
      secret: () => 'private-password',
      list: () => [
        {
          handleId,
          label: 'Writer',
          bindings: [
            {
              kind: 'app',
              bundleId: 'com.apple.TextEdit',
              path: '/System/Applications/TextEdit.app',
            },
          ],
          fields: ['password'],
          fillMode: 'confirm',
        },
      ],
    }
    const k = fixture('com.apple.TextEdit', 'button', credentials)
    const original = k.request.getMockImplementation()!
    k.request.mockImplementation(async (method, params) =>
      method === 'observe.semantic'
        ? {
            generation: 1,
            revision: 2,
            title: 'Untitled',
            urlOrApp: 'com.apple.TextEdit',
            focus: true,
            frameOrWindowId: 'w-1',
            viewport: { width: 800, height: 600, scale: 2 },
            elements: [
              {
                ref: 'r2.1',
                role: 'textbox',
                name: '验证码',
                value: '123456',
                actions: ['setValue'],
              },
              {
                ref: 'r2.2',
                role: 'textbox',
                name: 'Notes',
                value: 'hello',
                actions: ['setValue'],
              },
              {
                ref: 'r2.3',
                role: 'button',
                name: 'OK',
                value: 'hunter2',
                actions: ['press'],
              },
            ],
            truncated: false,
            redactions: 0,
          }
        : original(method, params),
    )
    const signal = new AbortController().signal
    const target = await bound(k, signal)
    const observe = () =>
      k.driver.observe(
        {
          targetId: target.targetId,
          generation: 1,
          budget: {
            maxElements: 50,
            maxTextBytes: 8192,
            maxDepth: 8,
            timeoutMs: 3000,
          },
          includeText: true,
        },
        signal,
      )
    const before = await observe()
    expect(before.elements.map((element) => element.value)).toEqual([
      '[has content]',
      'hello',
      'hunter2',
    ])
    expect(before.redactions).toBe(1)
    await k.driver.fillCredential(
      {
        operationId: 'op-mask',
        targetId: target.targetId,
        generation: target.generation,
        expectedRevision: target.revision,
        ref: 'r2.2',
        handleId,
        field: 'password',
        binding: {
          kind: 'app',
          bundleId: 'com.apple.TextEdit',
          path: '/System/Applications/TextEdit.app',
        },
      },
      { dispatched: vi.fn() },
      signal,
    )
    const after = await observe()
    expect(after.elements.map((element) => element.value)).toEqual([
      '[has content]',
      '[has content]',
      'hunter2',
    ])
    expect(after.redactions).toBe(2)
    expect(after.notes).toContain(
      'field values stay hidden after a credential fill for this target',
    )
  })

  it('resets only the Helper screen capture TCC record', async () => {
    const resetTcc = vi.fn(async () => undefined)
    const driver = new MacosDesktopDriver({
      connect: async () => {
        throw new Error('reset must not launch the Helper')
      },
      resetTcc,
    } as never)
    await expect(
      (
        driver as unknown as {
          resetPermission(permission: string): Promise<{ reset: boolean }>
        }
      ).resetPermission('screen-recording'),
    ).resolves.toEqual({ reset: true })
    expect(resetTcc).toHaveBeenCalledOnce()
    expect(resetTcc).toHaveBeenCalledWith('/usr/bin/tccutil', [
      'reset',
      'ScreenCapture',
      'com.emperor.agent.desktop.computer-helper',
    ])
  })
})

describe('MacosDesktopDriver self-protection (00 §6.5)', () => {
  const apps = [
    // Dev build: Electron's bundle ID, but this main process.
    { appId: 'com.github.Electron', name: 'Electron', pid: SELF.pid },
    // Another Emperor process, identified only by its executable path.
    { appId: 'com.example.Renamed', name: 'Renamed', pid: 200 },
    { appId: 'com.emperor.agent.desktop', name: 'Emperor Agent', pid: 300 },
    { appId: 'com.apple.TextEdit', name: 'TextEdit', pid: 88 },
  ].map((app) => ({ ...app, frontmost: false, hidden: false }))
  const paths = new Map([
    [200, '/applications/EMPEROR AGENT.app/Contents/MacOS/Emperor Agent'],
    [88, '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit'],
  ])

  function selfFixture(
    processPaths: MacosDesktopDriverOptions['processPaths'],
  ) {
    const request = vi.fn(async (method: string) => {
      if (method === 'apps.list') return { apps }
      if (method === 'windows.list')
        return {
          windows: apps.map((app) => ({
            windowRef: `w-${app.pid}`,
            appId: app.appId,
            appName: app.name,
            pid: app.pid,
            title: app.name,
            minimized: false,
            main: true,
          })),
        }
      if (method === 'target.bind')
        return {
          targetId: 't-88',
          generation: 1,
          revision: 1,
          appId: 'com.apple.TextEdit',
          title: 'TextEdit',
        }
      return {}
    })
    const client = {
      request,
      onEvent: vi.fn(() => () => undefined),
      onDisconnected: vi.fn(() => () => undefined),
      diagnostics: vi.fn(() => ({ connected: true, permissions: {} })),
    } as unknown as HelperClient
    const lookedUp: number[][] = []
    const driver = new MacosDesktopDriver({
      connect: async () => client,
      self: SELF,
      processPaths: async (pids) => {
        lookedUp.push([...pids])
        return await processPaths!(pids)
      },
    })
    return { driver, request, lookedUp }
  }

  it('hides and refuses Emperor by pid, by bundle path and by bundle ID', async () => {
    const k = selfFixture(async () => paths)
    const signal = new AbortController().signal
    expect((await k.driver.listApps(signal)).map((app) => app.appId)).toEqual([
      'com.apple.TextEdit',
    ])
    expect(
      (await k.driver.listWindows({}, signal)).map((item) => item.windowRef),
    ).toEqual(['w-88'])
    expect(k.lookedUp.at(-1)).toEqual([SELF.pid, 200, 300, 88])
    for (const windowRef of [`w-${SELF.pid}`, 'w-200', 'w-300'])
      await expect(
        k.driver.bind({ windowRef, ownerSessionId: 's-1' }, signal),
      ).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN' })
    expect(k.request).not.toHaveBeenCalledWith(
      'target.bind',
      expect.anything(),
      expect.anything(),
    )
    await expect(
      k.driver.bind({ windowRef: 'w-88', ownerSessionId: 's-1' }, signal),
    ).resolves.toMatchObject({ targetId: 't-88', appId: 'com.apple.TextEdit' })
  })

  it('still refuses by pid and bundle ID when path lookup fails', async () => {
    const k = selfFixture(async () => {
      throw new Error('ps unavailable')
    })
    expect(
      (await k.driver.listApps(new AbortController().signal)).map(
        (app) => app.appId,
      ),
    ).toEqual(['com.example.Renamed', 'com.apple.TextEdit'])
  })
})

/** Manual timers: nothing fires until the test advances the clock. */
function manualClock() {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: HelperClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
  }
  return {
    clock,
    get timers() {
      return timers.size
    },
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at))
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
      await settle()
    },
  }
}

/** Lets every pending promise continuation run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A helper connection that behaves like HelperClient on drop and close. */
function fakeHelper(options: { hang?: string } = {}) {
  let connected = true
  let rejectHung: ((error: Error) => void) | undefined
  const dropListeners = new Set<() => void>()
  const drop = () => {
    if (!connected) return
    connected = false
    // HelperClient rejects pending requests before notifying listeners.
    rejectHung?.(new UiError('OUTCOME_UNKNOWN', 'Helper disconnected'))
    for (const listener of [...dropListeners]) listener()
  }
  const request = vi.fn(async (method: string) => {
    if (!connected) throw new UiError('DRIVER_UNAVAILABLE', 'Helper closed')
    if (method === options.hang)
      return await new Promise((_resolve, reject) => {
        rejectHung = reject
      })
    if (method === 'apps.list') return { apps: [] }
    if (method === 'windows.list')
      return {
        windows: [
          {
            windowRef: 'w-1',
            appId: 'com.apple.TextEdit',
            appName: 'TextEdit',
            pid: 88,
            title: 'Untitled',
            minimized: false,
            main: true,
          },
        ],
      }
    if (method === 'target.bind')
      return {
        targetId: 't-1',
        generation: 1,
        revision: 1,
        appId: 'com.apple.TextEdit',
        title: 'Untitled',
      }
    if (method === 'permissions.status')
      return {
        permissions: {
          accessibility: 'granted',
          'screen-recording': 'granted',
        },
      }
    return {}
  })
  const releaseAll = vi.fn(async () => undefined)
  const close = vi.fn(async () => {
    await releaseAll()
    drop()
  })
  const client = {
    request,
    onEvent: vi.fn(() => () => undefined),
    onDisconnected: vi.fn((listener: () => void) => {
      dropListeners.add(listener)
      return () => dropListeners.delete(listener)
    }),
    diagnostics: vi.fn(() => ({
      connected,
      helperVersion: '0.1.0',
      protocol: 1,
      lastErrorCode: null,
      permissions: { accessibility: 'granted', 'screen-recording': 'granted' },
    })),
    releaseAll,
    close,
  } as unknown as HelperClient
  return { client, request, releaseAll, close, crash: drop }
}

function crashFixture(
  launch: (
    attempt: number,
  ) => Promise<ReturnType<typeof fakeHelper>> = async () => fakeHelper(),
) {
  const time = manualClock()
  const helpers: ReturnType<typeof fakeHelper>[] = []
  const connect = vi.fn(async () => {
    const helper = await launch(connect.mock.calls.length)
    helpers.push(helper)
    return helper.client
  })
  const lost: string[] = []
  const driver = new MacosDesktopDriver({
    connect,
    clock: time.clock,
    self: SELF,
    processPaths: async () => new Map(),
    // Never run the real tccutil from a unit test.
    resetTcc: async () => undefined,
  })
  driver.subscribe((event) => {
    if (event.type === 'lost') lost.push(event.reason)
  })
  return { driver, connect, time, helpers, lost }
}

describe('MacosDesktopDriver helper crash recovery (00 §12)', () => {
  it('restarts after 1 s, 2 s and 4 s, then latches until the user reconnects', async () => {
    const k = crashFixture()
    await bound(k)
    expect(k.connect).toHaveBeenCalledTimes(1)

    for (const [index, delay] of [1_000, 2_000, 4_000].entries()) {
      k.helpers.at(-1)!.crash()
      expect(k.lost.at(-1)).toBe('helper disconnected')
      expect(k.driver.capability().reason).toBe(
        'Helper 已断开，正在按退避策略重启',
      )
      await k.time.advance(delay - 1)
      expect(k.connect).toHaveBeenCalledTimes(index + 1)
      await k.time.advance(1)
      expect(k.connect).toHaveBeenCalledTimes(index + 2)
      // Crash recovery asks the new helper to release held input.
      expect(k.helpers.at(-1)!.releaseAll).toHaveBeenCalledOnce()
      // The new helper also releases what the crashed one held (00 §12).
      expect(k.helpers.at(-1)!.releaseAll).toHaveBeenCalledWith({
        recovery: true,
      })
      await bound(k)
    }

    k.helpers.at(-1)!.crash()
    await k.time.advance(60_000)
    expect(k.connect).toHaveBeenCalledTimes(4)
    expect(k.time.timers).toBe(0)
    const status = await k.driver.status()
    expect(status).toMatchObject({
      connected: false,
      lastErrorCode: 'DRIVER_UNAVAILABLE',
      reason: HELPER_CRASH_LATCH_REASON,
      autoRestartSuspended: true,
    })
    expect(k.driver.capability()).toMatchObject({
      available: false,
      reason: HELPER_CRASH_LATCH_REASON,
    })
    await expect(
      k.driver.listApps(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    expect(k.connect).toHaveBeenCalledTimes(4)

    const reconnected = await k.driver.reconnect()
    expect(k.connect).toHaveBeenCalledTimes(5)
    expect(reconnected).toMatchObject({ connected: true })
    expect(reconnected.autoRestartSuspended).toBeUndefined()
    await bound(k)
  })

  it('treats a drop during an in-flight request as a crash', async () => {
    const k = crashFixture(async (attempt) =>
      attempt === 1 ? fakeHelper({ hang: 'apps.list' }) : fakeHelper(),
    )
    const listing = k.driver.listApps(new AbortController().signal)
    await settle()
    k.helpers[0]!.crash()
    await expect(listing).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    await k.time.advance(1_000)
    expect(k.connect).toHaveBeenCalledTimes(2)
  })

  it('does not restart after an idle drop, and reconnects lazily on next use', async () => {
    const k = crashFixture()
    await k.driver.listApps(new AbortController().signal)
    k.helpers[0]!.crash()
    await k.time.advance(60_000)
    expect(k.connect).toHaveBeenCalledTimes(1)
    await k.driver.listApps(new AbortController().signal)
    expect(k.connect).toHaveBeenCalledTimes(2)
  })

  it('never restarts after shutdown, reconnect or a TCC reset closes the helper', async () => {
    const k = crashFixture()
    await bound(k)
    await k.driver.reconnect()
    expect(k.helpers[0]!.close).toHaveBeenCalledOnce()
    expect(k.helpers[0]!.releaseAll).toHaveBeenCalled()
    expect(k.lost).toEqual(['Helper reconnected'])
    await bound(k)
    await k.driver.resetPermission('accessibility')
    expect(k.helpers[1]!.close).toHaveBeenCalledOnce()
    await bound(k)
    await k.driver.shutdown()
    expect(k.helpers[2]!.close).toHaveBeenCalledOnce()
    await k.time.advance(60_000)
    expect(k.connect).toHaveBeenCalledTimes(3)
    await expect(
      k.driver.listApps(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    expect(k.connect).toHaveBeenCalledTimes(3)
  })

  it('retries a failed automatic restart on the next backoff step', async () => {
    const k = crashFixture(async (attempt) => {
      if (attempt === 1) return fakeHelper()
      throw new UiError('DRIVER_UNAVAILABLE', 'helper did not open its socket')
    })
    await bound(k)
    k.helpers[0]!.crash()
    await k.time.advance(1_000)
    expect(k.connect).toHaveBeenCalledTimes(2)
    await k.time.advance(2_000)
    expect(k.connect).toHaveBeenCalledTimes(3)
    await k.time.advance(4_000)
    expect(k.connect).toHaveBeenCalledTimes(4)
    await k.time.advance(60_000)
    expect(k.connect).toHaveBeenCalledTimes(4)
    expect((await k.driver.status()).reason).toBe(HELPER_CRASH_LATCH_REASON)
  })

  it('backs off lazy launch failures and latches with the launch reason', async () => {
    const k = crashFixture(async () => {
      throw new UiError('DRIVER_UNAVAILABLE', 'helper did not open its socket')
    })
    const signal = new AbortController().signal
    await expect(k.driver.listApps(signal)).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
    })
    for (const delay of [1_000, 2_000, 4_000]) {
      const retry = k.driver.listApps(signal).catch((error: unknown) => error)
      await settle()
      // Polling during the wait neither launches nor waits.
      expect(await k.driver.status()).toMatchObject({
        connected: false,
        reason: 'Helper 已断开，正在按退避策略重启',
      })
      const launched = k.connect.mock.calls.length
      await k.time.advance(delay)
      expect(await retry).toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
      expect(k.connect).toHaveBeenCalledTimes(launched + 1)
    }
    expect(await k.driver.status()).toMatchObject({
      reason: HELPER_LAUNCH_LATCH_REASON,
      autoRestartSuspended: true,
    })
    expect(k.connect).toHaveBeenCalledTimes(4)
  })

  it('does not count an intentional close with a request in flight as a crash', async () => {
    const k = crashFixture(async (attempt) =>
      attempt === 1 ? fakeHelper({ hang: 'apps.list' }) : fakeHelper(),
    )
    const listing = k.driver
      .listApps(new AbortController().signal)
      .catch((error: unknown) => error)
    await settle()
    await k.driver.reconnect()
    expect(await listing).toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(k.connect).toHaveBeenCalledTimes(2)
    await k.time.advance(60_000)
    expect(k.connect).toHaveBeenCalledTimes(2)
    expect((await k.driver.status()).connected).toBe(true)
  })

  it('cancels a pending restart when the user reconnects', async () => {
    const k = crashFixture()
    await bound(k)
    k.helpers[0]!.crash()
    await k.driver.reconnect()
    expect(k.connect).toHaveBeenCalledTimes(2)
    await k.time.advance(10_000)
    expect(k.connect).toHaveBeenCalledTimes(2)
    expect(k.time.timers).toBe(0)
  })
})
