/**
 * Browser driver contract (spec 00 §13.1): one set of cases, written as
 * data, run against the fake driver (core tests) and the real embedded
 * browser driver (Electron end-to-end). Cases throw on failure and do not
 * depend on any test framework.
 */

import { UiError } from '../errors'
import type {
  ActHooks,
  BrowserDriver,
  DriverEvent,
  DriverObservation,
  ObserveBudget,
  TargetSnapshot,
} from '../port'
import type { UiAction } from '../types'

export interface ContractEnv {
  readonly driver: BrowserDriver
  /** Fixture page on the primary origin, e.g. `url('/form')`. */
  url(path: string): string
  /** Fixture page on the second origin. */
  otherUrl(path: string): string
  /** Optional capabilities some drivers cannot provide. */
  readonly features?: {
    /** Cross-origin frames are expanded (M2). */
    readonly crossOriginFrames?: boolean
  }
}

export interface ContractCase {
  readonly name: string
  run(env: ContractEnv): Promise<void>
}

const BUDGET: ObserveBudget = {
  maxElements: 200,
  maxTextBytes: 16 * 1024,
  maxDepth: 8,
  timeoutMs: 3_000,
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`contract: ${message}`)
}

async function expectCode(
  promise: Promise<unknown>,
  codes: readonly string[],
  message: string,
): Promise<UiError> {
  try {
    await promise
  } catch (error) {
    check(
      error instanceof UiError,
      `${message}: expected a UiError, got ${String(error)}`,
    )
    check(
      codes.includes(error.code),
      `${message}: expected ${codes.join(' / ')}, got ${error.code} (${error.message})`,
    )
    return error
  }
  throw new Error(
    `contract: ${message}: expected ${codes.join(' / ')}, but it succeeded`,
  )
}

const signal = (): AbortSignal => new AbortController().signal

async function open(env: ContractEnv, path: string): Promise<TargetSnapshot> {
  return await env.driver.open(
    {
      profile: { kind: 'temporary' },
      url: env.url(path),
      ownerSessionId: 'contract',
    },
    signal(),
  )
}

async function observe(
  env: ContractEnv,
  target: TargetSnapshot,
  extra: Partial<Parameters<BrowserDriver['observe']>[0]> = {},
): Promise<DriverObservation> {
  const snapshot = env.driver.snapshot(target.targetId) ?? target
  return await env.driver.observe(
    {
      targetId: target.targetId,
      generation: snapshot.generation,
      budget: BUDGET,
      includeText: true,
      ...extra,
    },
    signal(),
  )
}

function refOf(observation: DriverObservation, name: string): string {
  const element = observation.elements.find(
    (candidate) => candidate.name === name,
  )
  check(element !== undefined, `element "${name}" is observed`)
  return element.ref
}

function counter(): ActHooks & { count: number } {
  const hooks = {
    count: 0,
    dispatched() {
      hooks.count += 1
    },
  }
  return hooks
}

async function act(
  env: ContractEnv,
  target: TargetSnapshot,
  observation: DriverObservation,
  action: UiAction,
  hooks: ActHooks = counter(),
  abort?: AbortSignal,
) {
  const snapshot = env.driver.snapshot(target.targetId) ?? target
  return await env.driver.act(
    {
      operationId: `op-${Math.random().toString(36).slice(2)}`,
      targetId: target.targetId,
      generation: snapshot.generation,
      expectedRevision: observation.revision,
      action,
      deadlineMs: 10_000,
    },
    hooks,
    abort ?? signal(),
  )
}

async function withTarget(
  env: ContractEnv,
  path: string,
  body: (target: TargetSnapshot) => Promise<void>,
): Promise<void> {
  const target = await open(env, path)
  try {
    await body(target)
  } finally {
    await env.driver.close(target.targetId, 'agent')
  }
}

export const DRIVER_CONTRACT_CASES: readonly ContractCase[] = [
  {
    name: 'open mints unguessable ids and starts at generation 1',
    run: async (env) => {
      const a = await open(env, '/form')
      const b = await open(env, '/form')
      try {
        check(a.targetId !== b.targetId, 'two opens give two ids')
        check(a.targetId.length >= 16, 'ids are long enough to be unguessable')
        check(a.generation >= 1, 'generation starts at 1')
        check(a.driver === env.driver.driver, 'driver kind matches')
        check(
          env.driver.list().some((item) => item.targetId === a.targetId),
          'listed',
        )
      } finally {
        await env.driver.close(a.targetId, 'agent')
        await env.driver.close(b.targetId, 'agent')
      }
    },
  },
  {
    name: 'observe assigns per-revision refs and bumps the revision',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const first = await observe(env, target)
        const second = await observe(env, target)
        check(
          second.revision > first.revision,
          'each observation bumps the revision',
        )
        for (const element of second.elements)
          check(
            element.ref.startsWith(`r${second.revision}.`),
            `ref ${element.ref} belongs to revision ${second.revision}`,
          )
        for (const name of ['Name', 'Email', 'Submit']) refOf(second, name)
        check(second.title === 'Fixture form', `title is "${second.title}"`)
        check(
          (second.textExcerpt ?? '').includes('newsletter'),
          'page text is excerpted',
        )
      }),
  },
  {
    name: 'observe never exposes secret field values',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const observation = await observe(env, target)
        check(
          observation.redactions >= 3,
          `redactions counted (${observation.redactions})`,
        )
        for (const name of ['Password', 'Card number', 'One-time code']) {
          const element = observation.elements.find(
            (item) => item.name === name,
          )
          check(element !== undefined, `${name} is listed`)
          check(
            element.value === undefined ||
              element.value === '' ||
              element.value === '[has content]',
            `${name} value is masked (${String(element.value)})`,
          )
        }
      }),
  },
  {
    name: 'observe honours the element budget with a cursor on the same revision',
    run: async (env) =>
      await withTarget(env, '/long', async (target) => {
        const first = await observe(env, target, {
          budget: { ...BUDGET, maxElements: 50 },
        })
        check(first.truncated, 'a long page is truncated')
        check(first.elements.length <= 50, 'budget respected')
        check(first.cursor !== undefined, 'a cursor is returned')
        const next = await observe(env, target, {
          budget: { ...BUDGET, maxElements: 50 },
          cursor: first.cursor,
        })
        check(
          next.revision === first.revision,
          'cursor pages keep the revision',
        )
        const seen = new Set(first.elements.map((element) => element.ref))
        check(
          next.elements.every((element) => !seen.has(element.ref)),
          'cursor pages do not repeat refs',
        )
      }),
  },
  {
    name: 'observe filters by role and name',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const buttons = await observe(env, target, {
          query: { role: 'button' },
        })
        check(buttons.elements.length > 0, 'buttons found')
        check(
          buttons.elements.every((element) => element.role === 'button'),
          'only buttons returned',
        )
        const named = await observe(env, target, {
          query: { nameContains: 'mail' },
        })
        check(
          named.elements.some((element) => element.name === 'Email'),
          'name filter matches',
        )
      }),
  },
  {
    name: 'a ref from an older revision is STALE_ELEMENT and nothing is sent',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const old = await observe(env, target)
        const current = await observe(env, target)
        const hooks = counter()
        const snapshot = env.driver.snapshot(target.targetId)!
        await expectCode(
          env.driver.act(
            {
              operationId: 'op-stale',
              targetId: target.targetId,
              generation: snapshot.generation,
              expectedRevision: current.revision,
              action: { kind: 'click', ref: refOf(old, 'I agree') },
              deadlineMs: 5_000,
            },
            hooks,
            signal(),
          ),
          ['STALE_ELEMENT'],
          'old ref',
        )
        check(hooks.count === 0, 'dispatched was not called')
      }),
  },
  {
    name: 'fill writes text and reads it back',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const before = await observe(env, target)
        const hooks = counter()
        const result = await act(
          env,
          target,
          before,
          { kind: 'fill', ref: refOf(before, 'Name'), text: '张三 Zhang' },
          hooks,
        )
        check(result.outcome === 'observed', 'fill observed')
        check(hooks.count === 1, 'dispatched exactly once')
        const after = await observe(env, target)
        const field = after.elements.find((element) => element.name === 'Name')
        check(
          field?.value === '张三 Zhang',
          `value read back (${String(field?.value)})`,
        )
      }),
  },
  {
    name: 'fill refuses secret fields before dispatch',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const observation = await observe(env, target)
        const hooks = counter()
        const error = await expectCode(
          act(
            env,
            target,
            observation,
            {
              kind: 'fill',
              ref: refOf(observation, 'Password'),
              text: 'hunter2',
            },
            hooks,
          ),
          ['PERMISSION_DENIED'],
          'password fill',
        )
        check(
          error.reason === 'secret-field',
          `reason is ${String(error.reason)}`,
        )
        check(hooks.count === 0, 'nothing was sent')
      }),
  },
  {
    name: 'click toggles a checkbox and select picks an option',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const first = await observe(env, target)
        await act(env, target, first, {
          kind: 'click',
          ref: refOf(first, 'I agree'),
        })
        const second = await observe(env, target)
        const box = second.elements.find(
          (element) => element.name === 'I agree',
        )
        check(box?.states?.includes('checked') === true, 'checkbox checked')
        await act(env, target, second, {
          kind: 'select',
          ref: refOf(second, 'Country'),
          option: 'Japan',
        })
        const third = await observe(env, target)
        const country = third.elements.find(
          (element) => element.name === 'Country',
        )
        check(
          country?.value === 'Japan',
          `selected value (${String(country?.value)})`,
        )
      }),
  },
  {
    name: 'navigation bumps the generation and makes old refs stale',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const before = await observe(env, target)
        const beforeGeneration = env.driver.snapshot(
          target.targetId,
        )!.generation
        await act(env, target, before, {
          kind: 'click',
          ref: refOf(before, 'Submit'),
        })
        const after = env.driver.snapshot(target.targetId)!
        check(after.generation > beforeGeneration, 'generation bumped')
        check(after.url === env.url('/done'), `landed on /done (${after.url})`)
        await expectCode(
          env.driver.act(
            {
              operationId: 'op-old-generation',
              targetId: target.targetId,
              generation: beforeGeneration,
              expectedRevision: before.revision,
              action: { kind: 'click', ref: refOf(before, 'Name') },
              deadlineMs: 5_000,
            },
            counter(),
            signal(),
          ),
          ['STALE_TARGET', 'STALE_ELEMENT'],
          'old generation',
        )
      }),
  },
  {
    name: 'navigate and history move between pages',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const observation = await observe(env, target)
        await act(env, target, observation, {
          kind: 'navigate',
          url: env.url('/done'),
        })
        check(
          env.driver.snapshot(target.targetId)!.url === env.url('/done'),
          'navigated',
        )
        check(
          env.driver.historyTarget(target.targetId, 'back') ===
            env.url('/form'),
          'history target known before moving',
        )
        const again = await observe(env, target)
        await act(env, target, again, { kind: 'history', direction: 'back' })
        check(
          env.driver.snapshot(target.targetId)!.url === env.url('/form'),
          'went back',
        )
      }),
  },
  {
    name: 'the navigation policy blocks agent navigation it refuses',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const blocked = env.otherUrl('/done')
        const blockedOrigin = new URL(blocked).origin
        env.driver.setNavigationPolicy((request) =>
          new URL(request.url).origin === blockedOrigin ? 'block' : 'allow',
        )
        try {
          const observation = await observe(env, target)
          await expectCode(
            act(env, target, observation, { kind: 'navigate', url: blocked }),
            ['PERMISSION_REQUIRED', 'PERMISSION_DENIED'],
            'blocked navigation',
          )
          check(
            env.driver.snapshot(target.targetId)!.url === env.url('/form'),
            'stayed on the page',
          )
        } finally {
          env.driver.setNavigationPolicy(() => 'allow')
        }
      }),
  },
  {
    name: 'an abort before dispatch sends nothing',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const observation = await observe(env, target)
        const controller = new AbortController()
        controller.abort()
        const hooks = counter()
        try {
          await act(
            env,
            target,
            observation,
            { kind: 'click', ref: refOf(observation, 'I agree') },
            hooks,
            controller.signal,
          )
        } catch {
          // expected
        }
        check(hooks.count === 0, 'nothing was sent after an abort')
      }),
  },
  {
    name: 'same-document routes bump the revision but keep the generation',
    run: async (env) =>
      await withTarget(env, '/spa', async (target) => {
        const before = await observe(env, target)
        const generation = env.driver.snapshot(target.targetId)!.generation
        await act(env, target, before, {
          kind: 'click',
          ref: refOf(before, 'Tab A'),
        })
        const after = env.driver.snapshot(target.targetId)!
        check(after.generation === generation, 'generation kept')
        check(after.revision > before.revision, 'revision bumped')
        check(after.url.endsWith('#a'), `route changed (${after.url})`)
      }),
  },
  {
    name: 'wait resolves on a condition and reports a timeout without throwing',
    run: async (env) =>
      await withTarget(env, '/slow', async (target) => {
        const snapshot = env.driver.snapshot(target.targetId)!
        const ready = await env.driver.wait(
          {
            targetId: target.targetId,
            generation: snapshot.generation,
            condition: { kind: 'element', name: 'Ready', state: 'present' },
            timeoutMs: 5_000,
          },
          signal(),
        )
        check(ready.satisfied, 'the delayed element appeared')
        const never = await env.driver.wait(
          {
            targetId: target.targetId,
            generation: snapshot.generation,
            condition: { kind: 'text', contains: 'this text never appears' },
            timeoutMs: 200,
          },
          signal(),
        )
        check(!never.satisfied, 'a missing condition times out quietly')
      }),
  },
  {
    name: 'same-origin frames are expanded; cross-origin frames are noted',
    run: async (env) =>
      await withTarget(env, '/frames', async (target) => {
        const observation = await observe(env, target)
        const inner = observation.elements.find(
          (element) => element.name === 'Inner button',
        )
        check(inner !== undefined, 'same-origin frame content is observed')
        check(inner.frameId !== undefined, 'frame content carries a frame id')
        if (env.features?.crossOriginFrames !== true)
          check(
            (observation.notes ?? []).some((note) =>
              note.includes('cross-origin'),
            ),
            'an unexpanded cross-origin frame is noted',
          )
        else {
          const foreign = observation.elements.find(
            (element) => element.name === 'Cross-origin button',
          )
          check(foreign !== undefined, 'cross-origin frame content is observed')
          check(
            foreign.frameId !== undefined && foreign.frameId !== inner.frameId,
            'cross-origin content carries its own frame id',
          )
        }
      }),
  },
  {
    name: 'downloads land in the inbox and executables are refused',
    run: async (env) => {
      if (env.driver.download === undefined) return
      await withTarget(env, '/files', async (target) => {
        const observation = await observe(env, target)
        const now = env.driver.snapshot(target.targetId)!
        let dispatched = 0
        const report = await env.driver.download!(
          {
            operationId: 'op-download-1',
            targetId: target.targetId,
            generation: now.generation,
            expectedRevision: observation.revision,
            ref: refOf(observation, 'Download report'),
            taskId: 'contract-task',
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: 10_000,
          },
          { dispatched: () => (dispatched += 1) },
          signal(),
        )
        check(dispatched === 1, 'the click is marked as dispatched once')
        check(
          report.state === 'completed',
          `report downloaded (${report.state}: ${report.reason ?? ''})`,
        )
        check(
          report.filename === 'report.csv',
          `inbox file name (${report.filename})`,
        )
        check(
          report.bytes > 0 && /^[0-9a-f]{64}$/.test(report.sha256 ?? ''),
          'size and SHA-256 recorded',
        )
        const installer = await env.driver.download!(
          {
            operationId: 'op-download-2',
            targetId: target.targetId,
            generation: now.generation,
            expectedRevision: observation.revision,
            ref: refOf(observation, 'Download installer'),
            taskId: 'contract-task',
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: 10_000,
          },
          { dispatched: () => undefined },
          signal(),
        )
        check(
          installer.state === 'refused',
          `installers are refused (${installer.state})`,
        )
      })
    },
  },
  {
    name: 'uploads take files the user picked into a file input only',
    run: async (env) => {
      if (env.driver.upload === undefined) return
      await withTarget(env, '/upload', async (target) => {
        const observation = await observe(env, target)
        const now = env.driver.snapshot(target.targetId)!
        const request = (ref: string) => ({
          operationId: `op-upload-${ref}`,
          targetId: target.targetId,
          generation: now.generation,
          expectedRevision: observation.revision,
          ref,
          origin: null,
        })
        const upload = await env.driver.upload!(
          request(refOf(observation, 'Document')),
          { dispatched: () => undefined },
          signal(),
        )
        check(upload.state === 'attached', `files attached (${upload.state})`)
        check(
          upload.files.length === 1 && upload.bytes > 0,
          'one picked file with a size',
        )
        let refused = false
        try {
          await env.driver.upload!(
            request(refOf(observation, 'Send')),
            { dispatched: () => undefined },
            signal(),
          )
        } catch {
          refused = true
        }
        check(refused, 'a non-file element is refused')
      })
    },
  },
  {
    name: 'shadow DOM content is observable',
    run: async (env) =>
      await withTarget(env, '/shadow', async (target) => {
        const observation = await observe(env, target)
        refOf(observation, 'Shadow button')
      }),
  },
  {
    name: 'popups open as a tab of the same profile when allowed, else are blocked',
    run: async (env) =>
      await withTarget(env, '/popup', async (target) => {
        const events: DriverEvent[] = []
        const unsubscribe = env.driver.subscribe((event) => events.push(event))
        const until = async (type: DriverEvent['type']): Promise<void> => {
          const deadline = Date.now() + 3_000
          while (
            !events.some((event) => event.type === type) &&
            Date.now() < deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        try {
          let observation = await observe(env, target)
          await act(env, target, observation, {
            kind: 'click',
            ref: refOf(observation, 'Open window'),
          })
          await until('popup-opened')
          const opened = events.find((event) => event.type === 'popup-opened')
          check(
            opened?.type === 'popup-opened' &&
              opened.targetId === target.targetId,
            'popup-opened event emitted for the opener',
          )
          check(
            opened.popup.url.endsWith('/done') &&
              opened.popup.profileId === target.profileId,
            'the popup is a tab of the same profile at the popup URL',
          )
          check(
            env.driver
              .list()
              .some((tab) => tab.targetId === opened.popup.targetId),
            'the popup tab is listed',
          )
          await env.driver.close(opened.popup.targetId, 'agent')
          // A page-initiated window the kernel does not allow is blocked.
          env.driver.setNavigationPolicy((request) =>
            request.initiator === 'page' ? 'block' : 'allow',
          )
          observation = await observe(env, target)
          await act(env, target, observation, {
            kind: 'click',
            ref: refOf(observation, 'Open window'),
          })
          await until('popup-blocked')
          check(
            events.some(
              (event) =>
                event.type === 'popup-blocked' &&
                event.targetId === target.targetId,
            ),
            'popup-blocked event emitted',
          )
        } finally {
          env.driver.setNavigationPolicy(() => 'allow')
          unsubscribe()
        }
      }),
  },
  {
    name: 'a paused target rejects actions',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const observation = await observe(env, target)
        env.driver.setPaused(target.targetId, true)
        try {
          await expectCode(
            act(env, target, observation, {
              kind: 'click',
              ref: refOf(observation, 'I agree'),
            }),
            ['TARGET_BUSY', 'USER_TAKEOVER'],
            'paused target',
          )
        } finally {
          env.driver.setPaused(target.targetId, false)
        }
      }),
  },
  {
    name: 'screenshots return image bytes and a model copy only on request',
    run: async (env) =>
      await withTarget(env, '/form', async (target) => {
        const snapshot = env.driver.snapshot(target.targetId)!
        const plain = await env.driver.screenshot(
          {
            targetId: target.targetId,
            generation: snapshot.generation,
            modelCopy: false,
            modelMaxEdge: 1_600,
          },
          signal(),
        )
        check(
          plain.png.byteLength > 0 && plain.width > 0 && plain.height > 0,
          'audit image',
        )
        check(plain.model === undefined, 'no model copy unless asked')
        const withModel = await env.driver.screenshot(
          {
            targetId: target.targetId,
            generation: snapshot.generation,
            modelCopy: true,
            modelMaxEdge: 1_600,
          },
          signal(),
        )
        check(withModel.model !== undefined, 'model copy produced')
        check(
          Math.max(withModel.model.width, withModel.model.height) <= 1_600,
          'model copy respects the long-edge cap',
        )
      }),
  },
  {
    name: 'closing ends the target',
    run: async (env) => {
      const target = await open(env, '/form')
      await env.driver.close(target.targetId, 'agent')
      check(
        env.driver.snapshot(target.targetId) === null,
        'no snapshot after close',
      )
      await expectCode(
        env.driver.observe(
          {
            targetId: target.targetId,
            generation: target.generation,
            budget: BUDGET,
            includeText: false,
          },
          signal(),
        ),
        ['STALE_TARGET', 'INVALID_REQUEST', 'DRIVER_UNAVAILABLE'],
        'observe after close',
      )
    },
  },
]
