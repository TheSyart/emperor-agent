import { describe, expect, it, vi } from 'vitest'
import {
  PICK_PROJECT_FIRST,
  fillSuggestion,
  heroExtrasShown,
  homeSendBlockedReason,
} from './heroHome'

// MOD-03: what the home lets through — a Build home sends nothing before a
// project is picked, a starter only fills the composer, and the first-run
// guide (UI-S17) comes before the home's extras.

describe('homeSendBlockedReason (MOD-03 2–3)', () => {
  it('blocks sending from a Build home until a project is picked', () => {
    expect(PICK_PROJECT_FIRST).toBe('先选一个项目')
    expect(
      homeSendBlockedReason({
        modelReason: '',
        home: true,
        mode: 'build',
        projectPath: null,
      }),
    ).toBe('先选一个项目')
    expect(
      homeSendBlockedReason({
        modelReason: '',
        home: true,
        mode: 'build',
        projectPath: '   ',
      }),
    ).toBe('先选一个项目')
  })

  it('lets a Build home with a project send, and never blocks Chat', () => {
    expect(
      homeSendBlockedReason({
        modelReason: '',
        home: true,
        mode: 'build',
        projectPath: '/work/alpha',
      }),
    ).toBe('')
    expect(
      homeSendBlockedReason({
        modelReason: '',
        home: true,
        mode: 'chat',
        projectPath: null,
      }),
    ).toBe('')
    // Past the home (a running conversation) the project rule is gone.
    expect(
      homeSendBlockedReason({
        modelReason: '',
        home: false,
        mode: 'build',
        projectPath: null,
      }),
    ).toBe('')
  })

  it('says the model problem first', () => {
    expect(
      homeSendBlockedReason({
        modelReason: '还没有可用模型，请先配置模型。',
        home: true,
        mode: 'build',
        projectPath: null,
      }),
    ).toBe('还没有可用模型，请先配置模型。')
  })
})

describe('heroExtrasShown (MOD-03 8)', () => {
  it('waits for the first-run guide', () => {
    expect(heroExtrasShown({ firstRunOpen: true, modelState: null })).toBe(
      false,
    )
  })

  it('keeps the hero on 开始接入 while there is no model at all', () => {
    expect(
      heroExtrasShown({ firstRunOpen: false, modelState: { kind: 'setup' } }),
    ).toBe(false)
  })

  it('shows them once a model is set up, even one that needs a repair', () => {
    expect(heroExtrasShown({ firstRunOpen: false, modelState: null })).toBe(
      true,
    )
    expect(
      heroExtrasShown({
        firstRunOpen: false,
        modelState: { kind: 'repair', message: '缺少 API Key' },
      }),
    ).toBe(true)
  })
})

describe('fillSuggestion (MOD-03 7)', () => {
  it('fills the composer and focuses it, and sends nothing', () => {
    const composer = {
      setDraft: vi.fn(),
      focusInput: vi.fn(),
      submit: vi.fn(),
    }
    fillSuggestion(composer, '帮我调研这个话题：')
    expect(composer.setDraft).toHaveBeenCalledWith('帮我调研这个话题：')
    expect(composer.focusInput).toHaveBeenCalled()
    expect(composer.submit).not.toHaveBeenCalled()
    expect(() => fillSuggestion(null, '翻译：')).not.toThrow()
  })
})
