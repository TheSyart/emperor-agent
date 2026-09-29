import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import { describe, expect, it } from 'vitest'
import {
  agentTabsFor,
  keyInput,
  previewPoint,
  toAgentTab,
} from './agentTabsModel'

function target(patch: Partial<UiTargetView> = {}): UiTargetView {
  return {
    targetId: 'tab_1',
    ownerSessionId: 's1',
    kind: 'embedded-tab',
    driver: 'embedded-browser',
    generation: 1,
    revision: 3,
    state: 'attached',
    control: 'agent',
    title: 'Fixture form',
    url: 'http://127.0.0.1:5173/form',
    origin: 'http://127.0.0.1:5173',
    profileId: 'temporary',
    openedAt: '2026-09-24T00:00:00.000Z',
    ...patch,
  }
}

function status(targets: UiTargetView[]): ComputerUseStatusView {
  return {
    supported: true,
    enabled: true,
    platform: 'macos',
    stopped: false,
    drivers: [],
    targets,
    grants: [],
    killSwitch: { accelerator: 'Control+Alt+Command+.', registered: true },
  }
}

const key = (
  key: string,
  mods: Partial<
    Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>
  > = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('agent tabs model', () => {
  it("lists only this session's live embedded-browser tabs", () => {
    const tabs = agentTabsFor(
      status([
        target(),
        target({ targetId: 'tab_2', ownerSessionId: 's2' }),
        target({ targetId: 'tab_3', state: 'closed' }),
        target({ targetId: 'tab_4', state: 'lost' }),
        target({ targetId: 'tab_5', driver: 'external-browser' }),
        target({ targetId: 'tab_6', state: 'recovering' }),
      ]),
      's1',
    )
    expect(tabs.map((tab) => tab.targetId)).toEqual(['tab_1', 'tab_6'])
    expect(tabs[1]).toMatchObject({ label: '正在恢复', recovering: true })
    expect(agentTabsFor(null, 's1')).toEqual([])
    expect(agentTabsFor(status([target()]), null)).toEqual([])
  })

  it('offers the controls that fit who is in control', () => {
    expect(toAgentTab(target())).toMatchObject({
      label: 'Agent 操作中',
      tone: 'active',
      actions: ['pause', 'takeover', 'close'],
      interactive: false,
    })
    expect(toAgentTab(target({ control: 'paused' }))).toMatchObject({
      label: '已暂停',
      actions: ['resume', 'takeover', 'close'],
    })
    expect(toAgentTab(target({ control: 'user-takeover' }))).toMatchObject({
      label: '你在操作',
      tone: 'user',
      actions: ['handback', 'close'],
      interactive: true,
    })
    expect(toAgentTab(target({ control: 'stopped' }))).toMatchObject({
      label: '已急停',
      tone: 'stopped',
      actions: ['takeover', 'close'],
    })
    expect(toAgentTab(target({ title: '' })).title).toBe('127.0.0.1:5173')
  })

  it('maps pointers through the letterboxed frame to page pixels', () => {
    const viewport = { width: 1280, height: 800 }
    // 640×800 box: the frame is drawn 640×400, centered vertically.
    const rect = { left: 100, top: 50, width: 640, height: 800 }
    expect(previewPoint(rect, viewport, 100, 250)).toEqual({ x: 0, y: 0 })
    expect(previewPoint(rect, viewport, 420, 450)).toEqual({ x: 640, y: 400 })
    expect(previewPoint(rect, viewport, 740, 650)).toEqual({ x: 1280, y: 800 })
    expect(previewPoint(rect, viewport, 420, 100)).toBeNull()
    expect(previewPoint({ ...rect, width: 0 }, viewport, 1, 1)).toBeNull()
  })

  it('sends printable keys as text and named keys or shortcuts as key events', () => {
    expect(keyInput(key('a'))).toEqual({ kind: 'text', text: 'a' })
    expect(keyInput(key('A', { shiftKey: true }))).toEqual({
      kind: 'text',
      text: 'A',
    })
    expect(keyInput(key(' '))).toEqual({ kind: 'text', text: ' ' })
    expect(keyInput(key('Enter'))).toEqual({
      kind: 'key',
      key: 'Enter',
      modifiers: [],
    })
    expect(keyInput(key('a', { metaKey: true }))).toEqual({
      kind: 'key',
      key: 'a',
      modifiers: ['meta'],
    })
    expect(keyInput(key('Tab', { shiftKey: true }))).toEqual({
      kind: 'key',
      key: 'Tab',
      modifiers: ['shift'],
    })
    expect(keyInput(key('Shift', { shiftKey: true }))).toBeNull()
    expect(keyInput(key('Dead'))).toBeNull()
  })
})
