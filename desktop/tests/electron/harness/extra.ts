/**
 * `--mode=extra`: real-browser behaviour beyond the shared contract —
 * iframe clicks, off-screen elements, overlays, JS dialogs, a renderer
 * crash, the debugger being taken away (E-B2), profile isolation (§7.2),
 * cross-origin frame honesty (E-B3) and restart recovery (M2.7).
 */

import type {
  ActHooks,
  BrowserProfileSpec,
  DriverEvent,
  DriverObservation,
  TargetSnapshot,
} from '@emperor/core/host-capabilities'
import type { UiAction } from '@emperor/core/runtime-contract'
import { safeStorage, session } from 'electron'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbeddedBrowserDriver } from '../../../src/main/computer-use/embedded-browser-driver'
import { CredentialVault } from '../../../src/main/computer-use/credential-vault'
import { electronBrowserFactory } from '../../../src/main/computer-use/electron-factory'
import { nativeImageCodec } from '../../../src/main/computer-use/images'
import { AgentPreview } from '../../../src/main/computer-use/preview'
import type { AgentPreviewFrame } from '../../../src/shared/ipc-contract'
import { startFixtureSite, type FixtureSite } from '../fixtures/site'
import type { E2eResult } from './main'
import { runRestartRecovery } from './restart'

const BUDGET = {
  maxElements: 400,
  maxTextBytes: 8_192,
  maxDepth: 8,
  timeoutMs: 3_000,
}
const signal = (): AbortSignal => new AbortController().signal
const hooks = (): ActHooks & { count: number } => {
  const value = {
    count: 0,
    dispatched() {
      value.count += 1
    },
  }
  return value
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function observe(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
): Promise<DriverObservation> {
  const now = driver.snapshot(target.targetId)!
  return await driver.observe(
    {
      targetId: target.targetId,
      generation: now.generation,
      budget: BUDGET,
      includeText: true,
    },
    signal(),
  )
}

async function act(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
  observation: DriverObservation,
  action: UiAction,
  actHooks: ActHooks = hooks(),
) {
  const now = driver.snapshot(target.targetId)!
  return await driver.act(
    {
      operationId: `op-${Math.random()}`,
      targetId: target.targetId,
      generation: now.generation,
      expectedRevision: observation.revision,
      action,
      deadlineMs: 10_000,
    },
    actHooks,
    signal(),
  )
}

/**
 * Hooks for an action that must be refused before any side effect. Text or
 * keys sent into a cross-origin frame hang Electron's main thread (E-B3), so
 * a missed guard fails here instead of hanging the suite.
 */
const NEVER_DISPATCH: ActHooks = {
  dispatched() {
    throw new Error('the driver dispatched input it should have refused')
  },
}

/** The UiError code and reason of a refused call ('ok' if it went through). */
async function refusal(
  work: Promise<unknown>,
): Promise<{ code: string; reason?: string; message: string }> {
  try {
    await work
    return { code: 'ok', message: '' }
  } catch (error) {
    const failure = error as { code?: string; reason?: string }
    return {
      code: failure.code ?? 'thrown',
      ...(failure.reason === undefined ? {} : { reason: failure.reason }),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Observe until an element named `name` shows up (OOPIFs attach late). */
async function observeUntil(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
  name: string,
  timeoutMs = 5_000,
): Promise<DriverObservation> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const observation = await observe(driver, target)
    if (observation.elements.some((item) => item.name === name))
      return observation
    if (Date.now() > deadline)
      throw new Error(`element "${name}" never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function navigate(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
  url: string,
): Promise<void> {
  const now = driver.snapshot(target.targetId)!
  await driver.act(
    {
      operationId: `op-${Math.random()}`,
      targetId: target.targetId,
      generation: now.generation,
      expectedRevision: now.revision,
      action: { kind: 'navigate', url },
      deadlineMs: 10_000,
    },
    hooks(),
    signal(),
  )
}

/** What `/storage` shows the Agent: `cookie=<v> local=<v>` of its profile. */
async function storageState(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
): Promise<string> {
  const observation = await observe(driver, target)
  const state = /cookie=[\w-]+ local=[\w-]+/.exec(
    observation.textExcerpt ?? '',
  )?.[0]
  check(
    state !== undefined,
    `no storage state in ${JSON.stringify(observation.textExcerpt)}`,
  )
  return state
}

const TEMPORARY: BrowserProfileSpec = { kind: 'temporary' }
const persistent = (profileId: string): BrowserProfileSpec => ({
  kind: 'persistent',
  profileId,
})

const refOf = (observation: DriverObservation, name: string): string => {
  const element = observation.elements.find((item) => item.name === name)
  check(element !== undefined, `element "${name}" not observed`)
  return element.ref
}

type Case = (
  driver: EmbeddedBrowserDriver,
  site: FixtureSite,
  events: DriverEvent[],
) => Promise<unknown>

const CASES: Record<string, Case> = {
  'credential fill uses a main-only vault and exact origin': async (
    _driver,
    site,
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-vault-e2e-'))
    const vaultPath = join(root, 'computer-use', 'vault.json')
    const vault = new CredentialVault({ path: vaultPath, storage: safeStorage })
    check(
      vault.available,
      'safeStorage is unavailable in this Electron session',
    )
    const secret = 'e2e-private-password-74291'
    const handle = vault.save({
      label: 'fixture',
      bindings: [{ kind: 'origin', origin: site.origin }],
      username: 'alice',
      password: secret,
    })
    const driver = new EmbeddedBrowserDriver({
      electron: electronBrowserFactory(),
      images: nativeImageCodec,
      platform: 'macos',
      credentials: vault,
    })
    driver.setNavigationPolicy(() => 'allow')
    try {
      const target = await open(driver, site, '/form')
      const first = await observe(driver, target)
      const passwordRef = refOf(first, 'Password')
      let mismatch = ''
      try {
        await driver.fillCredential(
          {
            operationId: 'mismatch',
            targetId: target.targetId,
            generation: first.generation,
            expectedRevision: first.revision,
            ref: passwordRef,
            handleId: handle.handleId,
            field: 'password',
            origin: site.otherOrigin,
          },
          hooks(),
          signal(),
        )
      } catch (error) {
        mismatch = (error as { code?: string }).code ?? String(error)
      }
      check(
        mismatch === 'PERMISSION_DENIED',
        `wrong origin yielded ${mismatch}`,
      )
      let wrongField = ''
      try {
        await driver.fillCredential(
          {
            operationId: 'wrong-field',
            targetId: target.targetId,
            generation: first.generation,
            expectedRevision: first.revision,
            ref: passwordRef,
            handleId: handle.handleId,
            field: 'username',
            origin: site.origin,
          },
          hooks(),
          signal(),
        )
      } catch (error) {
        wrongField = (error as { code?: string }).code ?? String(error)
      }
      check(
        wrongField === 'INVALID_REQUEST',
        `wrong field yielded ${wrongField}`,
      )
      const dispatch = hooks()
      const result = await driver.fillCredential(
        {
          operationId: 'fill',
          targetId: target.targetId,
          generation: first.generation,
          expectedRevision: first.revision,
          ref: passwordRef,
          handleId: handle.handleId,
          field: 'password',
          origin: site.origin,
        },
        dispatch,
        signal(),
      )
      check(
        result.filled && dispatch.count === 1,
        'password was not filled once',
      )
      const actual = await driver.manager
        .get(target.targetId)!
        .contents.executeJavaScript(
          'document.querySelector("input[type=password]").value',
        )
      check(actual === secret, 'password field value does not match')
      const after = await observe(driver, target)
      check(
        !JSON.stringify({ after, result, handles: vault.list() }).includes(
          secret,
        ),
        'secret leaked through observation or result',
      )
      let screenshotBlocked = ''
      try {
        await driver.screenshot(
          {
            targetId: target.targetId,
            generation: driver.snapshot(target.targetId)!.generation,
            modelCopy: true,
            modelMaxEdge: 1200,
          },
          signal(),
        )
      } catch (error) {
        screenshotBlocked = (error as { code?: string }).code ?? String(error)
      }
      check(
        screenshotBlocked === 'CAPABILITY_DISABLED',
        `credential screenshot yielded ${screenshotBlocked}`,
      )
      check(
        !readFileSync(vaultPath, 'utf8').includes(secret),
        'secret was stored as plaintext',
      )
      return {
        filled: result.filled,
        mismatch,
        wrongField,
        screenshotBlocked,
        encryptedAtRest: true,
        observedSecret: false,
      }
    } finally {
      await driver.shutdown()
    }
  },
  'site permissions are denied until the matching origin is allowed': async (
    driver,
    site,
  ) => {
    const allowed = new Set<string>()
    driver.setSitePermissionPolicy(({ origin, kind }) =>
      allowed.has(`${origin}|${kind}`),
    )
    const deniedTab = await open(driver, site, '/form')
    const denied = await driver.manager
      .get(deniedTab.targetId)!
      .contents.executeJavaScript('Notification.requestPermission()')
    check(
      denied !== 'granted',
      `notification permission was ${denied} without a grant`,
    )
    allowed.add(`${site.otherOrigin}|notifications`)
    const other = await driver.open(
      {
        profile: { kind: 'temporary' },
        url: `${site.otherOrigin}/form`,
        ownerSessionId: 'extra',
      },
      signal(),
    )
    const granted = await driver.manager
      .get(other.targetId)!
      .contents.executeJavaScript('Notification.requestPermission()')
    check(granted === 'granted', `matching origin received ${granted}`)
    return { denied, granted }
  },
  'click inside a same-origin iframe': async (driver, site) => {
    const target = await open(driver, site, '/frames')
    const first = await observe(driver, target)
    await act(driver, target, first, {
      kind: 'click',
      ref: refOf(first, 'Inner button'),
    })
    const after = await observe(driver, target)
    check(
      after.elements.some((item) => item.name === 'Inner clicked'),
      'the iframe button did not react',
    )
  },
  'E-B3: click inside a cross-origin iframe (OOPIF child session)': async (
    driver,
    site,
  ) => {
    const target = await open(driver, site, '/frames')
    // Child sessions attach asynchronously after the load.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const first = await observe(driver, target)
    await act(driver, target, first, {
      kind: 'click',
      ref: refOf(first, 'Cross-origin button'),
    })
    const after = await observe(driver, target)
    check(
      after.elements.some((item) => item.name === 'Cross-origin clicked'),
      'the cross-origin button did not react',
    )
    let refused = ''
    try {
      await act(driver, target, after, {
        kind: 'fill',
        ref: refOf(after, 'Embedded note'),
        text: 'hello',
      })
    } catch (error) {
      refused = (error as { code?: string }).code ?? String(error)
    }
    check(
      refused === 'CAPABILITY_DISABLED',
      `typing into the OOPIF is refused (${refused})`,
    )
  },
  'click an element far down the page (scrolled into view)': async (
    driver,
    site,
  ) => {
    const target = await open(driver, site, '/long')
    const first = await observe(driver, target)
    await act(driver, target, first, {
      kind: 'click',
      ref: refOf(first, 'Item 300'),
    })
    const now = driver.snapshot(target.targetId)!
    check(now.url.endsWith('#300'), `landed on ${now.url}`)
  },
  'an overlay covering the element is refused before dispatch': async (
    driver,
    site,
  ) => {
    const target = await open(driver, site, '/overlay')
    const first = await observe(driver, target)
    try {
      await act(driver, target, first, {
        kind: 'click',
        ref: refOf(first, 'Covered button'),
      })
      throw new Error('click on a covered element succeeded')
    } catch (error) {
      check(
        (error as { reason?: string }).reason === 'obscured',
        `unexpected error ${String(error)}`,
      )
    }
    await act(driver, target, first, {
      kind: 'click',
      ref: refOf(first, 'Accept cookies'),
    })
    const second = await observe(driver, target)
    await act(driver, target, second, {
      kind: 'click',
      ref: refOf(second, 'Covered button'),
    })
    const third = await observe(driver, target)
    check(
      third.elements.some((item) => item.name === 'reached'),
      'button not reached after the overlay closed',
    )
  },
  'JS dialogs never hang the tab and are reported': async (driver, site) => {
    const target = await open(driver, site, '/dialog')
    const first = await observe(driver, target)
    await act(driver, target, first, {
      kind: 'click',
      ref: refOf(first, 'Show alert'),
    })
    const second = await observe(driver, target)
    check(
      (second.textExcerpt ?? '').includes('after alert'),
      'the page did not continue after the alert',
    )
    check(
      (second.notes ?? []).some((note) => note.includes('alert dialog')),
      'the alert was not reported',
    )
    await act(driver, target, second, {
      kind: 'click',
      ref: refOf(second, 'Ask confirm'),
    })
    const third = await observe(driver, target)
    check(
      (third.textExcerpt ?? '').includes('declined'),
      'confirm was not dismissed',
    )
  },
  'a renderer crash reports the tab as lost': async (driver, site, events) => {
    const target = await open(driver, site, '/form')
    driver.manager.get(target.targetId)!.contents.forcefullyCrashRenderer()
    await until(() =>
      events.some(
        (event) => event.type === 'lost' && event.targetId === target.targetId,
      ),
    )
    check(driver.snapshot(target.targetId) === null, 'crashed tab still listed')
  },
  'E-B2: a detached debugger is reported and re-attached with a new generation':
    async (driver, site, events) => {
      const target = await open(driver, site, '/form')
      await observe(driver, target)
      const before = driver.snapshot(target.targetId)!.generation
      driver.manager.get(target.targetId)!.contents.debugger.detach()
      await until(() =>
        events.some(
          (event) =>
            event.type === 'detached' && event.targetId === target.targetId,
        ),
      )
      const again = await observe(driver, target)
      check(
        again.generation === before + 1,
        `generation ${again.generation}, expected ${before + 1}`,
      )
      return {
        detachReason: (
          events.find((event) => event.type === 'detached') as {
            reason?: string
          }
        ).reason,
      }
    },
  // Offscreen Agent tabs cannot host DevTools in Electron 42 (observed
  // isDevToolsOpened() === false); if a future version can, the driver must
  // notice the takeover and recover once DevTools closes.
  'E-B2: DevTools on an Agent tab never leaves the driver silently broken':
    async (driver, site, events) => {
      const target = await open(driver, site, '/form')
      await observe(driver, target)
      const contents = driver.manager.get(target.targetId)!.contents
      const before = events.length
      contents.openDevTools({ mode: 'detach', activate: false })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const detached = events
        .slice(before)
        .some((event) => event.type === 'detached')
      let observeWhileOpen = 'ok'
      try {
        await observe(driver, target)
      } catch (error) {
        observeWhileOpen = String((error as { code?: string }).code)
      }
      const devtoolsOpen = contents.isDevToolsOpened()
      contents.closeDevTools()
      await new Promise((resolve) => setTimeout(resolve, 500))
      let observeAfterClose = 'ok'
      try {
        await observe(driver, target)
      } catch (error) {
        observeAfterClose = String((error as { code?: string }).code)
      }
      if (devtoolsOpen)
        check(
          detached || observeWhileOpen === 'DRIVER_UNAVAILABLE',
          'DevTools took the debugger without the driver noticing',
        )
      else
        check(observeWhileOpen === 'ok', `observe failed: ${observeWhileOpen}`)
      check(
        observeAfterClose === 'ok',
        `no recovery after DevTools: ${observeAfterClose}`,
      )
      return {
        devtoolsOpen,
        detachedEvent: detached,
        observeWhileOpen,
        observeAfterClose,
      }
    },
  'E-B5: preview streams frames and forwards takeover input': async (
    driver,
    site,
  ) => {
    const frames: AgentPreviewFrame[] = []
    let takeover = false
    const preview = new AgentPreview({
      manager: driver.manager,
      send: (frame) => frames.push(frame),
      canTakeInput: () => takeover,
    })
    const animated = await open(driver, site, '/animate')
    preview.start(animated.targetId)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    preview.stop(animated.targetId)
    const streamed = frames.length
    const bytes = frames.reduce((sum, frame) => sum + frame.jpeg.byteLength, 0)
    const size =
      frames[0] === undefined ? null : `${frames[0].width}x${frames[0].height}`

    const form = await open(driver, site, '/form')
    const first = await observe(driver, form)
    const name = first.elements.find((item) => item.name === 'Name')!
    const x = name.bounds!.x + name.bounds!.width / 2
    const y = name.bounds!.y + name.bounds!.height / 2
    preview.start(form.targetId)
    const refused = preview.input(form.targetId, {
      type: 'text',
      text: 'blocked',
    })
    takeover = true
    preview.input(form.targetId, {
      type: 'mouseDown',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    preview.input(form.targetId, {
      type: 'mouseUp',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    preview.input(form.targetId, { type: 'text', text: '你好 Zhang' })
    preview.input(form.targetId, { type: 'keyDown', key: 'Backspace' })
    preview.input(form.targetId, { type: 'keyUp', key: 'Backspace' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    preview.stopAll()
    const after = await observe(driver, form)
    const value = after.elements.find((item) => item.name === 'Name')?.value
    check(streamed > 0, 'no frames streamed')
    check(refused === false, 'input was forwarded without takeover')
    check(
      value === '你好 Zhan',
      `forwarded typing gave ${JSON.stringify(value)}`,
    )
    return {
      framesIn2s: streamed,
      avgJpegBytes: Math.round(bytes / Math.max(1, streamed)),
      size,
      typed: value,
    }
  },
  // webContents.debugger is one object per tab, so a second attach from this
  // process cannot simulate another owner (that mapping to
  // DRIVER_UNAVAILABLE is unit-tested in cdp.test.ts). What this proves: a
  // stray detach/attach cycle on the shared object does not break the driver.
  'E-B2: a detach/attach cycle on the shared debugger does not break the driver':
    async (driver, site) => {
      const target = await open(driver, site, '/form')
      const contents = driver.manager.get(target.targetId)!.contents
      contents.debugger.detach()
      contents.debugger.attach('1.3') // someone else owns it now
      let code = ''
      try {
        await observe(driver, target)
      } catch (error) {
        code = String((error as { code?: string }).code)
      }
      contents.debugger.detach()
      const recovered = await observe(driver, target)
      check(recovered.elements.length > 0, 'the driver did not recover')
      return {
        whileHeld:
          code || 'no error (the driver reused the existing attachment)',
        recovered: recovered.elements.length > 0,
      }
    },
  '§7.2: temporary and persistent profiles never share cookies or storage':
    async (_driver, site) => {
      // Persistent profiles need a profiles root; the shared driver has none.
      const root = mkdtempSync(join(tmpdir(), 'emperor-e2e-profiles-'))
      const driver = new EmbeddedBrowserDriver({
        electron: electronBrowserFactory(),
        images: nativeImageCodec,
        platform: 'macos',
        profilesRoot: join(root, 'profiles'),
      })
      driver.setNavigationPolicy(() => 'allow')
      const mail = persistent('p_a11ce0000001')
      const other = persistent('p_b0b000000002')
      const expect = (seen: string, wanted: string, what: string): void =>
        check(seen === wanted, `${what}: saw ${seen}, expected ${wanted}`)
      try {
        const temp = await open(driver, site, '/storage?set=temp-a')
        expect(
          await storageState(driver, temp),
          'cookie=temp-a local=temp-a',
          'temporary tab keeps its own data',
        )
        const kept = await open(driver, site, '/storage', mail)
        expect(
          await storageState(driver, kept),
          'cookie=none local=none',
          'persistent tab sees temporary data',
        )
        await navigate(driver, kept, `${site.origin}/storage?set=kept-a`)
        expect(
          await storageState(driver, kept),
          'cookie=kept-a local=kept-a',
          'persistent tab keeps its own data',
        )
        await navigate(driver, temp, `${site.origin}/storage`)
        expect(
          await storageState(driver, temp),
          'cookie=temp-a local=temp-a',
          'temporary tab sees persistent data',
        )
        // DEV-11: one partition per temporary tab, even while both are open.
        const second = await open(driver, site, '/storage')
        expect(
          await storageState(driver, second),
          'cookie=none local=none',
          'second temporary tab shares the first one’s data',
        )
        const partitions = [temp, second].map(
          (target) => driver.manager.get(target.targetId)!.partition,
        )
        check(
          partitions[0] !== partitions[1],
          `temporary tabs share partition ${partitions[0]}`,
        )
        const stranger = await open(driver, site, '/storage', other)
        expect(
          await storageState(driver, stranger),
          'cookie=none local=none',
          'another persistent profile sees this one’s data',
        )
        // A persistent profile outlives its tab.
        await driver.close(kept.targetId, 'agent')
        check(driver.snapshot(kept.targetId) === null, 'closed tab listed')
        const reopened = await open(driver, site, '/storage', mail)
        check(
          reopened.targetId !== kept.targetId,
          'reopening reused the old targetId',
        )
        expect(
          await storageState(driver, reopened),
          'cookie=kept-a local=kept-a',
          'persistent profile after close and reopen',
        )
        // A temporary profile ends with its tab (in-memory partition wiped).
        const tempSession = driver.manager.get(temp.targetId)!.session
        const partition = driver.manager.get(temp.targetId)!.partition
        check(
          (await tempSession.cookies.get({ name: 'cu_probe' })).length === 1,
          'temporary cookie missing before close',
        )
        await driver.close(temp.targetId, 'agent')
        const leftover = await session
          .fromPartition(partition)
          .cookies.get({ name: 'cu_probe' })
        check(
          leftover.length === 0,
          `temporary partition kept ${leftover.length} cookie(s) after its tab closed`,
        )
        return {
          partitions: partitions.map((name) => name.slice(0, 20)),
          reopened: 'cookie=kept-a local=kept-a',
          temporaryWiped: true,
        }
      } finally {
        await driver.shutdown()
        rmSync(root, { recursive: true, force: true })
      }
    },
  'M2.7: a persistent-profile tab is offered again after a real restart':
    async (_driver, site) => await runRestartRecovery(site),
  'E-B3: the OOPIF text-input gap is declared and typing into one is refused':
    async (driver, site) => {
      const capability = driver.capability()
      const gap = capability.missing.find(
        (item) => /跨源\s*iframe/.test(item) && /文本输入/.test(item),
      )
      check(
        gap !== undefined,
        `capability.missing does not declare the cross-origin iframe text input gap: ${JSON.stringify(capability.missing)}`,
      )
      check(
        capability.actions.includes('typeText') &&
          capability.actions.includes('press'),
        'typeText/press are not listed as actions',
      )
      const target = await open(driver, site, '/frames')
      const first = await observeUntil(driver, target, 'Embedded note')
      const note = refOf(first, 'Embedded note')
      const refused = {
        typeText: await refusal(
          act(
            driver,
            target,
            first,
            { kind: 'typeText', ref: note, text: 'hello' },
            NEVER_DISPATCH,
          ),
        ),
        press: await refusal(
          act(
            driver,
            target,
            first,
            { kind: 'press', ref: note, key: 'Enter' },
            NEVER_DISPATCH,
          ),
        ),
      }
      // Focus inside the frame (a real click on its field), then keys
      // without a ref: they would go to the frame, so they are refused too.
      await act(driver, target, first, { kind: 'click', ref: note })
      const focused = await observe(driver, target)
      const unfocused = {
        typeText: await refusal(
          act(
            driver,
            target,
            focused,
            { kind: 'typeText', text: 'hello' },
            NEVER_DISPATCH,
          ),
        ),
        press: await refusal(
          act(
            driver,
            target,
            focused,
            { kind: 'press', key: 'a' },
            NEVER_DISPATCH,
          ),
        ),
      }
      for (const [name, result] of Object.entries({
        'typeText into the frame field': refused.typeText,
        'press on the frame field': refused.press,
        'typeText with focus in the frame': unfocused.typeText,
        'press with focus in the frame': unfocused.press,
      }))
        check(
          result.code === 'CAPABILITY_DISABLED' &&
            result.reason === 'cross-origin-frame-input',
          `${name}: ${JSON.stringify(result)}`,
        )
      const after = await observe(driver, target)
      const value = after.elements.find(
        (item) => item.name === 'Embedded note',
      )?.value
      check(!value, `the frame field changed to ${JSON.stringify(value)}`)
      return {
        missing: gap,
        refused: [refused, unfocused].flatMap((group) =>
          Object.values(group).map((result) => result.reason),
        ),
      }
    },
  'frameOrigin marks elements of a cross-origin iframe only': async (
    driver,
    site,
  ) => {
    const target = await open(driver, site, '/frames')
    const observation = await observeUntil(
      driver,
      target,
      'Cross-origin button',
    )
    const element = (name: string) => {
      const found = observation.elements.find((item) => item.name === name)
      check(found !== undefined, `element "${name}" not observed`)
      return found
    }
    const cross = element('Cross-origin button')
    const note = element('Embedded note')
    const inner = element('Inner button')
    const outer = element('Outer button')
    check(
      cross.frameOrigin === site.otherOrigin &&
        note.frameOrigin === site.otherOrigin,
      `cross-origin frame elements carry ${JSON.stringify([cross.frameOrigin, note.frameOrigin])}, expected ${site.otherOrigin}`,
    )
    check(cross.frameId !== undefined, 'cross-origin element has no frameId')
    check(
      inner.frameId !== undefined && inner.frameId !== cross.frameId,
      'the same-origin frame element is not marked as in a frame',
    )
    check(
      inner.frameOrigin === undefined,
      `same-origin frame element carries frameOrigin ${inner.frameOrigin}`,
    )
    check(
      outer.frameId === undefined && outer.frameOrigin === undefined,
      'a main-frame element carries frame fields',
    )
    return {
      cross: cross.frameOrigin,
      sameOriginFrame: inner.frameOrigin ?? null,
      mainFrame: outer.frameOrigin ?? null,
    }
  },
}

async function open(
  driver: EmbeddedBrowserDriver,
  site: FixtureSite,
  path: string,
  profile: BrowserProfileSpec = TEMPORARY,
): Promise<TargetSnapshot> {
  return await driver.open(
    {
      profile,
      url: new URL(path, site.origin).toString(),
      ownerSessionId: 'extra',
    },
    signal(),
  )
}

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function runExtra(
  report: (result: E2eResult) => void,
): Promise<void> {
  const site = await startFixtureSite()
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: 'macos',
  })
  driver.setNavigationPolicy(() => 'allow')
  const events: DriverEvent[] = []
  driver.subscribe((event) => events.push(event))
  try {
    for (const [name, run] of Object.entries(CASES)) {
      const started = Date.now()
      try {
        const detail = await run(driver, site, events)
        report({
          suite: 'extra',
          name,
          ok: true,
          ms: Date.now() - started,
          ...(detail === undefined ? {} : { detail }),
        })
      } catch (error) {
        report({
          suite: 'extra',
          name,
          ok: false,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await driver.shutdown()
    await site.close()
  }
}
