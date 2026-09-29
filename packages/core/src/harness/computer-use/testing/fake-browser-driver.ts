/**
 * In-memory `BrowserDriver` for kernel tests and the driver contract suite.
 * It models pages from {@link FIXTURE_PAGES}, element refs per revision
 * (the last 3 revisions are kept, §5.2), redaction, budgets and cursors,
 * navigation epochs, the navigation policy, and fault injection around the
 * `dispatched` boundary.
 */

import { createHash, randomUUID } from 'node:crypto'
import { isExecutableDownload, safeDownloadName } from '../downloads'
import { UiError } from '../errors'
import type {
  ActHooks,
  ActOutcome,
  ActRequest,
  BrowserDriver,
  BrowserProfileSpec,
  DriverEvent,
  DriverEventListener,
  DriverObservation,
  NavigationPolicy,
  ObserveRequest,
  ScreenshotCapture,
  ScreenshotRequest,
  TargetCloseReason,
  TargetSnapshot,
  WaitOutcome,
  WaitRequest,
  DownloadRequest,
  UploadRequest,
  CredentialFillRequest,
} from '../port'
import type {
  DriverCapability,
  HistoryDirection,
  UiAction,
  UiElement,
  DownloadRecord,
  UploadRecord,
  CredentialField,
  CredentialFillOutcome,
} from '../types'
import {
  FIXTURE_ORIGIN,
  FIXTURE_PAGES,
  type FixtureElement,
  type FixturePage,
} from './fixture-pages'

/** A valid 1×1 PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

export interface FakeFaults {
  /** Throw this code before `dispatched()` on the next act. */
  failBeforeDispatch?: UiError['code']
  /** Throw after `dispatched()` on the next act. */
  failAfterDispatch?: boolean
  /** Throw this driver error after `dispatched()` on the next act. */
  failAfterDispatchWith?: UiError
  /** Never settle the next act until aborted. */
  hangAfterDispatch?: boolean
}

interface FakeTarget {
  readonly targetId: string
  readonly profileId: string
  url: string
  history: string[]
  index: number
  generation: number
  revision: number
  paused: boolean
  closed: boolean
  openedAt: number
  readonly values: Map<string, string>
  /** revision → ref → element id */
  readonly refs: Map<number, Map<string, string>>
  /** revision → element id → value snapshot (for diffs) */
  readonly snapshots: Map<number, Map<string, string>>
}

const KEPT_REVISIONS = 3

function pageOf(url: string): FixturePage | undefined {
  try {
    const parsed = new URL(url)
    return FIXTURE_PAGES[parsed.pathname]
  } catch {
    return undefined
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new UiError('TIMEOUT_NO_EFFECT', 'aborted')
}

export class FakeBrowserDriver implements BrowserDriver {
  readonly driver = 'embedded-browser' as const
  private readonly targets = new Map<string, FakeTarget>()
  private readonly listeners = new Set<DriverEventListener>()
  private policy: NavigationPolicy = () => 'allow'
  faults: FakeFaults = {}
  /** Operation ids of every act that reached dispatch. */
  readonly dispatchedOps: string[] = []
  available = true

  constructor(private readonly origin = FIXTURE_ORIGIN) {}

  url(path: string): string {
    return new URL(path, this.origin).toString()
  }

  capability(): DriverCapability {
    return {
      driver: 'embedded-browser',
      platform: 'macos',
      stage: 'experimental',
      label: '内置浏览器（测试）',
      enabled: true,
      available: this.available,
      actions: [
        'click',
        'fill',
        'typeText',
        'press',
        'select',
        'scroll',
        'navigate',
        'history',
      ],
      missing: [],
    }
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setNavigationPolicy(policy: NavigationPolicy): void {
    this.policy = policy
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private target(targetId: string, generation?: number): FakeTarget {
    const target = this.targets.get(targetId)
    if (target === undefined || target.closed)
      throw new UiError('STALE_TARGET', `target ${targetId} is gone`)
    if (generation !== undefined && generation !== target.generation)
      throw new UiError(
        'STALE_TARGET',
        'the target navigated since the request was made',
      )
    return target
  }

  snapshotOf(target: FakeTarget): TargetSnapshot {
    return {
      targetId: target.targetId,
      kind: 'embedded-tab',
      driver: 'embedded-browser',
      generation: target.generation,
      revision: target.revision,
      url: target.url,
      title: pageOf(target.url)?.title ?? '',
      loading: false,
      profileId: target.profileId,
    }
  }

  snapshot(targetId: string): TargetSnapshot | null {
    const target = this.targets.get(targetId)
    return target === undefined || target.closed
      ? null
      : this.snapshotOf(target)
  }

  list(): TargetSnapshot[] {
    return [...this.targets.values()]
      .filter((target) => !target.closed)
      .map((target) => this.snapshotOf(target))
  }

  async open(
    request: {
      profile: BrowserProfileSpec
      url: string
      ownerSessionId: string
    },
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    checkAbort(signal)
    if (!/^https?:\/\//.test(request.url))
      throw new UiError('INVALID_REQUEST', 'only http(s) URLs can be opened')
    const target = this.blankTarget(
      request.url,
      request.profile.kind === 'temporary'
        ? 'temporary'
        : request.profile.profileId,
    )
    this.targets.set(target.targetId, target)
    return this.snapshotOf(target)
  }

  private blankTarget(url: string, profileId: string): FakeTarget {
    return {
      targetId: `tab_${randomUUID()}`,
      profileId,
      url,
      history: [url],
      index: 0,
      generation: 1,
      revision: 0,
      paused: false,
      closed: false,
      openedAt: Date.now(),
      values: new Map(),
      refs: new Map(),
      snapshots: new Map(),
    }
  }

  async close(targetId: string, _reason: TargetCloseReason): Promise<void> {
    const target = this.targets.get(targetId)
    if (target !== undefined) target.closed = true
  }

  readonly downloads: DownloadRecord[] = []

  async download(
    request: DownloadRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<DownloadRecord> {
    checkAbort(signal)
    const target = this.target(request.targetId, request.generation)
    if (target.paused) throw new UiError('TARGET_BUSY', 'the target is paused')
    let url = request.url
    if (request.ref !== undefined) {
      const element = this.element(
        target,
        request.ref,
        request.expectedRevision,
      )
      if (element.download === undefined)
        throw new UiError(
          'INVALID_REQUEST',
          `${request.ref} does not download a file`,
        )
      url = this.url(element.download)
    }
    if (url === undefined || !/^https?:\/\//.test(url))
      throw new UiError('INVALID_REQUEST', 'only http(s) downloads')
    hooks.dispatched()
    const filename = safeDownloadName(new URL(url).pathname)
    const base = {
      downloadId: `dl_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      filename,
      url,
      origin: new URL(url).origin,
    }
    const record: DownloadRecord = isExecutableDownload(filename)
      ? {
          ...base,
          state: 'refused',
          bytes: 0,
          reason: 'executable files are not downloaded',
        }
      : {
          ...base,
          state: 'completed',
          mimeType: 'text/csv',
          bytes: 42,
          sha256: createHash('sha256').update(`fake:${url}`).digest('hex'),
        }
    this.downloads.push(record)
    return record
  }

  /** The host vault's decryption, wired by FakeComputerUsePort. */
  reveal:
    ((handleId: string, field: CredentialField) => string | undefined) | null =
    null

  async fillCredential(
    request: CredentialFillRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<CredentialFillOutcome> {
    checkAbort(signal)
    const target = this.target(request.targetId, request.generation)
    if (target.paused) throw new UiError('TARGET_BUSY', 'the target is paused')
    if (new URL(target.url).origin !== request.origin)
      throw new UiError(
        'PERMISSION_DENIED',
        'the page moved to another origin',
        {
          reason: 'credential-binding-mismatch',
        },
      )
    const element = this.element(target, request.ref, request.expectedRevision)
    const kind = element.sensitive
    const fits =
      request.field === 'password'
        ? kind === 'password'
        : request.field === 'totp'
          ? kind === 'one-time-code' ||
            (kind === undefined && element.role === 'textbox')
          : kind === undefined && element.role === 'textbox'
    if (!fits)
      throw new UiError(
        'INVALID_REQUEST',
        `${request.ref} is not a ${request.field} field`,
      )
    const secret = this.reveal?.(request.handleId, request.field)
    if (secret === undefined)
      throw new UiError('INVALID_REQUEST', 'the vault has no such value')
    hooks.dispatched()
    target.values.set(element.id, secret)
    return { filled: true, bindingMatched: request.origin }
  }

  /** What the fake user picks in the file dialog (null: cancels). */
  pickedFiles: Array<{ name: string; bytes: number }> | null = [
    { name: 'notes.txt', bytes: 12 },
  ]

  async upload(
    request: UploadRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<UploadRecord> {
    checkAbort(signal)
    const target = this.target(request.targetId, request.generation)
    if (target.paused) throw new UiError('TARGET_BUSY', 'the target is paused')
    const element = this.element(target, request.ref, request.expectedRevision)
    if (element.file !== true)
      throw new UiError('INVALID_REQUEST', `${request.ref} is not a file input`)
    const picked = this.pickedFiles
    if (picked === null) return { state: 'cancelled', files: [], bytes: 0 }
    hooks.dispatched()
    return {
      state: 'attached',
      files: picked.map((file) => file.name),
      bytes: picked.reduce((sum, file) => sum + file.bytes, 0),
    }
  }

  /** Profiles whose storage was wiped (`remove`: directory deleted too). */
  readonly clearedProfiles: Array<{ profileId: string; remove: boolean }> = []

  async clearProfile(
    profileId: string,
    options: { readonly remove: boolean },
  ): Promise<void> {
    if (
      [...this.targets.values()].some(
        (target) => !target.closed && target.profileId === profileId,
      )
    )
      throw new UiError('TARGET_BUSY', 'close the profile tabs first')
    this.clearedProfiles.push({ profileId, remove: options.remove })
  }

  /** Simulate a renderer crash. */
  crash(targetId: string): void {
    const target = this.targets.get(targetId)
    if (target === undefined) return
    target.closed = true
    this.emit({ type: 'lost', targetId, reason: 'render-process-gone' })
  }

  /** Simulate DevTools taking the debugger. */
  detach(targetId: string): void {
    this.emit({ type: 'detached', targetId, reason: 'target closed' })
  }

  setPaused(targetId: string, paused: boolean): void {
    const target = this.targets.get(targetId)
    if (target !== undefined) target.paused = paused
  }

  historyTarget(targetId: string, direction: HistoryDirection): string | null {
    const target = this.targets.get(targetId)
    if (target === undefined) return null
    const index =
      direction === 'back'
        ? target.index - 1
        : direction === 'forward'
          ? target.index + 1
          : target.index
    return target.history[index] ?? null
  }

  private elements(target: FakeTarget): FixtureElement[] {
    const page = pageOf(target.url)
    if (page === undefined) return []
    const delayed =
      page.delayedElements !== undefined &&
      Date.now() - target.openedAt >= page.delayedElements.afterMs
        ? page.delayedElements.elements
        : []
    return [...page.elements, ...delayed]
  }

  private valueOf(target: FakeTarget, element: FixtureElement): string {
    return target.values.get(element.id) ?? element.value ?? ''
  }

  async observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<DriverObservation> {
    checkAbort(signal)
    const target = this.target(request.targetId, request.generation)
    const page = pageOf(target.url)
    let offset = 0
    let revision = target.revision
    if (request.cursor !== undefined) {
      const match = /^c(\d+):(\d+)$/.exec(request.cursor)
      if (match === null || Number(match[1]) !== target.revision)
        throw new UiError(
          'STALE_TARGET',
          'the cursor belongs to an older revision',
        )
      offset = Number(match[2])
    } else {
      target.revision += 1
      revision = target.revision
    }
    let all = this.elements(target)
    if (request.query?.role !== undefined)
      all = all.filter((element) => element.role === request.query?.role)
    if (request.query?.nameContains !== undefined) {
      const needle = request.query.nameContains.toLowerCase()
      all = all.filter((element) => element.name.toLowerCase().includes(needle))
    }
    if (request.query?.frameId !== undefined)
      all = all.filter((element) => element.frameId === request.query?.frameId)

    const refs = target.refs.get(revision) ?? new Map<string, string>()
    const values = new Map<string, string>()
    let redactions = 0
    const build = (element: FixtureElement, index: number): UiElement => {
      const ref = `r${revision}.${index + 1}`
      refs.set(ref, element.id)
      const raw = this.valueOf(target, element)
      values.set(element.id, raw)
      let value: string | undefined
      if (element.sensitive !== undefined) {
        redactions += 1
        value = raw === '' ? '' : '[has content]'
      } else if (element.role === 'textbox' || element.role === 'combobox')
        value = raw
      const states: string[] = []
      if (element.disabled === true) states.push('disabled')
      if (element.role === 'checkbox' && raw === 'true') states.push('checked')
      return {
        ref,
        role: element.role,
        nativeRole: element.shadow === true ? 'shadow-button' : element.role,
        name: element.name,
        ...(value === undefined ? {} : { value }),
        ...(states.length === 0 ? {} : { states }),
        bounds: { x: 10, y: 10 + index * 24, width: 120, height: 20 },
        actions: element.role === 'textbox' ? ['focus'] : ['press'],
        ...(element.frameId === undefined ? {} : { frameId: element.frameId }),
        ...(element.frameOrigin === undefined
          ? {}
          : { frameOrigin: element.frameOrigin }),
        ...(element.role === 'textbox'
          ? {
              inputType: element.sensitive === 'password' ? 'password' : 'text',
            }
          : {}),
      }
    }
    const indexed = all.map((element, index) => ({ element, index }))
    const window = indexed.slice(offset, offset + request.budget.maxElements)
    let elements = window.map(({ element, index }) => build(element, index))
    // Also map refs for elements outside the window, so a later cursor page
    // uses the same numbering.
    for (const { element, index } of indexed)
      refs.set(`r${revision}.${index + 1}`, element.id)
    target.refs.set(revision, refs)
    target.snapshots.set(revision, values)
    for (const old of [...target.refs.keys()])
      if (old <= revision - KEPT_REVISIONS) {
        target.refs.delete(old)
        target.snapshots.delete(old)
      }

    let diffFrom: number | undefined
    let removed: string[] | undefined
    const notes = [...(page?.notes ?? [])]
    if (request.diffFrom !== undefined && request.cursor === undefined) {
      const base = target.snapshots.get(request.diffFrom)
      if (base === undefined)
        notes.push('diff base no longer kept; full snapshot returned')
      else {
        diffFrom = request.diffFrom
        elements = elements.filter((element) => {
          const id = refs.get(element.ref)!
          return !base.has(id) || base.get(id) !== values.get(id)
        })
        removed = [...(target.refs.get(request.diffFrom)?.entries() ?? [])]
          .filter(([, id]) => !values.has(id))
          .map(([ref]) => ref)
      }
    }
    const truncated = offset + request.budget.maxElements < indexed.length
    const text = page?.text ?? ''
    return {
      generation: target.generation,
      revision,
      title: page?.title ?? '',
      urlOrApp: target.url,
      focus: true,
      frameOrWindowId: 'main',
      viewport: { width: 1280, height: 800, scale: 2 },
      elements,
      ...(removed === undefined ? {} : { removed }),
      ...(request.includeText
        ? { textExcerpt: text.slice(0, request.budget.maxTextBytes) }
        : {}),
      ...(diffFrom === undefined ? {} : { diffFrom }),
      truncated,
      ...(truncated
        ? { cursor: `c${revision}:${offset + request.budget.maxElements}` }
        : {}),
      redactions,
      ...(notes.length === 0 ? {} : { notes }),
    }
  }

  async screenshot(
    request: ScreenshotRequest,
    signal: AbortSignal,
  ): Promise<ScreenshotCapture> {
    checkAbort(signal)
    const target = this.target(request.targetId, request.generation)
    return {
      screenshotId: `shot_${randomUUID().slice(0, 8)}`,
      generation: target.generation,
      revision: target.revision,
      png: TINY_PNG,
      width: 2560,
      height: 1600,
      scale: 2,
      ...(request.modelCopy
        ? { model: { jpeg: TINY_PNG, width: 1600, height: 1000 } }
        : {}),
    }
  }

  private element(
    target: FakeTarget,
    ref: string,
    expectedRevision: number,
  ): FixtureElement {
    const revision = Number(/^r(\d+)\./.exec(ref)?.[1] ?? -1)
    if (revision !== target.revision || expectedRevision !== target.revision)
      throw new UiError(
        'STALE_ELEMENT',
        `${ref} is from revision ${revision}; the current revision is ${target.revision}`,
      )
    const id = target.refs.get(revision)?.get(ref)
    const element = this.elements(target).find(
      (candidate) => candidate.id === id,
    )
    if (element === undefined)
      throw new UiError('STALE_ELEMENT', `${ref} no longer exists`)
    return element
  }

  private navigate(
    target: FakeTarget,
    url: string,
    initiator: 'agent' | 'page',
    mode: 'push' | 'history' = 'push',
  ): void {
    if (
      this.policy({
        targetId: target.targetId,
        url,
        frame: 'main',
        initiator,
      }) === 'block'
    ) {
      this.emit({ type: 'navigation-blocked', targetId: target.targetId, url })
      if (initiator === 'agent')
        throw new UiError(
          'PERMISSION_REQUIRED',
          `navigation to ${url} needs permission`,
        )
      return
    }
    if (mode === 'push') {
      target.history = [...target.history.slice(0, target.index + 1), url]
      target.index = target.history.length - 1
    }
    target.url = url
    target.generation += 1
    target.revision += 1
    target.openedAt = Date.now()
    this.emit({
      type: 'navigated',
      targetId: target.targetId,
      url,
      generation: target.generation,
      revision: target.revision,
      sameDocument: false,
    })
  }

  async act(
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome> {
    checkAbort(signal)
    const target = this.target(request.targetId, request.generation)
    if (target.paused) throw new UiError('TARGET_BUSY', 'the target is paused')
    const faults = this.faults
    this.faults = {}
    if (faults.failBeforeDispatch !== undefined)
      throw new UiError(
        faults.failBeforeDispatch,
        'injected failure before dispatch',
      )
    const action = request.action
    const resolveElement = (ref: string): FixtureElement =>
      this.element(target, ref, request.expectedRevision)

    // Resolve and validate everything before the side effect.
    let effect: () => ActOutcome
    const unchanged = (changes?: string[]): ActOutcome => ({
      outcome: 'observed',
      afterRevision: target.revision,
      url: target.url,
      ...(changes === undefined ? {} : { changes }),
    })
    switch (action.kind) {
      case 'click': {
        const element = resolveElement(action.ref)
        if (element.disabled === true)
          throw new UiError('STALE_ELEMENT', `${action.ref} is disabled`)
        effect = () => {
          if (element.popup !== undefined) {
            const url = this.url(element.popup)
            const verdict =
              this.policy?.({
                targetId: target.targetId,
                url,
                frame: 'main',
                initiator: 'page',
                profileId: target.profileId,
              }) ?? 'block'
            if (verdict === 'block') {
              this.emit({
                type: 'popup-blocked',
                targetId: target.targetId,
                url,
              })
              return unchanged(['popup blocked'])
            }
            const popup: FakeTarget = {
              ...this.blankTarget(url, target.profileId),
            }
            this.targets.set(popup.targetId, popup)
            this.emit({
              type: 'popup-opened',
              targetId: target.targetId,
              popup: this.snapshotOf(popup),
            })
            return unchanged([`opened a new tab ${popup.targetId}`])
          }
          if (element.pushState !== undefined) {
            const url = this.url(element.pushState)
            target.url = url
            target.revision += 1
            this.emit({
              type: 'navigated',
              targetId: target.targetId,
              url,
              generation: target.generation,
              revision: target.revision,
              sameDocument: true,
            })
            return { outcome: 'observed', afterRevision: target.revision, url }
          }
          if (element.href !== undefined) {
            this.navigate(target, this.url(element.href), 'page')
            return {
              outcome: 'observed',
              afterRevision: target.revision,
              url: target.url,
            }
          }
          if (element.role === 'checkbox') {
            const next =
              this.valueOf(target, element) === 'true' ? 'false' : 'true'
            target.values.set(element.id, next)
            return unchanged([`${element.name} = ${next}`])
          }
          return unchanged()
        }
        break
      }
      case 'fill': {
        const element = resolveElement(action.ref)
        if (element.sensitive !== undefined)
          throw new UiError(
            'PERMISSION_DENIED',
            'secret fields cannot be filled with text',
            {
              reason: 'secret-field',
            },
          )
        if (element.role !== 'textbox' && element.role !== 'searchbox')
          throw new UiError(
            'INVALID_REQUEST',
            `${action.ref} is not a text field`,
          )
        effect = () => {
          target.values.set(element.id, action.text)
          return unchanged([
            `${element.name} filled (${action.text.length} chars)`,
          ])
        }
        break
      }
      case 'select': {
        const element = resolveElement(action.ref)
        if (!(element.options ?? []).includes(action.option))
          throw new UiError('INVALID_REQUEST', `no option "${action.option}"`)
        effect = () => {
          target.values.set(element.id, action.option)
          return unchanged([`${element.name} = ${action.option}`])
        }
        break
      }
      case 'typeText':
      case 'press':
      case 'scroll': {
        if (action.ref !== undefined) resolveElement(action.ref)
        effect = () => unchanged()
        break
      }
      case 'navigate': {
        const url = action.url
        effect = () => {
          this.navigate(target, url, 'agent')
          return {
            outcome: 'observed',
            afterRevision: target.revision,
            url: target.url,
          }
        }
        break
      }
      case 'history': {
        const destination = this.historyTarget(
          target.targetId,
          action.direction,
        )
        if (destination === null)
          return {
            outcome: 'no-effect',
            afterRevision: target.revision,
            url: target.url,
          }
        effect = () => {
          if (action.direction !== 'reload')
            target.index += action.direction === 'back' ? -1 : 1
          this.navigate(target, destination, 'agent', 'history')
          return {
            outcome: 'observed',
            afterRevision: target.revision,
            url: target.url,
          }
        }
        break
      }
      default:
        throw new UiError(
          'CAPABILITY_DISABLED',
          `${action.kind} is not supported by this driver`,
        )
    }
    checkAbort(signal)
    hooks.dispatched()
    this.dispatchedOps.push(request.operationId)
    if (faults.failAfterDispatch === true)
      throw new Error('injected failure after dispatch')
    if (faults.failAfterDispatchWith !== undefined)
      throw faults.failAfterDispatchWith
    if (faults.hangAfterDispatch === true)
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      })
    return effect()
  }

  async wait(request: WaitRequest, signal: AbortSignal): Promise<WaitOutcome> {
    const deadline = Date.now() + request.timeoutMs
    for (;;) {
      checkAbort(signal)
      const target = this.target(request.targetId)
      const condition = request.condition
      const elements = this.elements(target)
      let satisfied = false
      switch (condition.kind) {
        case 'navigation':
          satisfied =
            target.generation !== request.generation &&
            (condition.urlMatches === undefined ||
              target.url.includes(condition.urlMatches))
          break
        case 'element': {
          const found = elements.find(
            (element) =>
              (condition.role === undefined ||
                element.role === condition.role) &&
              (condition.name === undefined ||
                element.name.includes(condition.name)),
          )
          satisfied =
            condition.state === 'absent'
              ? found === undefined
              : condition.state === 'enabled'
                ? found !== undefined && found.disabled !== true
                : found !== undefined
          break
        }
        case 'text':
          satisfied = (pageOf(target.url)?.text ?? '').includes(
            condition.contains,
          )
          break
        case 'idle':
          satisfied = true
          break
        case 'window':
          satisfied = false
          break
      }
      if (satisfied)
        return { satisfied: true, revision: target.revision, url: target.url }
      if (Date.now() >= deadline)
        return {
          satisfied: false,
          revision: target.revision,
          url: target.url,
          detail: 'timed out',
        }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** Test helper: make the current page's action land on a different URL. */
  pageNavigate(targetId: string, path: string): void {
    const target = this.target(targetId)
    this.navigate(target, this.url(path), 'page')
  }

  /**
   * Test helper: the page opens a window by itself (e.g. the user clicked
   * during takeover). Returns the new tab id, or null when it was blocked.
   */
  pageOpenPopup(targetId: string, path: string): string | null {
    const target = this.target(targetId)
    const url = this.url(path)
    const verdict =
      this.policy?.({
        targetId: target.targetId,
        url,
        frame: 'main',
        initiator: 'page',
        profileId: target.profileId,
      }) ?? 'block'
    if (verdict === 'block') {
      this.emit({ type: 'popup-blocked', targetId: target.targetId, url })
      return null
    }
    const popup: FakeTarget = { ...this.blankTarget(url, target.profileId) }
    this.targets.set(popup.targetId, popup)
    this.emit({
      type: 'popup-opened',
      targetId: target.targetId,
      popup: this.snapshotOf(popup),
    })
    return popup.targetId
  }

  /** Test helper: the text value currently stored for an element id. */
  valueFor(targetId: string, elementId: string): string | undefined {
    return this.targets.get(targetId)?.values.get(elementId)
  }
}

/** Exhaustiveness helper for callers building actions. */
export function isSupportedFakeAction(action: UiAction): boolean {
  return (
    action.kind !== 'clickPoint' &&
    action.kind !== 'drag' &&
    action.kind !== 'secondary'
  )
}
