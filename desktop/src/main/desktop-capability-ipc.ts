import {
  EXTERNAL_OPEN_CHANNEL,
  PREVIEW_ACTION_CHANNEL,
  PREVIEW_BOUNDS_CHANNEL,
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_EXTERNAL_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
} from '../shared/ipc-contract'

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
  on(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

interface PreviewCapability {
  open(input: { sessionId: string; previewId: string }): unknown
  openExternal(input: { sessionId: string; previewId: string }): unknown
  setBounds(value: unknown): void
  action(action: string): void
  close(): void
}

interface ReferenceCapability {
  revealPath(input: { sessionId: string; referenceId: string }): string
}

export function registerDesktopCapabilityIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  preview: PreviewCapability
  references: ReferenceCapability
  showItemInFolder(path: string): void
  openExternal(url: string): Promise<unknown>
}): void {
  const authorize = (event: unknown) => input.authorize(event)

  input.ipcMain.handle(PREVIEW_OPEN_CHANNEL, async (event, payload) => {
    authorize(event)
    return await input.preview.open(previewIdentity(payload))
  })
  input.ipcMain.handle(PREVIEW_EXTERNAL_CHANNEL, async (event, payload) => {
    authorize(event)
    return await input.preview.openExternal(previewIdentity(payload))
  })
  input.ipcMain.handle(REFERENCE_REVEAL_CHANNEL, (event, payload) => {
    authorize(event)
    const reference = referenceIdentity(payload)
    const path = input.references.revealPath(reference)
    input.showItemInFolder(path)
    return { ok: true }
  })
  input.ipcMain.handle(EXTERNAL_OPEN_CHANNEL, async (event, payload) => {
    authorize(event)
    const url = eligibleExternalUrl(payload)
    await input.openExternal(url)
    return { ok: true }
  })
  input.ipcMain.on(PREVIEW_BOUNDS_CHANNEL, (event, payload) => {
    authorize(event)
    input.preview.setBounds(payload)
  })
  input.ipcMain.on(PREVIEW_ACTION_CHANNEL, (event, payload) => {
    authorize(event)
    input.preview.action(typeof payload === 'string' ? payload : '')
  })
  input.ipcMain.on(PREVIEW_CLOSE_CHANNEL, (event) => {
    authorize(event)
    input.preview.close()
  })
}

function previewIdentity(value: unknown): {
  sessionId: string
  previewId: string
} {
  const record = objectRecord(value)
  return {
    sessionId: requiredIdentity(record.sessionId, 'session'),
    previewId: requiredIdentity(record.previewId, 'preview'),
  }
}

function referenceIdentity(value: unknown): {
  sessionId: string
  referenceId: string
} {
  const record = objectRecord(value)
  return {
    sessionId: requiredIdentity(record.sessionId, 'session'),
    referenceId: requiredIdentity(record.referenceId, 'reference'),
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid capability input')
  return value as Record<string, unknown>
}

function requiredIdentity(value: unknown, kind: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > 256)
    throw new Error(`invalid ${kind} identity`)
  return result
}

function eligibleExternalUrl(value: unknown): string {
  let url: URL
  try {
    url = new URL(typeof value === 'string' ? value : '')
  } catch {
    throw new Error('invalid external url')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback =
    host === 'localhost' || host === '::1' || host.startsWith('127.')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    loopback
  )
    throw new Error('invalid external url')
  return url.toString()
}
