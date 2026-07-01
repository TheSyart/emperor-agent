import type { AttachmentRef } from '../types'
import { invokeCore } from './backend'

export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const raw = new Uint8Array(await file.arrayBuffer())
  return await invokeCore('attachments.save', {
    raw,
    name: file.name,
    mime: file.type || 'application/octet-stream',
  }) as AttachmentRef
}

export function attachmentRawUrl(id: string): string {
  return `app://attachments/${encodeURIComponent(id)}/raw`
}
