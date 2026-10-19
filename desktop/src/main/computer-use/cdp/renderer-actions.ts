/**
 * Page-level input shared by every CDP-driven renderer: Emperor's own Agent
 * tabs and Electron apps driven through a debugging pipe. Each action takes a
 * ref target the driver has already resolved against its latest observation;
 * resolving refs and reporting the outcome stay with the driver that owns the
 * page. Input goes through the CDP Input domain, so it reaches the renderer
 * whether or not its window is focused.
 */

import type { ActHooks } from '@emperor/core/host-capabilities'
import { UiError } from '@emperor/core/host-capabilities'
import type { IsolatedWorlds } from './isolated'
import { parseKey, type KeyStroke } from './key-map'
import type { CdpSession } from './session'
import type { RefTarget } from './snapshot'

export interface RendererPage {
  readonly cdp: CdpSession
  readonly worlds: IsolatedWorlds
  /** The main frame, for page-level scrolling and focus checks. */
  readonly mainFrameId: string | null
  /** How long one keyboard action may take in all (default 5 s). */
  readonly inputTimeoutMs?: number
  /**
   * A keyboard action ran out of time: the driver drops this page's CDP
   * session and attaches a new one (SEC-10).
   */
  onInputTimeout?(): void
}

/** Total time for one keyboard action: focus, checks and every insert. */
export const INPUT_TIMEOUT_MS = 5_000

export interface FieldState {
  secret: boolean
  editable: boolean
  disabled: boolean
  readOnly: boolean
  value: string | null
}

/**
 * Where an action lands on the page, for the Agent's pointer on the
 * conversation preview: viewport CSS pixels, and the viewport's size.
 */
export interface LandingPoint {
  readonly x: number
  readonly y: number
  readonly viewport: { readonly width: number; readonly height: number }
}

/**
 * `ActHooks`; `landed` hears where a click, fill, choice or element scroll
 * lands, right after `dispatched`. Only for the page itself: a cross-origin
 * frame works in its own coordinates.
 */
export interface RendererActHooks extends ActHooks {
  landed?(point: LandingPoint): void
}

interface LayoutMetrics {
  cssVisualViewport?: {
    pageX: number
    pageY: number
    clientWidth?: number
    clientHeight?: number
  }
}

/** Area of a CDP quad (x1,y1 … x4,y4). */
export function quadArea(quad: readonly number[]): number {
  let area = 0
  for (let index = 0; index < 4; index += 1) {
    const x1 = quad[index * 2]!
    const y1 = quad[index * 2 + 1]!
    const x2 = quad[((index + 1) % 4) * 2]!
    const y2 = quad[((index + 1) % 4) * 2 + 1]!
    area += (x1 * y2 - x2 * y1) / 2
  }
  return Math.abs(area)
}

function quadCentre(quad: readonly number[]): { x: number; y: number } {
  return {
    x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
    y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
  }
}

function viewportOf(metrics: LayoutMetrics): LandingPoint['viewport'] | null {
  const width = metrics.cssVisualViewport?.clientWidth ?? 0
  const height = metrics.cssVisualViewport?.clientHeight ?? 0
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The centre of a ref of the page itself, for `hooks.landed`: null when
 * nobody listens, for a cross-origin frame, or when the page cannot say.
 * Measuring never fails the action (an abort still stops it).
 */
async function landingOf(
  page: RendererPage,
  target: RefTarget,
  hooks: RendererActHooks,
  signal: AbortSignal,
): Promise<LandingPoint | null> {
  if (hooks.landed === undefined || target.sessionId !== undefined) return null
  try {
    const { quads } = await page.cdp.send<{ quads: number[][] }>(
      'DOM.getContentQuads',
      { backendNodeId: target.backendNodeId },
      { signal },
    )
    const quad = quads.find((item) => quadArea(item) > 1)
    if (quad === undefined) return null
    const viewport = viewportOf(
      await page.cdp.send<LayoutMetrics>(
        'Page.getLayoutMetrics',
        {},
        { signal },
      ),
    )
    return viewport === null ? null : { ...quadCentre(quad), viewport }
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
}

/**
 * Keyboard input into a cross-origin frame hangs Electron's main thread
 * in offscreen tabs (E-B3), so it is refused until a safe path is proven.
 */
export function assertTypable(target: RefTarget): void {
  if (target.sessionId !== undefined)
    throw new UiError(
      'CAPABILITY_DISABLED',
      'typing into a cross-origin frame is not available yet',
      {
        reason: 'cross-origin-frame-input',
        // E-B3: input does not reach such frames in this view.
        hint: 'Ask the user with ask_user_question to do this step in their own browser.',
      },
    )
}

/**
 * The focus is (or was moved by the page) inside a cross-origin frame:
 * nothing is typed (SEC-10, MAIN-8). Text there would hang Electron (E-B3).
 */
function focusInCrossOriginFrame(): UiError {
  return new UiError(
    'CAPABILITY_DISABLED',
    'the focus is inside a cross-origin frame (the page may have moved it there); nothing was typed',
    {
      reason: 'FOCUS_IN_CROSS_ORIGIN_FRAME',
      hint: 'Observe again and click a field of the page itself, or ask the user with ask_user_question to do this step in their own browser.',
    },
  )
}

/**
 * The input guard of one keyboard action (SEC-10, MAIN-8). Where keys go is
 * asked in the page itself, in the same call that focuses the field, so the
 * page's focus handlers have already run; frames the page cannot read are
 * fenced (made inert) while it types, and asked again before every insert
 * or key. A same-origin frame's field is focused there and then checked
 * from the page frame, which decides where keys go.
 */
export class KeyboardGuard {
  private readonly fenced = new Set<string>()

  constructor(
    private readonly page: RendererPage,
    private readonly signal: AbortSignal,
  ) {}

  private get mainFrame(): string {
    return this.page.mainFrameId ?? ''
  }

  /** Focus a field (selecting its text) and check where keys went. */
  async focus(target: RefTarget, selectAll: boolean): Promise<void> {
    const result = await this.page.worlds.callOnElement<{
      focused: boolean
      frame: boolean
    }>(
      target.frameId,
      target.backendNodeId,
      'focusForInput',
      [selectAll],
      this.signal,
    )
    if (result.frame) throw focusInCrossOriginFrame()
    this.fenced.add(target.frameId)
    if (target.frameId !== this.mainFrame) await this.check()
  }

  /** Right before an insert or a key: the focus is still in the page. */
  async check(): Promise<void> {
    const result = await this.page.worlds.callInFrame<{ frame: boolean }>(
      this.mainFrame,
      'inputFocus',
      [],
      this.signal,
    )
    if (result.frame) throw focusInCrossOriginFrame()
    this.fenced.add(this.mainFrame)
  }

  /** Lift the fence, page frame first; never fails the action. */
  async release(): Promise<void> {
    const frames = [...this.fenced].sort((a, b) =>
      a === this.mainFrame ? -1 : b === this.mainFrame ? 1 : 0,
    )
    for (const frameId of frames)
      await this.page.worlds
        .callInFrame(
          frameId,
          'releaseInputFence',
          [],
          AbortSignal.timeout(2_000),
        )
        .catch(() => undefined)
  }
}

/**
 * Run one keyboard action under its guard and a total deadline
 * (`INPUT_TIMEOUT_MS`). Past the deadline every pending CDP command is
 * aborted, the page's CDP session is rebuilt (`onInputTimeout`) and the
 * action reports OUTCOME_UNKNOWN: part of the text may have arrived.
 */
export async function withKeyboard<T>(
  page: RendererPage,
  signal: AbortSignal,
  body: (keys: KeyboardGuard, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const limit = page.inputTimeoutMs ?? INPUT_TIMEOUT_MS
  const controller = new AbortController()
  const forward = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', forward, { once: true })
  let timedOut = false
  let rebuilt = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, limit)
  const keys = new KeyboardGuard(page, controller.signal)
  try {
    return await body(keys, controller.signal)
  } catch (error) {
    if (!timedOut) throw error
    rebuilt = true
    page.onInputTimeout?.()
    throw new UiError(
      'OUTCOME_UNKNOWN',
      `typing did not finish within ${limit / 1000} s; the tab's debugger connection was rebuilt`,
      {
        reason: 'input-timeout',
        hint: 'Observe the page before typing again: part of the text may have arrived.',
        cause: error,
      },
    )
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forward)
    // A rebuilt session lifts the fence itself.
    if (!rebuilt) await keys.release()
  }
}

export async function fieldState(
  page: RendererPage,
  target: RefTarget,
  signal: AbortSignal,
): Promise<FieldState> {
  return await page.worlds.callOnElement(
    target.frameId,
    target.backendNodeId,
    'fieldState',
    [],
    signal,
  )
}

/** One key stroke with its modifiers; a modifier is never left held (00 §12). */
export async function pressStroke(
  cdp: CdpSession,
  stroke: KeyStroke,
  signal: AbortSignal,
): Promise<void> {
  const options = { signal }
  const down: KeyStroke[] = []
  try {
    for (const modifier of stroke.modifierKeys) {
      await cdp.send(
        'Input.dispatchKeyEvent',
        {
          type: 'rawKeyDown',
          key: modifier.key,
          code: modifier.code,
          windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
          modifiers: modifier.modifiers,
        },
        options,
      )
      down.unshift(modifier)
    }
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: stroke.text === undefined ? 'rawKeyDown' : 'keyDown',
        key: stroke.key,
        code: stroke.code,
        windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
        modifiers: stroke.modifiers,
        ...(stroke.text === undefined
          ? {}
          : { text: stroke.text, unmodifiedText: stroke.text }),
      },
      options,
    )
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: stroke.key,
        code: stroke.code,
        windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
        modifiers: stroke.modifiers,
      },
      options,
    )
  } finally {
    for (const modifier of down) {
      await cdp
        .send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: modifier.key,
          code: modifier.code,
          windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
        })
        .catch(() => undefined)
    }
  }
}

/**
 * Click the centre of a ref after a hit test: the point must land on the
 * target (not an overlay covering it) before anything is dispatched.
 * Cross-origin frames are hit-tested and clicked on their own session in
 * frame-local coordinates (E-B3: page-level input never reaches them).
 */
export async function clickTarget(
  page: RendererPage,
  target: RefTarget,
  ref: string,
  options: { button?: 'left' | 'right' | 'middle'; count?: 1 | 2 },
  hooks: RendererActHooks,
  signal: AbortSignal,
): Promise<string[]> {
  const { cdp } = page
  const send = {
    signal,
    ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
  }
  try {
    await cdp.send(
      'DOM.scrollIntoViewIfNeeded',
      { backendNodeId: target.backendNodeId },
      send,
    )
  } catch {
    // not scrollable or detached: the box model check below decides
  }
  // Content quads are viewport-relative (what input events use).
  let quads: number[][]
  try {
    quads = (
      await cdp.send<{ quads: number[][] }>(
        'DOM.getContentQuads',
        { backendNodeId: target.backendNodeId },
        send,
      )
    ).quads
  } catch {
    throw new UiError(
      'STALE_ELEMENT',
      `${ref} is not rendered (hidden or removed)`,
    )
  }
  const quad = quads.find((item) => quadArea(item) > 1)
  if (quad === undefined)
    throw new UiError('STALE_ELEMENT', `${ref} has no clickable area`)
  const { x, y } = quadCentre(quad)
  // getNodeForLocation takes document coordinates: add the scroll offset.
  const metrics = await cdp
    .send<LayoutMetrics>('Page.getLayoutMetrics', {}, send)
    .catch(() => ({}) as LayoutMetrics)
  const pageX = metrics.cssVisualViewport?.pageX ?? 0
  const pageY = metrics.cssVisualViewport?.pageY ?? 0
  const hit = await cdp
    .send<{ backendNodeId?: number; frameId?: string }>(
      'DOM.getNodeForLocation',
      {
        x: Math.round(x + pageX),
        y: Math.round(y + pageY),
        includeUserAgentShadowDOM: true,
      },
      send,
    )
    .catch(() => ({}) as { backendNodeId?: number; frameId?: string })
  const hitId = hit.backendNodeId
  const onTarget =
    hitId !== undefined &&
    (await page.worlds
      .contains(target.frameId, target.backendNodeId, hitId, signal)
      .catch(() => false))
  if (!onTarget)
    throw new UiError(
      'STALE_ELEMENT',
      `${ref} is covered by another element at its position; observe again`,
      { reason: 'obscured' },
    )
  const button = options.button ?? 'left'
  const clickCount = options.count ?? 1
  const viewport = target.sessionId === undefined ? viewportOf(metrics) : null
  hooks.dispatched()
  if (viewport !== null) hooks.landed?.({ x, y, viewport })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, send)
  for (let n = 1; n <= clickCount; n += 1) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, clickCount: n },
      send,
    )
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, clickCount: n },
      send,
    )
  }
  return [`clicked ${target.name || ref}`]
}

/** Replace a text field's value; secret fields are refused before any input. */
export async function fillTarget(
  page: RendererPage,
  target: RefTarget,
  ref: string,
  text: string,
  hooks: RendererActHooks,
  signal: AbortSignal,
): Promise<{ changes: string[]; warnings: string[] }> {
  assertTypable(target)
  const field = await fieldState(page, target, signal)
  if (field.secret)
    throw new UiError(
      'PERMISSION_DENIED',
      'secret fields cannot be filled with text',
      {
        reason: 'secret-field',
        // The user cannot type into a built-in browser tab (no takeover).
        hint: 'Fill a saved credential with browser_fill_credential. Without one, ask the user with ask_user_question to save it in Settings › 浏览器 › 密码管理器, or to do this step in their own browser.',
      },
    )
  if (!field.editable)
    throw new UiError('INVALID_REQUEST', `${ref} is not a text field`)
  if (field.disabled || field.readOnly)
    throw new UiError('INVALID_REQUEST', `${ref} is disabled or read-only`)
  return await withKeyboard(page, signal, async (keys, inputSignal) => {
    await keys.focus(target, true)
    // Measured after focusing, which scrolls the field into view.
    const landing = await landingOf(page, target, hooks, inputSignal)
    hooks.dispatched()
    if (landing !== null) hooks.landed?.(landing)
    await keys.check()
    if (text === '')
      await pressStroke(page.cdp, parseKey('Delete'), inputSignal)
    else
      await page.cdp.send('Input.insertText', { text }, { signal: inputSignal })
    const after = await fieldState(page, target, inputSignal)
    return {
      changes: [`${target.name || ref} filled (${text.length} chars)`],
      warnings:
        after.value === text
          ? []
          : [
              'the field shows a different value after filling (the page may reformat input)',
            ],
    }
  })
}

/** Type into a ref (or the focused element); a line break is Enter. */
export async function typeText(
  page: RendererPage,
  target: RefTarget | undefined,
  text: string,
  hooks: ActHooks,
  signal: AbortSignal,
): Promise<string[]> {
  if (target !== undefined) {
    assertTypable(target)
    const field = await fieldState(page, target, signal)
    if (field.secret)
      throw new UiError(
        'PERMISSION_DENIED',
        'secret fields cannot be typed into',
        { reason: 'secret-field' },
      )
  }
  return await withKeyboard(page, signal, async (keys, inputSignal) => {
    if (target !== undefined) await keys.focus(target, false)
    else await keys.check()
    hooks.dispatched()
    for (const part of text.split(/(\n)/)) {
      if (part === '') continue
      await keys.check()
      if (part === '\n')
        await pressStroke(page.cdp, parseKey('Enter'), inputSignal)
      else
        await page.cdp.send(
          'Input.insertText',
          { text: part },
          { signal: inputSignal },
        )
    }
    return [`typed ${text.length} chars`]
  })
}

/** A key name as a stroke; an unknown name is the caller's mistake. */
export function strokeFor(key: string): KeyStroke {
  try {
    return parseKey(key)
  } catch (error) {
    throw new UiError(
      'INVALID_REQUEST',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Press a key on a ref (focused first) or on the focused element. Parse the
 * key with `strokeFor` before resolving the ref, so a bad key name is
 * reported ahead of a stale ref.
 */
export async function pressKey(
  page: RendererPage,
  target: RefTarget | undefined,
  stroke: KeyStroke,
  key: string,
  hooks: ActHooks,
  signal: AbortSignal,
): Promise<string[]> {
  if (target !== undefined) assertTypable(target)
  return await withKeyboard(page, signal, async (keys, inputSignal) => {
    if (target !== undefined) await keys.focus(target, false)
    else await keys.check()
    hooks.dispatched()
    await keys.check()
    await pressStroke(page.cdp, stroke, inputSignal)
    return [`pressed ${key}`]
  })
}

/** Choose a drop-down option by its label. */
export async function selectOption(
  page: RendererPage,
  target: RefTarget,
  ref: string,
  option: string,
  hooks: RendererActHooks,
  signal: AbortSignal,
): Promise<string[]> {
  if (!target.select)
    throw new UiError(
      'INVALID_REQUEST',
      `${ref} is not a drop-down list; click it instead`,
    )
  const landing = await landingOf(page, target, hooks, signal)
  hooks.dispatched()
  if (landing !== null) hooks.landed?.(landing)
  const result = await page.worlds.callOnElement<{
    ok: boolean
    reason?: string
    value?: string
    options?: string[]
  }>(target.frameId, target.backendNodeId, 'selectOption', [option], signal)
  if (!result.ok)
    throw new UiError(
      'INVALID_REQUEST',
      result.reason === 'no-such-option'
        ? `no option "${option}"; options: ${(result.options ?? []).join(', ')}`
        : `cannot select: ${result.reason ?? 'unknown'}`,
    )
  return [`${target.name || ref} = ${result.value ?? option}`]
}

/**
 * Scroll a ref or the page; `moved` is false at an edge. Only a ref has a
 * point to show where the scroll lands.
 */
export async function scrollIn(
  page: RendererPage,
  target: RefTarget | undefined,
  scroll: {
    direction: 'up' | 'down' | 'left' | 'right'
    amount: number
    unit: 'page' | 'line'
  },
  hooks: RendererActHooks,
  signal: AbortSignal,
): Promise<boolean> {
  const dx =
    scroll.direction === 'left'
      ? -scroll.amount
      : scroll.direction === 'right'
        ? scroll.amount
        : 0
  const dy =
    scroll.direction === 'up'
      ? -scroll.amount
      : scroll.direction === 'down'
        ? scroll.amount
        : 0
  const landing =
    target === undefined ? null : await landingOf(page, target, hooks, signal)
  hooks.dispatched()
  if (landing !== null) hooks.landed?.(landing)
  const moved: { moved: boolean } =
    target !== undefined
      ? await page.worlds.callOnElement(
          target.frameId,
          target.backendNodeId,
          'scrollBy',
          [dx, dy, scroll.unit],
          signal,
        )
      : await page.worlds.callInFrame(
          page.mainFrameId ?? '',
          'scrollPage',
          [dx, dy, scroll.unit],
          signal,
        )
  return moved.moved
}
