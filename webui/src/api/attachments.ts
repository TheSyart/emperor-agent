import type { AttachmentRef } from '../types'

export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/attachments', { method: 'POST', body: fd })
  if (!r.ok) {
    let message = `HTTP ${r.status}`
    try {
      const data = await r.json()
      if (data && typeof data.error === 'string') message = data.error
    } catch {
      // ignore parse errors
    }
    throw new Error(message)
  }
  return (await r.json()) as AttachmentRef
}

export function attachmentRawUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}/raw`
}
