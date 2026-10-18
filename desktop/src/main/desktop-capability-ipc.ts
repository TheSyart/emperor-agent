import {
  AGENT_DOWNLOAD_MOVE_CHANNEL,
  AGENT_DOWNLOAD_REVEAL_CHANNEL,
  AGENT_DOWNLOAD_SAVE_AS_CHANNEL,
  AGENT_PREVIEW_START_CHANNEL,
  AGENT_PREVIEW_STOP_CHANNEL,
  BROWSER_ACTION_CHANNEL,
  BROWSER_EXTENSION_INSTALL_CHANNEL,
  BROWSER_EXTENSION_REMOVE_CHANNEL,
  BROWSER_EXTENSION_REVEAL_CHANNEL,
  BROWSER_EXTENSION_STATUS_CHANNEL,
  BROWSER_PAIRING_APPROVE_CHANNEL,
  BROWSER_PAIRING_DENY_CHANNEL,
  BROWSER_PAIRING_REVOKE_CHANNEL,
  BROWSER_PAIRING_STATUS_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  BROWSER_HISTORY_CHANNEL,
  BROWSER_HISTORY_OPEN_CHANNEL,
  BROWSER_CLEAR_DATA_CHANNEL,
  BROWSER_DOWNLOADS_CHANNEL,
  BROWSER_DOWNLOAD_FOLDER_CHANNEL,
  BROWSER_DOWNLOAD_OPEN_CHANNEL,
  BROWSER_DOWNLOAD_REMOVE_CHANNEL,
  BROWSER_DOWNLOAD_REVEAL_CHANNEL,
  BROWSER_IMPORT_RUN_CHANNEL,
  BROWSER_IMPORT_SOURCES_CHANNEL,
  type AgentDownloadView,
  type BrowserImportBrowser,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSources,
  type BrowserClearResult,
  type BrowserHistoryEntry,
  type DownloadHistory,
  type UserDownloadView,
  EXTERNAL_OPEN_CHANNEL,
  LINK_OPEN_CHANNEL,
  MAC_HELPER_PERMISSION_CHANNEL,
  MAC_HELPER_RECONNECT_CHANNEL,
  MAC_HELPER_RESET_CHANNEL,
  MAC_HELPER_STATUS_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  type BrowserExtensionBrowser,
  type BrowserExtensionInstallResult,
  type BrowserExtensionRemoveResult,
  type BrowserExtensionStatus,
  type BrowserPairingStatus,
  type BrowserPairingView,
  type FileDialogFilter,
  type MacHelperPermission,
  type MacHelperStatus,
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
  /** The temporary history, newest first. */
  history(): Promise<BrowserHistoryEntry[]>
  /** Reopen a history entry by id (its address is checked again). */
  openHistory(id: string): Promise<{ ok: true; url: string }>
  /** Clear the built-in browser's own partition and history. */
  clearData(): Promise<BrowserClearResult>
}

/** Your own downloads in the built-in browser (user-downloads.ts), by id. */
interface UserDownloadsCapability {
  /** Newest first; no paths. */
  list(): UserDownloadView[]
  /** Open a finished download; '' once it opened, else why not. */
  open(id: string): Promise<string>
  /** Show a finished download in Finder; false when its file is gone. */
  reveal(id: string): boolean
  /** Take it off the list (the file stays). */
  remove(id: string): boolean
  /** The system folder picker for 位置; null when cancelled. */
  chooseFolder(): Promise<string | null>
}

/** A completed download of the Agent inbox (`DownloadInbox.list`). */
interface InboxDownloadLike {
  readonly downloadId: string
  readonly name: string
  readonly ownerSessionId?: string
  readonly origin?: string
  readonly time: number
  readonly bytes: number
  readonly exists: boolean
  /** From the user's own Chrome or Edge (RV-09): browser and outcome. */
  readonly browser?: string
  readonly state?: string
  readonly reason?: string
}

/** Computer Use: stream an Agent tab or window for the preview (by id only). */
interface AgentPreviewCapability {
  start(
    targetId: string,
  ): { ok: true; width: number; height: number } | { ok: false; error: string }
  stop(targetId: string): void
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

interface BrowserExtensionCapability {
  status(): Promise<BrowserExtensionStatus>
  install(): Promise<BrowserExtensionInstallResult>
  remove(): Promise<BrowserExtensionRemoveResult>
  /** The folder for 在访达中显示, or null while there is none. */
  revealPath(): Promise<string | null>
}

interface BrowserPairingCapability {
  readonly isListening: boolean
  pendingPairings(): readonly {
    pairingId: string
    extensionId: string
    code: string
    displayed: boolean
    browser?: string
  }[]
  readyPairings(): string[]
  /** Every stored pairing (no secrets), also those not connected now. */
  storedPairings?(): Promise<
    readonly { pairingId: string; createdAt?: string; browser?: string }[]
  >
  approvePairing(pairingId: string): Promise<boolean>
  denyPairing(pairingId: string): boolean
  revokePairing(pairingId: string): Promise<void>
}

export function registerDesktopCapabilityIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  browser: BrowserCapability
  references: ReferenceCapability
  showItemInFolder(path: string): void
  openExternal(url: string): Promise<unknown>
  /**
   * A web link the user clicked: main routes it (system or built-in browser,
   * see link-routing.ts) and reports where it went.
   */
  openLink?(url: string): Promise<'builtin' | 'system' | 'refused'>
  skills?: SkillFolderCapability
  /** `shell.openPath`: resolves '' on success, else an error message. */
  openPath?: (path: string) => Promise<string>
  /** Native single-file picker; resolves the chosen path or null. */
  selectFile?: (options: {
    title?: string
    filters: FileDialogFilter[]
  }) => Promise<string | null>
  agentPreview?: AgentPreviewCapability
  /** Download inbox: reveal a completed download by id (never a path). */
  agentDownloads?: {
    reveal(downloadId: string): boolean
    /** Move into the owning conversation's workspace; its relative path. */
    moveToWorkspace?(downloadId: string): Promise<string | undefined>
    /** Ask where to put it (system save dialog) and move it there. */
    saveAs?(downloadId: string): Promise<string | null | undefined>
    /** 设置 › 浏览器 › 下载历史记录: the inbox, newest first. */
    list?(): readonly InboxDownloadLike[]
  }
  /** 设置 › 浏览器 › 下载 and the 浏览器 pane: your own downloads. */
  userDownloads?: UserDownloadsCapability
  /** 从浏览器导入 (ST-06): read Chrome/Edge, save into vault + a profile. */
  browserImport?: {
    /** The source list and each browser's running state (no secrets). The
     *  importer's readonly shape is accepted; the handler rebuilds the wire
     *  object. */
    sources(): {
      browsers: ReadonlyArray<{
        browser: BrowserImportBrowser
        name: string
        installed: boolean
        running: boolean
        profiles: ReadonlyArray<{ dir: string; name: string }>
      }>
    }
    /** Run one import; resolves counts, never a value. */
    run(request: BrowserImportRequest): Promise<BrowserImportResult>
  }
  /** Main-owned helper status and OS permission prompt; never receives a path or nonce from renderer. */
  macHelper?: {
    status(): Promise<MacHelperStatus>
    requestPermission(
      permission: MacHelperPermission,
    ): Promise<{ opened: boolean }>
    resetPermission(
      permission: MacHelperPermission,
    ): Promise<{ reset: boolean }>
    /** Clears the crash-restart latch and connects again (00 §12). */
    reconnect?(): Promise<MacHelperStatus>
  }
  browserPairings?: BrowserPairingCapability
  /** Counts only authenticated, explicitly attached extension tabs. */
  externalAttachedCount?: () => number
  /** The same tabs, with the pairing (`profileId`) each belongs to. */
  externalAttachedTabs?: () => ReadonlyArray<{ profileId: string }>
  /** 设置 › 电脑操作 › Chrome 和 Edge: the extension folder (main decides the path). */
  browserExtension?: BrowserExtensionCapability
}): void {
  const authorize = (event: unknown) => input.authorize(event)
  const { skills, openPath, selectFile } = input

  input.ipcMain.handle(MAC_HELPER_STATUS_CHANNEL, async (event) => {
    authorize(event)
    if (!input.macHelper) return unavailableMacHelperStatus()
    try {
      return sanitizeMacHelperStatus(await input.macHelper.status())
    } catch {
      return {
        ...unavailableMacHelperStatus(),
        reason: '无法连接 Emperor Computer Helper',
      }
    }
  })
  input.ipcMain.handle(
    MAC_HELPER_PERMISSION_CHANNEL,
    async (event, payload) => {
      authorize(event)
      const permission = objectRecord(payload).permission
      if (permission !== 'accessibility' && permission !== 'screen-recording')
        throw new Error('invalid helper permission')
      if (!input.macHelper) return { opened: false }
      try {
        const result = await input.macHelper.requestPermission(permission)
        return { opened: result.opened === true }
      } catch {
        return { opened: false }
      }
    },
  )
  input.ipcMain.handle(MAC_HELPER_RESET_CHANNEL, async (event, payload) => {
    authorize(event)
    const permission = objectRecord(payload).permission
    if (permission !== 'accessibility' && permission !== 'screen-recording')
      throw new Error('invalid helper permission')
    if (!input.macHelper) return { reset: false }
    try {
      const result = await input.macHelper.resetPermission(permission)
      return { reset: result.reset === true }
    } catch {
      return { reset: false }
    }
  })
  input.ipcMain.handle(MAC_HELPER_RECONNECT_CHANNEL, async (event) => {
    authorize(event)
    const reconnect = input.macHelper?.reconnect
    if (!reconnect) return unavailableMacHelperStatus()
    try {
      return sanitizeMacHelperStatus(await reconnect.call(input.macHelper))
    } catch {
      return {
        ...unavailableMacHelperStatus(),
        reason: '无法连接 Emperor Computer Helper',
      }
    }
  })

  input.ipcMain.handle(
    BROWSER_PAIRING_STATUS_CHANNEL,
    async (event): Promise<BrowserPairingStatus> => {
      authorize(event)
      const bridge = input.browserPairings
      if (!bridge)
        return {
          bridgeListening: false,
          pendingPairings: [],
          pairedConnections: [],
          attachedTabs: 0,
          pairings: [],
        }
      const count = input.externalAttachedCount?.() ?? 0
      const ready = bridge.readyPairings().filter(pairingIdValid)
      const stored = await (
        bridge.storedPairings?.() ?? Promise.resolve([])
      ).catch(() => [])
      return {
        bridgeListening: bridge.isListening === true,
        pendingPairings: bridge
          .pendingPairings()
          .filter(
            (item) =>
              pairingIdValid(item.pairingId) &&
              /^[a-p]{32}$/.test(item.extensionId) &&
              /^\d{6}$/.test(item.code),
          )
          .map(({ pairingId, extensionId, code, displayed, browser }) => {
            const label = pairingBrowser(browser)
            return {
              pairingId,
              extensionId,
              code,
              displayed: displayed === true,
              ...(label ? { browser: label } : {}),
            }
          }),
        pairedConnections: ready,
        attachedTabs: Number.isSafeInteger(count)
          ? Math.max(0, Math.min(count, 10_000))
          : 0,
        pairings: pairingViews(
          stored,
          ready,
          input.externalAttachedTabs?.() ?? [],
        ),
      }
    },
  )
  input.ipcMain.handle(
    BROWSER_PAIRING_APPROVE_CHANNEL,
    async (event, payload) => {
      authorize(event)
      const pairingId = pairingIdentity(payload)
      return {
        approved:
          (await input.browserPairings?.approvePairing(pairingId)) === true,
      }
    },
  )
  input.ipcMain.handle(BROWSER_PAIRING_DENY_CHANNEL, (event, payload) => {
    authorize(event)
    const pairingId = pairingIdentity(payload)
    return { denied: input.browserPairings?.denyPairing(pairingId) === true }
  })
  input.ipcMain.handle(
    BROWSER_PAIRING_REVOKE_CHANNEL,
    async (event, payload) => {
      authorize(event)
      const pairingId = pairingIdentity(payload)
      if (!input.browserPairings) return { revoked: false }
      await input.browserPairings.revokePairing(pairingId)
      return { revoked: true }
    },
  )

  const extension = input.browserExtension
  if (extension) {
    input.ipcMain.handle(
      BROWSER_EXTENSION_STATUS_CHANNEL,
      async (event, payload): Promise<BrowserExtensionStatus> => {
        authorize(event)
        noExtensionArgument(payload)
        return extensionStatusView(await extension.status())
      },
    )
    input.ipcMain.handle(
      BROWSER_EXTENSION_INSTALL_CHANNEL,
      async (event, payload): Promise<BrowserExtensionInstallResult> => {
        authorize(event)
        noExtensionArgument(payload)
        const result = await extension.install()
        return {
          ok: result.ok === true,
          registered: (result.registered ?? []).filter((name) =>
            /^[a-z-]{1,32}$/.test(name),
          ),
          ...(INSTALL_REASONS.has(result.reason as string)
            ? { reason: result.reason }
            : {}),
          status: extensionStatusView(result.status),
        }
      },
    )
    input.ipcMain.handle(
      BROWSER_EXTENSION_REVEAL_CHANNEL,
      async (event, payload) => {
        authorize(event)
        noExtensionArgument(payload)
        const folder = await extension.revealPath()
        if (!folder) return { ok: false }
        input.showItemInFolder(folder)
        return { ok: true }
      },
    )
    input.ipcMain.handle(
      BROWSER_EXTENSION_REMOVE_CHANNEL,
      async (event, payload): Promise<BrowserExtensionRemoveResult> => {
        authorize(event)
        noExtensionArgument(payload)
        const result = await extension.remove()
        const uninstalled = Number.isSafeInteger(result.uninstalled)
          ? Math.max(0, Math.min(result.uninstalled, 100))
          : 0
        return {
          ok: result.ok === true,
          uninstalled,
          status: extensionStatusView(result.status),
        }
      },
    )
  }

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
  input.ipcMain.handle(BROWSER_HISTORY_CHANNEL, async (event) => {
    authorize(event)
    try {
      return await input.browser.history()
    } catch {
      return []
    }
  })
  input.ipcMain.handle(BROWSER_HISTORY_OPEN_CHANNEL, async (event, payload) => {
    authorize(event)
    const id =
      typeof payload === 'string' && /^h\d{1,12}$/.test(payload) ? payload : ''
    if (!id) return { ok: false, error: HISTORY_ENTRY_GONE }
    try {
      return await input.browser.openHistory(id)
    } catch (error) {
      return {
        ok: false,
        error: /clear/.test(String(error))
          ? BROWSER_CLEARING
          : HISTORY_ENTRY_GONE,
      }
    }
  })
  // No argument is read: the partition to clear is fixed in main.
  input.ipcMain.handle(BROWSER_CLEAR_DATA_CHANNEL, async (event) => {
    authorize(event)
    try {
      return await input.browser.clearData()
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
  const openLink = input.openLink
  if (openLink)
    input.ipcMain.handle(LINK_OPEN_CHANNEL, async (event, payload) => {
      authorize(event)
      const url = typeof payload === 'string' ? payload.slice(0, 4096) : ''
      const opened = await openLink(url)
      return { ok: opened !== 'refused', opened }
    })
  // One-way messages have no caller to reject: an untrusted sender (e.g. a
  // frame already torn down while its window closes) or a malformed payload
  // is dropped. Throwing here would surface as an uncaught main-process
  // exception dialog.
  const oneWay = (
    channel: string,
    handle: (payload: unknown) => void,
  ): void => {
    input.ipcMain.on(channel, (event, payload) => {
      try {
        authorize(event)
        handle(payload)
      } catch {
        // dropped
      }
    })
  }
  oneWay(BROWSER_BOUNDS_CHANNEL, (payload) => {
    input.browser.setBounds(payload)
  })
  oneWay(BROWSER_ACTION_CHANNEL, (payload) => {
    input.browser.action(typeof payload === 'string' ? payload : '')
  })
  oneWay(BROWSER_CLOSE_CHANNEL, () => {
    input.browser.close()
  })
  const downloads = input.agentDownloads
  if (downloads)
    input.ipcMain.handle(AGENT_DOWNLOAD_REVEAL_CHANNEL, (event, payload) => {
      authorize(event)
      const downloadId = String(objectRecord(payload).downloadId ?? '')
      if (!DOWNLOAD_ID.test(downloadId)) throw new Error('invalid download id')
      return downloads.reveal(downloadId)
        ? { ok: true }
        : { ok: false, error: '找不到这个下载文件' }
    })
  if (downloads?.saveAs)
    input.ipcMain.handle(
      AGENT_DOWNLOAD_SAVE_AS_CHANNEL,
      async (event, payload) => {
        authorize(event)
        const downloadId = String(objectRecord(payload).downloadId ?? '')
        if (!DOWNLOAD_ID.test(downloadId))
          throw new Error('invalid download id')
        const saved = await downloads.saveAs!(downloadId)
        return saved === null
          ? { ok: false, cancelled: true }
          : saved === undefined
            ? { ok: false, error: '找不到这个下载文件，可能已被移走或删除' }
            : { ok: true, path: saved }
      },
    )
  if (downloads?.moveToWorkspace)
    input.ipcMain.handle(
      AGENT_DOWNLOAD_MOVE_CHANNEL,
      async (event, payload) => {
        authorize(event)
        const downloadId = String(objectRecord(payload).downloadId ?? '')
        if (!DOWNLOAD_ID.test(downloadId))
          throw new Error('invalid download id')
        const moved = await downloads.moveToWorkspace!(downloadId)
        return moved === undefined
          ? { ok: false, error: '找不到这个下载文件，可能已被移走或删除' }
          : { ok: true, path: moved }
      },
    )
  const userDownloads = input.userDownloads
  if (userDownloads) {
    // Paths stay in main: the renderer gets names and ids only.
    input.ipcMain.handle(
      BROWSER_DOWNLOADS_CHANNEL,
      (event): DownloadHistory => {
        authorize(event)
        return {
          user: userDownloads.list(),
          agent: (input.agentDownloads?.list?.() ?? []).map(agentDownloadView),
        }
      },
    )
    input.ipcMain.handle(
      BROWSER_DOWNLOAD_OPEN_CHANNEL,
      async (event, payload) => {
        authorize(event)
        const error = await userDownloads.open(userDownloadId(payload))
        return error ? { ok: false, error } : { ok: true }
      },
    )
    input.ipcMain.handle(BROWSER_DOWNLOAD_REVEAL_CHANNEL, (event, payload) => {
      authorize(event)
      return userDownloads.reveal(userDownloadId(payload))
        ? { ok: true }
        : { ok: false, error: '找不到这个下载文件，可能已被移走或删除' }
    })
    input.ipcMain.handle(BROWSER_DOWNLOAD_REMOVE_CHANNEL, (event, payload) => {
      authorize(event)
      return { ok: userDownloads.remove(userDownloadId(payload)) }
    })
    // No argument is read: main picks the dialog's starting folder.
    input.ipcMain.handle(BROWSER_DOWNLOAD_FOLDER_CHANNEL, async (event) => {
      authorize(event)
      return await userDownloads.chooseFolder()
    })
  }
  const browserImport = input.browserImport
  if (browserImport) {
    input.ipcMain.handle(
      BROWSER_IMPORT_SOURCES_CHANNEL,
      (event): BrowserImportSources => {
        authorize(event)
        return sanitizeImportSources(browserImport.sources())
      },
    )
    input.ipcMain.handle(
      BROWSER_IMPORT_RUN_CHANNEL,
      async (event, payload): Promise<BrowserImportResult> => {
        authorize(event)
        return await browserImport.run(browserImportRequest(payload))
      },
    )
  }
  const preview = input.agentPreview
  if (preview) {
    input.ipcMain.handle(AGENT_PREVIEW_START_CHANNEL, (event, payload) => {
      authorize(event)
      return preview.start(previewTarget(payload))
    })
    oneWay(AGENT_PREVIEW_STOP_CHANNEL, (payload) => {
      preview.stop(previewTarget(payload))
    })
  }
}

const PERMISSION_STATUSES = new Set(['granted', 'denied', 'unknown', 'stale'])

function unavailableMacHelperStatus(): MacHelperStatus {
  return {
    available: false,
    previewBuild: false,
    connected: false,
    helperVersion: null,
    protocol: null,
    permissions: { accessibility: 'unknown', 'screen-recording': 'unknown' },
    lastErrorCode: null,
    reason: 'macOS helper 尚未接入',
  }
}

/** Whitelist diagnostics so launch nonces, paths and native error text cannot cross IPC. */
function sanitizeMacHelperStatus(value: MacHelperStatus): MacHelperStatus {
  const status = (
    permission: MacHelperPermission,
  ): MacHelperStatus['permissions'][MacHelperPermission] => {
    const raw = value.permissions?.[permission]
    return PERMISSION_STATUSES.has(raw) ? raw : 'unknown'
  }
  return {
    available: value.available === true,
    previewBuild: value.previewBuild === true,
    connected: value.connected === true,
    helperVersion:
      typeof value.helperVersion === 'string'
        ? value.helperVersion.slice(0, 64)
        : null,
    protocol:
      typeof value.protocol === 'number' && Number.isSafeInteger(value.protocol)
        ? value.protocol
        : null,
    permissions: {
      accessibility: status('accessibility'),
      'screen-recording': status('screen-recording'),
    },
    lastErrorCode:
      typeof value.lastErrorCode === 'string'
        ? value.lastErrorCode.slice(0, 64)
        : null,
    ...(typeof value.reason === 'string'
      ? { reason: value.reason.slice(0, 200) }
      : {}),
    ...(value.autoRestartSuspended === true
      ? { autoRestartSuspended: true }
      : {}),
  }
}

/** Agent browser tabs, or desktop windows bound through the helper. */
const TARGET_ID =
  /^(?:tab_[0-9a-f-]{36}|t-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})$/
const DOWNLOAD_ID = /^dl_[0-9a-f]{12}$/
const USER_DOWNLOAD_ID = /^ud_[0-9a-f]{12}$/

/** `{ id }` of one of your downloads. */
function userDownloadId(payload: unknown): string {
  const id =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).id
      : undefined
  if (typeof id !== 'string' || !USER_DOWNLOAD_ID.test(id))
    throw new Error('invalid download id')
  return id
}

function agentDownloadView(entry: InboxDownloadLike): AgentDownloadView {
  return {
    id: entry.downloadId,
    name: entry.name,
    site: entry.origin ?? '',
    sessionId: entry.ownerSessionId ?? null,
    time: entry.time,
    bytes: entry.bytes,
    exists: entry.exists,
    ...externalDownloadFacts(entry),
  }
}

/** Chrome/Edge rows (RV-09): only the values the page knows how to say. */
function externalDownloadFacts(
  entry: InboxDownloadLike,
): Pick<AgentDownloadView, 'browser' | 'state' | 'reason'> {
  if (entry.browser !== 'chrome' && entry.browser !== 'edge') return {}
  if (
    entry.state !== 'completed' &&
    entry.state !== 'refused' &&
    entry.state !== 'interrupted'
  )
    return {}
  return {
    browser: entry.browser,
    state: entry.state,
    ...(entry.state === 'refused' &&
    (entry.reason === 'executable' ||
      entry.reason === 'blocked' ||
      entry.reason === 'denied')
      ? { reason: entry.reason }
      : {}),
  }
}

function previewTarget(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : String(objectRecord(value).targetId ?? '')
  if (!TARGET_ID.test(raw)) throw new Error('invalid agent target id')
  return raw
}

const BROWSER_UNAVAILABLE = '内置浏览器暂不可用'
const BROWSER_CLEARING = '正在清空临时浏览数据'
const HISTORY_ENTRY_GONE = '这条记录已不存在'

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

const PROFILE_ID = /^p_[0-9a-f]{12}$/

/** Validates a 从浏览器导入 request before it reaches the importer. */
function browserImportRequest(payload: unknown): BrowserImportRequest {
  const input = objectRecord(payload)
  if (input.browser !== 'chrome' && input.browser !== 'edge')
    throw new Error('invalid import browser')
  const profileDir =
    typeof input.profileDir === 'string' ? input.profileDir : ''
  // Chrome/Edge profile dirs are plain names like `Default` or `Profile 1`.
  if (!/^[\w .-]{1,64}$/.test(profileDir))
    throw new Error('invalid import profile')
  if (
    typeof input.passwords !== 'boolean' ||
    typeof input.cookies !== 'boolean'
  )
    throw new Error('invalid import selection')
  if (
    input.targetProfileId !== undefined &&
    !(
      typeof input.targetProfileId === 'string' &&
      PROFILE_ID.test(input.targetProfileId)
    )
  )
    throw new Error('invalid import target profile')
  return {
    browser: input.browser,
    profileDir,
    passwords: input.passwords,
    cookies: input.cookies,
    ...(input.targetProfileId === undefined
      ? {}
      : { targetProfileId: input.targetProfileId as string }),
  }
}

/** Whitelists the source list so nothing but names/dirs/flags crosses IPC.
 *  Accepts the importer's readonly shape and rebuilds mutable wire objects. */
function sanitizeImportSources(value: {
  browsers?: ReadonlyArray<{
    browser?: unknown
    name?: unknown
    installed?: unknown
    running?: unknown
    profiles?: ReadonlyArray<{ dir?: unknown; name?: unknown }>
  }>
}): BrowserImportSources {
  const clip = (text: unknown): string =>
    typeof text === 'string' ? text.slice(0, 200) : ''
  return {
    browsers: (Array.isArray(value?.browsers) ? value.browsers : [])
      .filter((item) => item?.browser === 'chrome' || item?.browser === 'edge')
      .slice(0, 8)
      .map((item) => ({
        browser: item.browser === 'edge' ? 'edge' : 'chrome',
        name: clip(item.name),
        installed: item.installed === true,
        running: item.running === true,
        profiles: (Array.isArray(item.profiles) ? item.profiles : [])
          .slice(0, 50)
          .map((profile: { dir?: unknown; name?: unknown }) => ({
            dir: clip(profile?.dir),
            name: clip(profile?.name),
          })),
      })),
  }
}

const INSTALL_REASONS = new Set([
  'no-host',
  'unavailable',
  'no-browser',
  'no-source',
  'io',
])

/** The extension channels take no argument: main decides every path. */
function noExtensionArgument(payload: unknown): void {
  if (payload !== undefined) throw new Error('invalid browser extension input')
}

function pairingBrowser(value: unknown): BrowserExtensionBrowser | undefined {
  return value === 'chrome' || value === 'edge' ? value : undefined
}

function clipped(value: unknown, length: number): string {
  return typeof value === 'string' ? value.slice(0, length) : ''
}

/** Whitelists the folder status so nothing else crosses IPC. */
function extensionStatusView(
  value: BrowserExtensionStatus,
): BrowserExtensionStatus {
  const folder = value?.folder
  return {
    folder: {
      path: clipped(folder?.path, 1024),
      displayPath: clipped(folder?.displayPath, 1024),
      ready: folder?.ready === true,
      version:
        typeof folder?.version === 'string'
          ? folder.version.slice(0, 32)
          : null,
    },
    bundledVersion:
      typeof value?.bundledVersion === 'string'
        ? value.bundledVersion.slice(0, 32)
        : null,
    browsers: (Array.isArray(value?.browsers) ? value.browsers : [])
      .filter((item) => pairingBrowser(item?.browser) !== undefined)
      .slice(0, 2)
      .map((item) => ({
        browser: pairingBrowser(item.browser)!,
        name: clipped(item.name, 64),
        present: item.present === true,
        extension:
          item.extension === 'loaded' || item.extension === 'disabled'
            ? item.extension
            : 'none',
        ...(typeof item.loadedFrom === 'string' && item.loadedFrom
          ? { loadedFrom: item.loadedFrom.slice(0, 1024) }
          : {}),
        developerMode: item.developerMode === true,
        hostRegistered: item.hostRegistered === true,
      })),
  }
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * Saved pairings (store order), then any connected one the store missed;
 * each with its browser label and the tabs connected through it.
 */
function pairingViews(
  stored: readonly {
    pairingId: string
    createdAt?: string
    browser?: string
  }[],
  ready: readonly string[],
  tabs: ReadonlyArray<{ profileId: string }>,
): BrowserPairingView[] {
  const views = new Map<string, BrowserPairingView>()
  const tabCount = (pairingId: string) =>
    tabs.filter((tab) => tab.profileId === pairingId).length
  for (const item of [
    ...stored,
    ...ready.map((pairingId) => ({ pairingId })),
  ] as readonly {
    pairingId: string
    createdAt?: string
    browser?: string
  }[]) {
    if (!pairingIdValid(item.pairingId) || views.has(item.pairingId)) continue
    views.set(item.pairingId, {
      pairingId: item.pairingId,
      browser: pairingBrowser(item.browser) ?? null,
      connected: ready.includes(item.pairingId),
      tabs: Math.min(tabCount(item.pairingId), 10_000),
      createdAt:
        typeof item.createdAt === 'string' && ISO_TIME.test(item.createdAt)
          ? item.createdAt
          : null,
    })
    if (views.size >= 100) break
  }
  return [...views.values()]
}

function pairingIdValid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(value)
}

function pairingIdentity(payload: unknown): string {
  const pairingId = objectRecord(payload).pairingId
  if (!pairingIdValid(pairingId)) throw new Error('invalid browser pairing id')
  return pairingId
}

function requiredIdentity(value: unknown, kind: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > 256)
    throw new Error(`invalid ${kind} identity`)
  return result
}

/**
 * What the renderer may hand to the system: a non-local http(s) address, or
 * a mailto: / tel: link from a reply (SEC-05). Other schemes (sms:,
 * facetime:, x-apple.systempreferences: …) are refused.
 */
function eligibleExternalUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  if (/^(?:mailto|tel):/i.test(raw)) {
    // eslint-disable-next-line no-control-regex
    if (raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw))
      throw new Error('invalid external url')
    return raw
  }
  let url: URL
  try {
    url = new URL(raw)
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
