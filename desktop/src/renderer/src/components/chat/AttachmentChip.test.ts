// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../types'
import { imageViewer, closeImageViewer } from '../ui/imageViewer'
import AttachmentChip from './AttachmentChip.vue'

const image: AttachmentRef = {
  id: 'att_2026-10_12345678',
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
  closeImageViewer()
  container?.remove()
  container = null
  app = null
})

describe('AttachmentChip image preview', () => {
  it('opens the shared lightbox for the draft owner', async () => {
    container = document.createElement('div')
    document.body.append(container)
    app = createApp(() => h(AttachmentChip, { data: image, owner: 'draft:1' }))
    app.mount(container)

    expect(container.textContent).not.toContain(image.name)
    expect(container.querySelector('.attach-meta')).toBeNull()

    const trigger = container.querySelector<HTMLButtonElement>(
      '.attach-preview-trigger',
    )!
    expect(trigger).not.toBeNull()
    trigger.click()
    await nextTick()

    expect(imageViewer.value?.items[0]?.src).toBe(
      'app://attachments/att_2026-10_12345678/raw',
    )
    expect(imageViewer.value?.owner).toBe('draft:1')
    closeImageViewer()
    expect(imageViewer.value).toBeNull()
  })

  it('keeps non-image attachments available through their file name', () => {
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
    expect(container.querySelector('.attach-meta')?.textContent).toContain(
      documentAttachment.name,
    )
  })
})
