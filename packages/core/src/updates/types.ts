/**
 * Update check types (REL-02). Type-only and browser-safe: runtime/types.ts
 * (the renderer's event union) imports `UpdateStatus` from here.
 */

export type UpdateChannel = 'stable' | 'preview'

export interface UpdateTransportRequest {
  url: URL
  headers: Record<string, string>
  signal: AbortSignal
}

export interface UpdateTransportResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  close(): void
}

/** One GET, redirects not followed, no cookies or credentials. */
export type UpdateTransport = (
  request: UpdateTransportRequest,
) => Promise<UpdateTransportResponse>

/** A newer release this Mac can install (REL-02). */
export interface UpdateRelease {
  version: string
  tag: string
  channel: UpdateChannel
  name: string
  publishedAt: string | null
  /** The release page on GitHub (查看更新说明). */
  notesUrl: string
  /** The DMG for this Mac's architecture. */
  asset: { name: string; size: number }
}

/** What the GitHub attestation check found (`gh attestation verify`). */
export type UpdateAttestation =
  | { status: 'verified' }
  | {
      status: 'unavailable'
      /** gh is not installed, not signed in, or could not finish. */
      reason: 'gh_missing' | 'gh_not_logged_in' | 'gh_failed'
      detail?: string
    }
  /** A test feed (EMPEROR_UPDATE_FEED_URL) has no attestation to check. */
  | { status: 'skipped'; reason: 'test_feed' }

/** The attestation check's own answer: `failed` refuses the download. */
export type UpdateAttestationResult =
  UpdateAttestation | { status: 'failed'; detail: string }

export type UpdateDownloadState =
  | { phase: 'idle' }
  | {
      phase: 'downloading'
      version: string
      fileName: string
      receivedBytes: number
      totalBytes: number
    }
  | {
      phase: 'verifying'
      version: string
      fileName: string
      step: 'checksum' | 'attestation'
    }
  | {
      phase: 'ready'
      version: string
      fileName: string
      /** Where the verified DMG is (the Downloads folder). */
      path: string
      attestation: UpdateAttestation
    }
  | {
      phase: 'failed'
      version: string
      fileName: string
      code: string
      message: string
    }

export interface UpdateElectronFacts {
  /** The running Electron (process.versions.electron). */
  current: string
  /** The newest Electron an Emperor release records, from the last check. */
  latest: string | null
  /** Major versions behind `latest`. */
  behind: number | null
  /** More than 2 majors behind: the diagnostics page shows a reminder. */
  outdated: boolean
}

export interface UpdateStatus {
  /** The host can check (Emperor desktop on macOS). */
  supported: boolean
  /** Checks may run here: a packaged app, or a test feed in development. */
  automatic: boolean
  /** Why `automatic` is false. */
  disabledReason: 'development' | 'smoke' | 'unsupported' | null
  /** 设置 › 常规 › 更新 › 检查更新. */
  enabled: boolean
  currentVersion: string
  channel: UpdateChannel
  checking: boolean
  /** Last check that reached GitHub (epoch ms). */
  lastCheckedAt: number | null
  /** The last check failed (retried quietly). */
  lastError: { code: string; message: string } | null
  available: UpdateRelease | null
  download: UpdateDownloadState
  electron: UpdateElectronFacts
  /** EMPEROR_UPDATE_FEED_URL in effect (a test feed), else null. */
  feedOverride: string | null
}

export interface UpdateDiagnostics {
  enabled: boolean
  automatic: boolean
  disabledReason: UpdateStatus['disabledReason']
  channel: UpdateChannel
  lastCheckedAt: number | null
  lastError: UpdateStatus['lastError']
  available: string | null
  electron: UpdateElectronFacts
  feedOverride: string | null
}

/** What the desktop host gives the update service (CoreApiCreateOptions). */
export interface UpdateHostOptions {
  /** process.versions.electron */
  electronVersion: string
  arch: 'arm64' | 'x64'
  /** HTTP without cookies or credentials; Node's https when omitted. */
  transport?: UpdateTransport
  /** Where a verified DMG goes (the user's Downloads folder). */
  downloadsDir: string
  /** A private staging folder is made here for each download. */
  tempDir: string
  /** Show a file in Finder (never opens it). */
  reveal: (path: string) => void
  /** Mark the file as downloaded (com.apple.quarantine). */
  markQuarantine?: (path: string) => Promise<void> | void
  /** EMPEROR_UPDATE_FEED_URL, as the host read it; null in production. */
  feedOverride?: string | null
  /** Checks may run: the packaged app, or development with a test feed. */
  automatic: boolean
  disabledReason?: 'development' | 'smoke' | null
}
