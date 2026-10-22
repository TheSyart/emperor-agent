// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { BootstrapPayload } from '../../types'
import {
  FIRST_RUN_KEY,
  heroModelState,
  readFirstRunDismissed,
  rememberFirstRunDismissed,
  shouldOpenFirstRun,
} from './firstRunGate'

function boot(
  models: number,
  usable: boolean,
  message = '还没有可用模型。请先配置模型后再开始对话。',
): BootstrapPayload {
  return {
    modelConfig: {
      models: Array.from({ length: models }, (_, i) => ({ entryId: `e${i}` })),
      availability: { usable, message },
    },
  } as unknown as BootstrapPayload
}

const quiet = { dismissed: false, settingsOpen: false }

beforeEach(() => localStorage.clear())

describe('shouldOpenFirstRun (UI-S17)', () => {
  it('opens at launch only with no model entry at all', () => {
    expect(shouldOpenFirstRun(boot(0, false), quiet)).toBe(true)
    // A broken entry is a repair, offered on the hero.
    expect(shouldOpenFirstRun(boot(1, false), quiet)).toBe(false)
    expect(shouldOpenFirstRun(boot(1, true), quiet)).toBe(false)
    expect(shouldOpenFirstRun(null, quiet)).toBe(false)
  })

  it('stays closed once put off, or over an open 设置', () => {
    expect(
      shouldOpenFirstRun(boot(0, false), { ...quiet, dismissed: true }),
    ).toBe(false)
    expect(
      shouldOpenFirstRun(boot(0, false), { ...quiet, settingsOpen: true }),
    ).toBe(false)
  })

  it('remembers 稍后配置 across launches', () => {
    expect(readFirstRunDismissed()).toBe(false)
    rememberFirstRunDismissed()
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('dismissed')
    expect(readFirstRunDismissed()).toBe(true)
  })
})

describe('heroModelState (UI-S17)', () => {
  it('says nothing while a model works', () => {
    expect(heroModelState(boot(1, true))).toBeNull()
    expect(heroModelState(null)).toBeNull()
  })

  it('offers setup with no model, and the reason for a broken one', () => {
    expect(heroModelState(boot(0, false))).toEqual({ kind: 'setup' })
    expect(
      heroModelState(boot(1, false, '模型条目「X」缺少 API Key。')),
    ).toEqual({ kind: 'repair', message: '模型条目「X」缺少 API Key。' })
    expect(heroModelState(boot(1, false, ''))).toEqual({
      kind: 'repair',
      message: '当前模型不可用',
    })
  })
})
