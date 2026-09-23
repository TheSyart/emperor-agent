import {
  BROWSER_ACTION_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  type FileDialogFilter,
} from '../shared/ipc-contract'
import { normalizeBrowserInput } from './browser-view-policy'

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

interface BrowserCapability {
  /** Receives an already normalized http(s) URL (`normalizeBrowserInput`). */
  openUrl(input: { url: string }): Promise<{ ok: true; url: string }>
  setBounds(value: unknown): void
  action(action: string): void
  close(): void
}

interface ReferenceCapability {
  revealPath(input: { sessionId: string; referenceId: string }): string
}

interface SkillFolderCapability {
  /** CoreApi `skills.folderPath`: the Skills folder of a scope, created when missing. */
  folderPath(input: {
    scope: 'user' | 'project'
    sessionId?: string | null
  }): string
}

export function registerDesktopCapabilityIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  browser: BrowserCapability
  references: ReferenceCapability
  showItemInFolder(path: string): void
  openExternal(url: string): Promise<unknown>
  skills?: SkillFolderCapability
  /** `shell.openPath`: resolves '' on success, else an error message. */
  openPath?: (path: string) => Promise<string>
  /** Native single-file picker; resolves the chosen path or null. */
  selectFile?: (options: {
    title?: string
    filters: FileDialogFilter[]
  }) => Promise<string | null>
}): void {
  const authorize = (event: unknown) => input.authorize(event)
  const { skills, openPath, selectFile } = input

  if (skills && openPath)
    input.ipcMain.handle(SKILLS_OPEN_FOLDER_CHANNEL, async (event, payload) => {
      authorize(event)
      const request = skillFolderRequest(payload)
      let path: string
      try {
        path = skills.folderPath(request)
      } catch (error) {
        return { ok: false, ...safeError(error) }
      }
      const error = await openPath(path)
      return error ? { ok: false, error, path } : { ok: true, path }
    })
  if (selectFile)
    input.ipcMain.handle(SELECT_FILE_CHANNEL, async (event, payload) => {
      authorize(event)
      return await selectFile(fileDialogOptions(payload))
    })

  // Only the BrowserPane address bar calls this, on an explicit user submit
  // (see trusted-renderer-usage.test.ts); main still normalizes the input.
  input.ipcMain.handle(BROWSER_OPEN_CHANNEL, async (event, payload) => {
    authorize(event)
    const normalized = normalizeBrowserInput(browserOpenInput(payload))
    if (!normalized.ok) return { ok: false, error: normalized.reason }
    try {
      return await input.browser.openUrl({ url: normalized.url })
    } catch {
      return { ok: false, error: BROWSER_UNAVAILABLE }
    }
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
  input.ipcMain.on(BROWSER_BOUNDS_CHANNEL, (event, payload) => {
    authorize(event)
    input.browser.setBounds(payload)
  })
  input.ipcMain.on(BROWSER_ACTION_CHANNEL, (event, payload) => {
    authorize(event)
    input.browser.action(typeof payload === 'string' ? payload : '')
  })
  input.ipcMain.on(BROWSER_CLOSE_CHANNEL, (event) => {
    authorize(event)
    input.browser.close()
  })
}

const BROWSER_UNAVAILABLE = '内置浏览器暂不可用'

/** `{ url }` from the preload bridge; anything else fails normalization. */
function browserOpenInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return (value as Record<string, unknown>).url
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

function skillFolderRequest(value: unknown): {
  scope: 'user' | 'project'
  sessionId: string | null
} {
  const record = objectRecord(value)
  if (record.scope !== 'user' && record.scope !== 'project')
    throw new Error('invalid Skills folder scope')
  return {
    scope: record.scope,
    sessionId:
      record.sessionId === undefined || record.sessionId === null
        ? null
        : requiredIdentity(record.sessionId, 'session'),
  }
}

function fileDialogOptions(value: unknown): {
  title?: string
  filters: FileDialogFilter[]
} {
  const record =
    value === undefined || value === null ? {} : objectRecord(value)
  const title =
    typeof record.title === 'string' ? record.title.trim().slice(0, 120) : ''
  const rawFilters = Array.isArray(record.filters) ? record.filters : []
  if (rawFilters.length > 8) throw new Error('invalid file dialog filters')
  const filters = rawFilters.map((item) => {
    const filter = objectRecord(item)
    const name = typeof filter.name === 'string' ? filter.name.trim() : ''
    const extensions = Array.isArray(filter.extensions) ? filter.extensions : []
    if (
      !name ||
      name.length > 64 ||
      extensions.length === 0 ||
      extensions.length > 16 ||
      !extensions.every(
        (ext) =>
          typeof ext === 'string' && /^(?:\*|[A-Za-z0-9]{1,16})$/.test(ext),
      )
    )
      throw new Error('invalid file dialog filters')
    return { name, extensions: extensions as string[] }
  })
  return { ...(title ? { title } : {}), filters }
}

/** Message and code of a Core domain error (`toSafe()`), else a generic one. */
function safeError(error: unknown): { error: string; code?: string } {
  const toSafe =
    error && typeof error === 'object'
      ? (error as { toSafe?: unknown }).toSafe
      : undefined
  if (typeof toSafe === 'function') {
    const payload = toSafe.call(error) as {
      message?: unknown
      code?: unknown
    } | null
    if (payload && typeof payload.message === 'string' && payload.message)
      return {
        error: payload.message,
        ...(typeof payload.code === 'string' && payload.code
          ? { code: payload.code }
          : {}),
      }
  }
  return { error: 'Skills folder is unavailable' }
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
