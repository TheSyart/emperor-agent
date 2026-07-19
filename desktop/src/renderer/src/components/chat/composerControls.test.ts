import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  composerModeOptions,
  composerSendDisabled,
  composerStopPresentation,
  currentComposerPermission,
  currentComposerMode,
} from './composerControls'

describe('composer control model', () => {
  it('renders separate queue, interject, and stop actions while busy', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./Composer.vue', import.meta.url)),
      'utf8',
    )
    expect(source).toContain("submit('queue')")
    expect(source).toContain("submit('interject')")
    expect(source).toContain("emit('stop')")
    const textarea = source.match(/<textarea[\s\S]*?\/>/)?.[0] || ''
    expect(textarea).toContain(':disabled="goalCaptureStarting"')
    expect(textarea).not.toContain(
      ':disabled="props.busy || goalCaptureStarting"',
    )
  })

  it('enables busy prompt delivery only for non-empty plain text', () => {
    expect(
      composerSendDisabled({ busy: true, content: '', attachmentCount: 0 }),
    ).toBe(true)
    expect(
      composerSendDisabled({ busy: true, content: '插话', attachmentCount: 0 }),
    ).toBe(false)
    expect(
      composerSendDisabled({ busy: true, content: '', attachmentCount: 1 }),
    ).toBe(true)
  })

  it('disables send only when idle with no content or attachments', () => {
    expect(
      composerSendDisabled({ busy: false, content: '', attachmentCount: 0 }),
    ).toBe(true)
    expect(
      composerSendDisabled({ busy: false, content: 'hi', attachmentCount: 0 }),
    ).toBe(false)
    expect(
      composerSendDisabled({ busy: false, content: '', attachmentCount: 1 }),
    ).toBe(false)
  })

  it('blocks idle sending when the model is unavailable without blocking a text interjection', () => {
    expect(
      composerSendDisabled({
        busy: false,
        content: 'hi',
        attachmentCount: 0,
        sendBlockedReason: '请先配置模型',
      }),
    ).toBe(true)
    expect(
      composerSendDisabled({
        busy: false,
        content: '',
        attachmentCount: 1,
        sendBlockedReason: '请先配置模型',
      }),
    ).toBe(true)
    expect(
      composerSendDisabled({
        busy: true,
        content: 'hi',
        attachmentCount: 0,
        sendBlockedReason: '请先配置模型',
      }),
    ).toBe(false)
  })

  it('exposes accept_edits as the middle permission mode', () => {
    expect(composerModeOptions.map((option) => option.value)).toEqual([
      'ask_before_edit',
      'accept_edits',
      'auto',
    ])
    expect(currentComposerMode('accept_edits')).toMatchObject({
      value: 'accept_edits',
      short: '编辑',
    })
    expect(currentComposerMode('normal').value).toBe('ask_before_edit')
  })

  it('shows the saved execution permission while Plan remains active', () => {
    expect(
      currentComposerPermission({ mode: 'plan', previous_mode: 'auto' }),
    ).toMatchObject({ value: 'auto', short: '自动' })
    expect(
      currentComposerPermission({
        mode: 'plan',
        previous_mode: 'accept_edits',
      }),
    ).toMatchObject({ value: 'accept_edits', short: '编辑' })
  })

  it('uses pause semantics while the owner session Goal is running', () => {
    expect(composerStopPresentation(true)).toEqual({
      title: '暂停当前 Goal',
      label: '暂停 Goal',
    })
    expect(composerStopPresentation(false).title).toBe('停止当前任务')
  })
})
