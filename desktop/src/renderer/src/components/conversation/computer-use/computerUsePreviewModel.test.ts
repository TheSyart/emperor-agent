import { describe, expect, it } from 'vitest'
import type { UiTargetView } from '@emperor/core/runtime-contract'
import {
  FRAME_ASPECT,
  liveTargetIds,
  pickTarget,
  pointerPlacement,
  previewFrame,
  previewSource,
  previewStatus,
  previewTargetsFor,
  previewTitle,
  shotTime,
  stackOrder,
} from './computerUsePreviewModel'

function target(over: Partial<UiTargetView> = {}): UiTargetView {
  return {
    targetId: 't-1',
    ownerSessionId: 's1',
    kind: 'desktop-window',
    driver: 'desktop',
    generation: 1,
    revision: 1,
    state: 'attached',
    control: 'agent',
    title: '文稿',
    url: 'app:com.apple.TextEdit',
    origin: null,
    profileId: 'desktop',
    openedAt: '2026-09-29T10:00:00.000Z',
    lastActiveAt: '2026-09-29T10:00:00.000Z',
    ...over,
  }
}

const ids = (targets: readonly UiTargetView[]) =>
  targets.map((item) => item.targetId)

describe('conversation computer-use preview model', () => {
  it('shows nothing without targets and keeps other sessions out', () => {
    expect(previewTargetsFor([], 's1')).toEqual([])
    expect(previewTargetsFor(undefined, 's1')).toEqual([])
    expect(previewTargetsFor([target()], null)).toEqual([])
    expect(
      ids(
        previewTargetsFor(
          [
            target(),
            target({ targetId: 'other', ownerSessionId: 's2' }),
            target({ targetId: 'closed', state: 'closed' }),
            target({ targetId: 'lost', state: 'lost' }),
          ],
          's1',
        ),
      ),
    ).toEqual(['t-1'])
  })

  it('drops the whole group once the task released it, keeping failures', () => {
    const released = [
      target({ state: 'released' }),
      target({
        targetId: 'tab',
        driver: 'embedded-browser',
        state: 'released',
      }),
    ]
    expect(previewTargetsFor(released, 's1')).toEqual([])
    const failed = target({
      targetId: 'stuck',
      state: 'released',
      releaseFailed: 'the helper did not answer',
    })
    const shown = previewTargetsFor([...released, failed], 's1')
    expect(ids(shown)).toEqual(['stuck'])
    expect(previewStatus(failed, { stopped: false, awaiting: false })).toEqual({
      label: '释放失败',
      tone: 'lost',
    })
    // A failed release shows no live picture.
    expect(liveTargetIds(shown, { stopped: false, onScreen: true })).toEqual([])
  })

  it('stacks the latest operation on top across windows and tabs', () => {
    const mixed = previewTargetsFor(
      [
        target({ targetId: 'finder', lastActiveAt: '2026-09-29T10:00:01Z' }),
        target({
          targetId: 'tab',
          kind: 'embedded-tab',
          driver: 'embedded-browser',
          url: 'https://example.com/a',
          lastActiveAt: '2026-09-29T10:00:03Z',
        }),
        target({
          targetId: 'chrome',
          kind: 'external-tab',
          driver: 'external-browser',
          url: 'https://example.org/',
          lastActiveAt: '2026-09-29T10:00:02Z',
        }),
      ],
      's1',
    )
    expect(ids(mixed)).toEqual(['tab', 'chrome', 'finder'])
  })

  it('keeps a card the user brought forward on top until the Agent acts again', () => {
    const targets = previewTargetsFor(
      [
        target({ targetId: 'a', lastActiveAt: '2026-09-29T10:00:02Z' }),
        target({ targetId: 'b', lastActiveAt: '2026-09-29T10:00:01Z' }),
      ],
      's1',
    )
    const pick = pickTarget(targets, 'b')
    expect(ids(stackOrder(targets, pick))).toEqual(['b', 'a'])
    expect(pickTarget(targets, 'missing')).toBeNull()
    const later = targets.map((item) =>
      item.targetId === 'a'
        ? { ...item, lastActiveAt: '2026-09-29T10:00:05Z' }
        : item,
    )
    expect(ids(stackOrder(later, pick))).toEqual(['a', 'b'])
  })

  it('streams at most four cards and never blocked, external or stopped ones', () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      target({
        targetId: `w${index}`,
        lastActiveAt: `2026-09-29T10:00:0${9 - index}Z`,
      }),
    )
    const ordered = previewTargetsFor(many, 's1')
    expect(liveTargetIds(ordered, { stopped: false, onScreen: true })).toEqual([
      'w0',
      'w1',
      'w2',
      'w3',
    ])
    // Rotation follows the order: the newest four stream.
    const rotated = previewTargetsFor(
      many.map((item) =>
        item.targetId === 'w5'
          ? { ...item, lastActiveAt: '2026-09-29T10:01:00Z' }
          : item,
      ),
      's1',
    )
    expect(liveTargetIds(rotated, { stopped: false, onScreen: true })).toEqual([
      'w5',
      'w0',
      'w1',
      'w2',
    ])
    const special = [
      target({ targetId: 'sensitive', previewBlocked: 'sensitive-app' }),
      target({ targetId: 'secret', previewBlocked: 'credential-filled' }),
      target({
        targetId: 'chrome',
        kind: 'external-tab',
        driver: 'external-browser',
      }),
      target({ targetId: 'recovering', state: 'recovering' }),
      target({ targetId: 'ok' }),
    ]
    expect(liveTargetIds(special, { stopped: false, onScreen: true })).toEqual([
      'ok',
    ])
    expect(liveTargetIds(special, { stopped: true, onScreen: true })).toEqual(
      [],
    )
    expect(liveTargetIds(special, { stopped: false, onScreen: false })).toEqual(
      [],
    )
  })

  it('labels what each card is doing', () => {
    const idle = { stopped: false, awaiting: false }
    expect(previewStatus(target(), idle)).toEqual({
      label: '操作中',
      tone: 'active',
    })
    expect(previewStatus(target(), { stopped: false, awaiting: true })).toEqual(
      { label: '等待回复', tone: 'waiting' },
    )
    expect(previewStatus(target({ state: 'recovering' }), idle).label).toBe(
      '失联',
    )
    expect(
      previewStatus(target(), { stopped: true, awaiting: true }).label,
    ).toBe('已急停')
  })

  it('shows a live frame, else the dated latest screenshot, else why not', () => {
    const now = new Date(2026, 8, 29, 18, 30)
    expect(previewFrame(target(), 'blob:frame', now)).toEqual({
      kind: 'live',
      url: 'blob:frame',
      note: '实时画面',
    })
    const takenAt = new Date(2026, 8, 29, 18, 5).toISOString()
    expect(
      previewFrame(
        target({
          lastScreenshot: {
            attachmentId: 'att_1',
            width: 10,
            height: 10,
            takenAt,
          },
        }),
        undefined,
        now,
      ),
    ).toEqual({ kind: 'shot', attachmentId: 'att_1', note: '最近截图 · 18:05' })
    expect(previewFrame(target(), undefined, now)).toEqual({
      kind: 'none',
      note: '等待画面',
    })
    expect(
      previewFrame(
        target({ driver: 'external-browser', kind: 'external-tab' }),
        undefined,
        now,
      ).note,
    ).toBe('暂无截图')
  })

  it('never shows a picture of a sensitive app or after a credential fill', () => {
    const now = new Date()
    const shot = {
      attachmentId: 'att_old',
      width: 1,
      height: 1,
      takenAt: now.toISOString(),
    }
    expect(
      previewFrame(
        target({ previewBlocked: 'sensitive-app', lastScreenshot: shot }),
        'blob:live',
        now,
      ),
    ).toEqual({ kind: 'blocked', note: '不可预览：你标记的敏感应用' })
    expect(
      previewFrame(
        target({ previewBlocked: 'credential-filled', lastScreenshot: shot }),
        undefined,
        now,
      ),
    ).toEqual({ kind: 'blocked', note: '不可预览：已代填凭据' })
  })

  it('keeps the last frame after Stop Sharing, marked, and stops streaming it', () => {
    const now = new Date(2026, 8, 29, 18, 30)
    const stopped = target({ sharingStopped: true })
    expect(
      liveTargetIds([stopped], { stopped: false, onScreen: true }),
    ).toEqual([])
    expect(previewFrame(stopped, 'blob:last', now)).toEqual({
      kind: 'frozen',
      url: 'blob:last',
      note: '画面已停止共享 · 最后一帧',
    })
    expect(
      previewFrame(
        target({
          sharingStopped: true,
          lastScreenshot: {
            attachmentId: 'att_2',
            width: 1,
            height: 1,
            takenAt: new Date(2026, 8, 29, 18, 1).toISOString(),
          },
        }),
        undefined,
        now,
      ).note,
    ).toBe('画面已停止共享 · 最近截图 · 18:01')
    expect(previewFrame(stopped, undefined, now)).toEqual({
      kind: 'none',
      note: '画面已停止共享',
    })
    // The Agent keeps working: the card still reads 操作中.
    expect(
      previewStatus(stopped, { stopped: false, awaiting: false }).label,
    ).toBe('操作中')
  })

  it('dates screenshots from another day', () => {
    const now = new Date(2026, 8, 29, 9, 0)
    expect(shotTime(new Date(2026, 8, 28, 23, 7).toISOString(), now)).toBe(
      '9月28日 23:07',
    )
    expect(shotTime('not a date', now)).toBe('')
  })

  it('names the app, or the browser and site', () => {
    expect(previewSource(target())).toBe('TextEdit')
    expect(
      previewSource(
        target({ driver: 'embedded-browser', url: 'https://example.com/x' }),
      ),
    ).toBe('内置浏览器 · example.com')
    expect(
      previewSource(
        target({ driver: 'external-browser', url: 'https://example.org/' }),
      ),
    ).toBe('已连接的浏览器 · example.org')
    expect(previewTitle(target({ title: '' }))).toBe('未命名窗口')
    expect(
      previewTitle(
        target({
          title: '',
          driver: 'embedded-browser',
          url: 'https://example.com/x',
        }),
      ),
    ).toBe('example.com')
  })

  it('places the Agent’s pointer on a card’s letterboxed picture', () => {
    const near = (
      placement: { left: number; top: number },
      left: number,
      top: number,
    ) => {
      expect(placement.left).toBeCloseTo(left, 6)
      expect(placement.top).toBeCloseTo(top, 6)
    }
    expect(FRAME_ASPECT).toBe(16 / 10)
    // A picture as wide as the box fills it.
    near(
      pointerPlacement({ x: 0.25, y: 0.5 }, { width: 1280, height: 800 }),
      25,
      50,
    )
    // Wider: bands above and below (a 2.5 picture takes 64% of the height).
    near(
      pointerPlacement({ x: 0.5, y: 0 }, { width: 2000, height: 800 }),
      50,
      18,
    )
    near(
      pointerPlacement({ x: 1, y: 1 }, { width: 2000, height: 800 }),
      100,
      82,
    )
    // Taller: bands left and right (a 0.8 picture takes half the width).
    near(pointerPlacement({ x: 0, y: 0 }, { width: 800, height: 1000 }), 25, 0)
    near(
      pointerPlacement({ x: 1, y: 0.5 }, { width: 800, height: 1000 }),
      75,
      50,
    )
    // Without a picture size, the picture is taken to fill the box.
    near(pointerPlacement({ x: 0.3, y: 0.6 }), 30, 60)
    near(pointerPlacement({ x: 0.3, y: 0.6 }, { width: 0, height: 0 }), 30, 60)
  })
})
