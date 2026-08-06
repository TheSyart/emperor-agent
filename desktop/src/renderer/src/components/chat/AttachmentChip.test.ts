// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../types'
import AttachmentChip from './AttachmentChip.vue'

const image: AttachmentRef = {
  id: 'att_preview',
  name: 'reference.png',
  mime: 'image/png',
  size: 2048,
  kind: 'image',
  hasText: false,
  hasImage: true,
  path: 'attachments/reference.png',
}

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null

afterEach(() => {
  app?.unmount()
  document.querySelector('.attachment-preview-modal')?.remove()
  container?.remove()
  container = null
  app = null
})

describe('AttachmentChip image preview', () => {
  it('opens a full-size preview and closes it with Escape', async () => {
    container = document.createElement('div')
    document.body.append(container)
    app = createApp(() => h(AttachmentChip, { data: image }))
    app.mount(container)

    const trigger = container.querySelector<HTMLButtonElement>(
      '.attach-preview-trigger',
    )!
    expect(trigger).not.toBeNull()
    trigger.click()
    await nextTick()

    const dialog = document.querySelector<HTMLElement>(
      '.attachment-preview-modal',
    )!
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      'app://attachments/att_preview/raw',
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.querySelector('.attachment-preview-modal')).toBeNull()
  })

  it('keeps non-image attachments as non-previewable chips', () => {
    container = document.createElement('div')
    document.body.append(container)
    const documentAttachment: AttachmentRef = {
      ...image,
      kind: 'document',
      mime: 'application/pdf',
    }
    app = createApp(() => h(AttachmentChip, { data: documentAttachment }))
    app.mount(container)

    expect(container.querySelector('.attach-preview-trigger')).toBeNull()
  })
})
