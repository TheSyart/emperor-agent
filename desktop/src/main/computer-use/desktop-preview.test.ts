import { describe, expect, it, vi } from 'vitest'
import type { AgentPreviewFrame } from '../../shared/ipc-contract'
import {
  DESKTOP_TARGET_ID,
  DesktopPreview,
  routedPreview,
  type DesktopPreviewFrame,
} from './desktop-preview'

const ID = 't-256F5CF2-A23D-4041-8ACA-E3C082832F8B'

function harness(frames: Array<DesktopPreviewFrame | null | Error>) {
  const timers: Array<() => void> = []
  const sent: AgentPreviewFrame[] = []
  const calls: Array<[string, number | undefined]> = []
  let release: (() => void) | undefined
  let hold = false
  const preview = new DesktopPreview({
    source: () => ({
      preview: async (targetId, afterSeq) => {
        calls.push([targetId, afterSeq])
        if (hold) await new Promise<void>((resolve) => (release = resolve))
        const next = frames.shift() ?? null
        if (next instanceof Error) throw next
        return next
      },
    }),
    send: (frame) => sent.push(frame),
    setTimer: (run) => {
      timers.push(run)
      return timers.length
    },
    clearTimer: () => undefined,
  })
  return {
    preview,
    sent,
    calls,
    timers,
    holdNext() {
      hold = true
    },
    release() {
      hold = false
      release?.()
    },
    async tick() {
      const run = timers.shift()
      run?.()
      await vi.waitFor(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('DesktopPreview', () => {
  it('forwards only new frames and asks for frames after the last one sent', async () => {
    const jpeg = Uint8Array.of(1, 2)
    const k = harness([
      { seq: 3, jpeg, width: 8, height: 6 },
      { seq: 3 },
      new Error('helper restarting'),
      { seq: 5, jpeg, width: 8, height: 6 },
    ])
    expect(k.preview.start(ID)).toEqual({ ok: true, width: 0, height: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await k.tick()
    await k.tick()
    await k.tick()
    expect(k.sent.map((frame) => frame.seq)).toEqual([3, 5])
    expect(k.calls.map(([, afterSeq]) => afterSeq)).toEqual([
      undefined,
      3,
      3,
      3,
    ])
  })

  it('keeps one request in flight per window and stops polling on stop', async () => {
    const k = harness([{ seq: 1 }, { seq: 2 }])
    k.holdNext()
    k.preview.start(ID)
    k.preview.start(ID)
    expect(k.calls).toHaveLength(1)
    k.preview.stop(ID)
    k.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(k.timers).toHaveLength(0)
    expect(k.preview.active).toEqual([])
  })

  it('previews at most four windows at a time', () => {
    const k = harness([])
    for (const n of [1, 2, 3, 4])
      expect(k.preview.start(`t-${n}`).ok).toBe(true)
    expect(k.preview.start('t-5')).toEqual({
      ok: false,
      error: '同时最多预览 4 个窗口',
    })
  })

  it('routes desktop windows to the polled preview and never forwards input to them', () => {
    const browser = {
      start: vi.fn(() => ({ ok: true as const, width: 1280, height: 800 })),
      stop: vi.fn(),
      input: vi.fn(() => true),
    }
    const k = harness([])
    const routed = routedPreview(browser, k.preview)
    expect(DESKTOP_TARGET_ID.test(ID)).toBe(true)
    expect(DESKTOP_TARGET_ID.test('tab_0123')).toBe(false)
    routed.start(ID)
    expect(k.preview.active).toEqual([ID])
    expect(browser.start).not.toHaveBeenCalled()
    expect(routed.input(ID, { type: 'text', text: 'x' } as never)).toBe(false)
    expect(browser.input).not.toHaveBeenCalled()
    routed.stop(ID)
    expect(k.preview.active).toEqual([])
    const tab = 'tab_00000000-0000-0000-0000-000000000000'
    routed.start(tab)
    routed.input(tab, { type: 'text', text: 'x' } as never)
    expect(browser.start).toHaveBeenCalledWith(tab)
    expect(browser.input).toHaveBeenCalled()
  })
})
