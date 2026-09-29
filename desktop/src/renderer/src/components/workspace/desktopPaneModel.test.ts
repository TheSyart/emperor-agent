import { describe, expect, it } from 'vitest'
import type { UiTargetView } from '@emperor/core/runtime-contract'
import {
  desktopLiveTargetIds,
  desktopPreviewNote,
  desktopTargetActions,
  desktopTargetsFor,
} from './desktopPaneModel'

const target: UiTargetView = {
  targetId: 'window-1',
  ownerSessionId: 'session-1',
  kind: 'desktop-window',
  driver: 'desktop',
  generation: 1,
  revision: 2,
  state: 'attached',
  control: 'agent',
  title: '文稿',
  url: 'app:com.example.Writer',
  origin: null,
  profileId: 'desktop',
  openedAt: '2026-09-24T00:00:00Z',
}

describe('desktop pane model', () => {
  it('shows only live desktop targets owned by this session', () => {
    expect(
      desktopTargetsFor(
        [
          target,
          { ...target, targetId: 'other', ownerSessionId: 'session-2' },
          { ...target, targetId: 'browser', driver: 'embedded-browser' },
          { ...target, targetId: 'closed', state: 'closed' },
          { ...target, targetId: 'lost', state: 'lost' },
        ],
        'session-1',
      ).map((item) => item.targetId),
    ).toEqual(['window-1'])
    expect(desktopTargetsFor([target], null)).toEqual([])
  })

  it('offers controls that match the current control state', () => {
    expect(desktopTargetActions('agent')).toEqual([
      'pause',
      'takeover',
      'close',
    ])
    expect(desktopTargetActions('paused')).toEqual([
      'resume',
      'takeover',
      'close',
    ])
    expect(desktopTargetActions('user-takeover')).toEqual(['handback', 'close'])
    expect(desktopTargetActions('stopped')).toEqual(['takeover', 'close'])
  })
})

describe('desktop live preview', () => {
  const view = (targetId: string, control: UiTargetView['control']) =>
    ({ targetId, control }) as UiTargetView

  it('streams only windows the Agent controls, at most four, and none after a stop', () => {
    const targets = [
      view('a', 'agent'),
      view('b', 'paused'),
      view('c', 'agent'),
      view('d', 'agent'),
      view('e', 'agent'),
      view('f', 'agent'),
      view('g', 'user-takeover'),
    ]
    expect(desktopLiveTargetIds(targets, false)).toEqual(['a', 'c', 'd', 'e'])
    expect(desktopLiveTargetIds(targets, true)).toEqual([])
  })

  it('says whether the picture is live and how Stop Sharing works', () => {
    expect(desktopPreviewNote(view('a', 'agent'), true, false)).toContain(
      '停止共享',
    )
    expect(desktopPreviewNote(view('a', 'agent'), false, false)).toContain(
      '等待实时画面',
    )
    expect(desktopPreviewNote(view('a', 'user-takeover'), true, false)).toBe(
      '实时预览已暂停，显示最后一帧',
    )
    expect(desktopPreviewNote(view('a', 'agent'), false, true)).toBe(
      '实时预览已暂停',
    )
  })
})
