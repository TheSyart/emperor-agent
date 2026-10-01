import { describe, expect, it, vi } from 'vitest'
import type { AgentPreviewPointer } from '../../shared/ipc-contract'
import {
  createPreviewPointerRelay,
  desktopPreviewPointer,
  pagePreviewPointer,
  previewPointerAllowed,
  previewRatio,
  withPreviewPointer,
} from './preview-pointer'

const viewport = { width: 1280, height: 800 }

function target(over: Record<string, string> = {}) {
  return {
    targetId: 't-1',
    driver: 'desktop',
    state: 'attached',
    control: 'agent',
    ...over,
  }
}

function status(
  targets: ReturnType<typeof target>[],
  over: { enabled?: boolean } = {},
) {
  return { enabled: true, targets, ...over }
}

describe('preview pointer', () => {
  it('turns a point into a share of its frame, edges included', () => {
    const frame = { x: 100, y: 50, width: 800, height: 400 }
    expect(previewRatio({ x: 500, y: 250 }, frame)).toEqual({ x: 0.5, y: 0.5 })
    expect(previewRatio({ x: 100, y: 50 }, frame)).toEqual({ x: 0, y: 0 })
    expect(previewRatio({ x: 900, y: 450 }, frame)).toEqual({ x: 1, y: 1 })
    // Beside the frame (a menu bar item, a pop-up menu): not on the picture.
    expect(previewRatio({ x: 99, y: 250 }, frame)).toBeNull()
    expect(previewRatio({ x: 500, y: 451 }, frame)).toBeNull()
    // No usable frame, or no usable point.
    expect(previewRatio({ x: 1, y: 1 }, undefined)).toBeNull()
    expect(previewRatio({ x: 1, y: 1 }, { ...frame, width: 0 })).toBeNull()
    expect(previewRatio({ x: 1, y: 1 }, { ...frame, height: -4 })).toBeNull()
    expect(previewRatio({ x: Number.NaN, y: 60 }, frame)).toBeNull()
  })

  it('places a desktop point on its window, and nothing without one', () => {
    const window = { x: 200, y: 120, width: 850, height: 600 }
    expect(desktopPreviewPointer('t-1', { x: 412.5, y: 270 }, window)).toEqual({
      targetId: 't-1',
      x: 0.25,
      y: 0.25,
    })
    // An older Helper sends no window: the screen pointer only.
    expect(
      desktopPreviewPointer('t-1', { x: 412.5, y: 270 }, undefined),
    ).toBeNull()
  })

  it('places a built-in browser point on the tab’s viewport', () => {
    expect(pagePreviewPointer('tab-1', { x: 320, y: 600, viewport })).toEqual({
      targetId: 'tab-1',
      x: 0.25,
      y: 0.75,
    })
    expect(pagePreviewPointer('tab-1', { x: 1280, y: 800, viewport })).toEqual({
      targetId: 'tab-1',
      x: 1,
      y: 1,
    })
    // Out of the viewport, or a page that has no size yet.
    expect(pagePreviewPointer('tab-1', { x: 20, y: 801, viewport })).toBeNull()
    expect(
      pagePreviewPointer('tab-1', {
        x: 0,
        y: 0,
        viewport: { width: 0, height: 0 },
      }),
    ).toBeNull()
  })

  it('reports where a built-in browser action lands through its act hooks', () => {
    const order: string[] = []
    const sent: AgentPreviewPointer[] = []
    const hooks = withPreviewPointer(
      { dispatched: () => order.push('dispatched') },
      'tab-1',
      (pointer) => {
        order.push('pointer')
        sent.push(pointer)
      },
    )
    hooks.dispatched()
    hooks.landed?.({ x: 640, y: 400, viewport })
    hooks.landed?.({ x: 640, y: 900, viewport })
    expect(order).toEqual(['dispatched', 'pointer'])
    expect(sent).toEqual([{ targetId: 'tab-1', x: 0.5, y: 0.5 }])
    // Nobody listens: the plain hooks, so no landing point is even measured.
    const plain = { dispatched: vi.fn() }
    expect(withPreviewPointer(plain, 'tab-1', undefined)).toBe(plain)
  })

  it('draws only for a live desktop window or built-in tab the Agent controls', () => {
    expect(previewPointerAllowed(status([target()]), 't-1')).toBe(true)
    expect(
      previewPointerAllowed(
        status([target({ targetId: 'tab-1', driver: 'embedded-browser' })]),
        'tab-1',
      ),
    ).toBe(true)
    // A Chrome/Edge tab's preview is its latest screenshot: never drawn.
    expect(
      previewPointerAllowed(
        status([target({ driver: 'external-browser' })]),
        't-1',
      ),
    ).toBe(false)
    // Not under the Agent's control, or no longer held.
    const unheld: Record<string, string>[] = [
      { control: 'paused' },
      { state: 'released' },
      { state: 'closed' },
      { state: 'lost' },
    ]
    for (const over of unheld)
      expect(previewPointerAllowed(status([target(over)]), 't-1')).toBe(false)
    // Another target, computer use off, or no status at all.
    expect(previewPointerAllowed(status([target()]), 't-2')).toBe(false)
    expect(
      previewPointerAllowed(status([target()], { enabled: false }), 't-1'),
    ).toBe(false)
    expect(previewPointerAllowed(null, 't-1')).toBe(false)
  })

  it('relays a pointer to the renderer only while that target may show it', () => {
    const current = status([
      target(),
      target({ targetId: 'ext-1', driver: 'external-browser' }),
      target({ targetId: 't-2', control: 'paused' }),
    ])
    const send = vi.fn()
    const relay = createPreviewPointerRelay({ status: () => current, send })
    relay({ targetId: 't-1', x: 0.5, y: 0.25 })
    relay({ targetId: 'ext-1', x: 0.5, y: 0.25 })
    relay({ targetId: 't-2', x: 0.5, y: 0.25 })
    expect(send.mock.calls).toEqual([[{ targetId: 't-1', x: 0.5, y: 0.25 }]])
    // The preview is best effort: a failure never reaches the action.
    const failing = createPreviewPointerRelay({
      status: () => {
        throw new Error('closing')
      },
      send,
    })
    expect(() => failing({ targetId: 't-1', x: 0.5, y: 0.5 })).not.toThrow()
  })
})
