import type { AttachmentRef } from '../types'
import { invokeCore } from './backend'

export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const raw = new Uint8Array(await file.arrayBuffer())
  const ref = await invokeCore('attachments.save', {
    raw,
    name: file.name,
    mime: file.type || 'application/octet-stream',
  })
  return {
    id: ref.id,
    name: ref.name,
    mime: ref.mime,
    size: ref.size,
    kind: ref.kind,
    hasText: ref.has_text,
    hasImage: ref.has_image,
    path: ref.rel_path,
    textPath: ref.text_rel_path,
  }
}

export function attachmentRawUrl(id: string): string {
  return `app://attachments/${encodeURIComponent(id)}/raw`
}
