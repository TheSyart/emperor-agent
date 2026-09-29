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
  /** Cross-origin (OOPIF) frames are attached to this page. */
  readonly crossOriginFrames: boolean
}

export interface FieldState {
  secret: boolean
  editable: boolean
  disabled: boolean
  readOnly: boolean
  value: string | null
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
        // E-B3: takeover input does not reach such frames in this view.
        hint: 'Ask the user to type it in their own browser; takeover in the Agent tab cannot reach this frame either.',
      },
    )
}

/** Keys without a ref go to the focused element: refuse if that is an OOPIF. */
export async function assertFocusInPage(
  page: RendererPage,
  signal: AbortSignal,
): Promise<void> {
  if (!page.crossOriginFrames) return
  const inFrame = await page.worlds
    .callInFrame<boolean>(page.mainFrameId ?? '', 'activeIsFrame', [], signal)
    .catch(() => true)
  if (inFrame)
    throw new UiError(
      'CAPABILITY_DISABLED',
      'the focus is inside a cross-origin frame; typing there is not available yet',
      {
        reason: 'cross-origin-frame-input',
        hint: 'Click a field of the page itself first, or ask the user to type it in their own browser.',
      },
    )
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
  hooks: ActHooks,
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
  const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
  const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
  // getNodeForLocation takes document coordinates: add the scroll offset.
  const metrics = await cdp
    .send<{ cssVisualViewport?: { pageX: number; pageY: number } }>(
      'Page.getLayoutMetrics',
      {},
      send,
    )
    .catch(
      () => ({}) as { cssVisualViewport?: { pageX: number; pageY: number } },
    )
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
  hooks.dispatched()
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
  hooks: ActHooks,
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
        hint: 'Ask the user to take over and type it themselves.',
      },
    )
  if (!field.editable)
    throw new UiError('INVALID_REQUEST', `${ref} is not a text field`)
  if (field.disabled || field.readOnly)
    throw new UiError('INVALID_REQUEST', `${ref} is disabled or read-only`)
  await page.worlds.callOnElement(
    target.frameId,
    target.backendNodeId,
    'focusAndSelectAll',
    [],
    signal,
  )
  hooks.dispatched()
  if (text === '') await pressStroke(page.cdp, parseKey('Delete'), signal)
  else await page.cdp.send('Input.insertText', { text }, { signal })
  const after = await fieldState(page, target, signal)
  return {
    changes: [`${target.name || ref} filled (${text.length} chars)`],
    warnings:
      after.value === text
        ? []
        : [
            'the field shows a different value after filling (the page may reformat input)',
          ],
  }
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
    await page.worlds.callOnElement(
      target.frameId,
      target.backendNodeId,
      'focus',
      [],
      signal,
    )
  } else await assertFocusInPage(page, signal)
  hooks.dispatched()
  for (const part of text.split(/(\n)/)) {
    if (part === '') continue
    if (part === '\n') await pressStroke(page.cdp, parseKey('Enter'), signal)
    else await page.cdp.send('Input.insertText', { text: part }, { signal })
  }
  return [`typed ${text.length} chars`]
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
  if (target !== undefined) {
    assertTypable(target)
    await page.worlds.callOnElement(
      target.frameId,
      target.backendNodeId,
      'focus',
      [],
      signal,
    )
  } else await assertFocusInPage(page, signal)
  hooks.dispatched()
  await pressStroke(page.cdp, stroke, signal)
  return [`pressed ${key}`]
}

/** Choose a drop-down option by its label. */
export async function selectOption(
  page: RendererPage,
  target: RefTarget,
  ref: string,
  option: string,
  hooks: ActHooks,
  signal: AbortSignal,
): Promise<string[]> {
  if (!target.select)
    throw new UiError(
      'INVALID_REQUEST',
      `${ref} is not a drop-down list; click it instead`,
    )
  hooks.dispatched()
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

/** Scroll a ref or the page; `moved` is false at an edge. */
export async function scrollIn(
  page: RendererPage,
  target: RefTarget | undefined,
  scroll: {
    direction: 'up' | 'down' | 'left' | 'right'
    amount: number
    unit: 'page' | 'line'
  },
  hooks: ActHooks,
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
  hooks.dispatched()
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
