import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  composerModeOptions,
  composerPresetOptions,
  composerSendDisabled,
  composerStopPresentation,
  currentComposerPermission,
  currentComposerMode,
} from './composerControls'

describe('composer control model', () => {
  it('renders queue and stop actions while busy; interjection lives in the queue tray', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../composer/ComposerCard.vue', import.meta.url)),
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
      fileURLToPath(new URL('../composer/QueueDock.vue', import.meta.url)),
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

  it('disables a second busy submission while the single queue slot is occupied', () => {
    expect(
      composerSendDisabled({
        busy: true,
        content: 'second queued message',
        attachmentCount: 0,
        queueOccupied: true,
      }),
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

  it('exposes the three Core permission presets', () => {
    expect(composerModeOptions.map((option) => option.value)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ])
    expect(currentComposerMode('danger-full-access')).toMatchObject({
      value: 'danger-full-access',
      short: '完全',
    })
    expect(currentComposerMode('ask_before_edit').value).toBe('workspace-write')
  })

  it('keeps the preset while Plan is a separate toggle and prefers Core copy', () => {
    expect(
      currentComposerPermission({ preset: 'read-only', plan: true }),
    ).toMatchObject({ value: 'read-only', short: '只读' })
    const options = composerPresetOptions({
      presets: [
        { value: 'read-only', name: 'Read only', description: 'core copy' },
      ],
    })
    expect(options[0]).toMatchObject({
      label: 'Read only',
      description: 'core copy',
    })
    expect(options[1]?.value).toBe('workspace-write')
  })

  it('uses pause semantics while the owner session Goal is running', () => {
    expect(composerStopPresentation(true)).toEqual({
      title: '暂停当前 Goal',
      label: '暂停 Goal',
    })
    expect(composerStopPresentation(false).title).toBe('停止当前任务')
  })
})
