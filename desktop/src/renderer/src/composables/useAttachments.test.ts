import { describe, expect, it, vi } from 'vitest'
import type { AttachmentRef } from '../types'

const pending: Array<{ file: File; resolve: (ref: AttachmentRef) => void }> = []
vi.mock('../api/attachments', () => ({
  uploadAttachment: (file: File) =>
    new Promise<AttachmentRef>((resolve) => pending.push({ file, resolve })),
}))

const { useAttachments } = await import('./useAttachments')

const ref = (id: string, name: string): AttachmentRef =>
  ({ id, name, mime: 'image/png', size: 1, kind: 'image' }) as AttachmentRef

describe('composer attachments', () => {
  it('tracks two uploads with the same name separately', async () => {
    pending.length = 0
    const attachments = useAttachments({ onError: () => {} })
    const first = attachments.handleFiles([new File(['a'], 'image.png')])
    const second = attachments.handleFiles([new File(['b'], 'image.png')])
    await Promise.resolve()
    expect(attachments.uploading.value.size).toBe(2)
    pending[0]!.resolve(ref('a1', 'image.png'))
    await first
    expect(attachments.uploading.value.size).toBe(1)
    expect([...attachments.uploading.value.values()]).toEqual(['image.png'])
    pending[1]!.resolve(ref('b1', 'image.png'))
    await second
    expect(attachments.uploading.value.size).toBe(0)
    expect(attachments.drafts.value.map((d) => d.id)).toEqual(['a1', 'b1'])
  })

  it('takes pasted image files like dropped ones', async () => {
    pending.length = 0
    const attachments = useAttachments({ onError: () => {} })
    const done = attachments.handleFiles([
      new File(['png'], 'Screenshot.png', { type: 'image/png' }),
    ])
    await Promise.resolve()
    pending[0]!.resolve(ref('shot', 'Screenshot.png'))
    await done
    expect(attachments.drafts.value.map((d) => d.id)).toEqual(['shot'])
  })
})
