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
  it('renders queue and stop actions while busy; interjection lives in the queue tray', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./Composer.vue', import.meta.url)),
      'utf8',
    )
    expect(source).toContain("submit('queue')")
    expect(source).not.toContain("submit('interject')")
    expect(source).toContain("emit('stop')")
    const textarea = source.match(/<textarea[\s\S]*?\/>/)?.[0] || ''
    expect(textarea).toContain(
      ':disabled="goalCaptureStarting || props.interactionBlocked"',
    )
    expect(textarea).not.toContain(
      ':disabled="props.busy || goalCaptureStarting"',
    )
    expect(source).toContain(':disabled="goalCaptureStarting"')
    expect(source).not.toContain('等待当前任务结束后再添加')
    const queueTray = readFileSync(
      fileURLToPath(new URL('./QueueTray.vue', import.meta.url)),
      'utf8',
    )
    expect(queueTray).toContain('编辑消息')
    expect(queueTray).toContain('插入当前执行')
    expect(queueTray).toContain('删除')
  })

  it('enables busy queue delivery for text or attachments', () => {
    expect(
      composerSendDisabled({ busy: true, content: '', attachmentCount: 0 }),
    ).toBe(true)
    expect(
      composerSendDisabled({ busy: true, content: '插话', attachmentCount: 0 }),
    ).toBe(false)
    expect(
      composerSendDisabled({ busy: true, content: '', attachmentCount: 1 }),
    ).toBe(false)
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

  it('exposes smart_auto as the middle permission mode', () => {
    expect(composerModeOptions.map((option) => option.value)).toEqual([
      'ask_before_edit',
      'smart_auto',
      'full_access',
    ])
    expect(currentComposerMode('smart_auto')).toMatchObject({
      value: 'smart_auto',
      short: '智能',
    })
    expect(currentComposerMode('normal').value).toBe('ask_before_edit')
  })

  it('shows the saved execution permission while Plan remains active', () => {
    expect(
      currentComposerPermission({ mode: 'plan', previous_mode: 'full_access' }),
    ).toMatchObject({ value: 'full_access', short: '完全' })
    expect(
      currentComposerPermission({
        mode: 'plan',
        previous_mode: 'smart_auto',
      }),
    ).toMatchObject({ value: 'smart_auto', short: '智能' })
  })

  it('uses pause semantics while the owner session Goal is running', () => {
    expect(composerStopPresentation(true)).toEqual({
      title: '暂停当前 Goal',
      label: '暂停 Goal',
    })
    expect(composerStopPresentation(false).title).toBe('停止当前任务')
  })
})
