/**
 * 检查更新 in main (REL-02): what Core's update service gets from the
 * desktop. Core owns the check, the download and the verification; main
 * gives it
 *
 * - the transport: Electron's net (system proxy settings apply), with no
 *   cookies, no credentials and redirects handed back to Core so it can
 *   check every hop against GitHub's release hosts;
 * - Finder (`shell.showItemInFolder`, never `openPath`), the Downloads
 *   folder, the downloaded-file mark (com.apple.quarantine), the arch and
 *   the running Electron;
 * - whether checks may run: the packaged app, never the packaged smoke; a
 *   development build only with a test feed.
 *
 * EMPEROR_UPDATE_FEED_URL is the one way to point Emperor at a test feed
 * (REL-07 simulates a release with it). It is read here from the process
 * environment only — no setting, page or agent tool can change it — must
 * be a loopback address, and shows in 设置 › 常规 › 更新 and in 诊断.
 * EMPEROR_E2E_DOWNLOADS_DIR (development builds only) keeps e2e downloads
 * out of the real Downloads folder and logs instead of opening Finder.
 */
import {
  feedOverrideUrl,
  registryOverrideUrl,
  type UpdateHostOptions,
  type UpdateTransport,
} from '@emperor/core/host-capabilities'
import {
  ElectronPublicHttpTransport,
  type ElectronRequestFactory,
} from './public-http-client'

/** Core cuts a download that stalls for a minute; this is only a ceiling. */
const DOWNLOAD_CEILING_MS = 6 * 60 * 60 * 1000

export interface UpdateHostInput {
  env: Record<string, string | undefined>
  isPackaged: boolean
  /** The packaged smoke run (it never reaches GitHub). */
  packagedSmoke: boolean
  arch: string
  electronVersion: string
  /** app.getPath('downloads') */
  downloadsDir: string
  /** app.getPath('temp') */
  tempDir: string
  /** shell.showItemInFolder */
  reveal: (path: string) => void
  markQuarantine: (path: string) => Promise<void>
  /** net.request */
  request: ElectronRequestFactory
  log: (line: string) => void
}

export function updateHostOptions(input: UpdateHostInput): UpdateHostOptions {
  let feedOverride: string | null = null
  const raw = input.env.EMPEROR_UPDATE_FEED_URL
  if (raw) {
    try {
      feedOverride = feedOverrideUrl(raw)?.href ?? null
      if (feedOverride) input.log(`test update feed in effect: ${feedOverride}`)
    } catch (error) {
      input.log(
        `EMPEROR_UPDATE_FEED_URL ignored: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const e2eDownloads =
    !input.isPackaged && input.env.EMPEROR_E2E_DOWNLOADS_DIR
      ? input.env.EMPEROR_E2E_DOWNLOADS_DIR
      : null
  const automatic =
    !input.packagedSmoke && (input.isPackaged || feedOverride !== null)
  return {
    electronVersion: input.electronVersion,
    arch: input.arch === 'arm64' ? 'arm64' : 'x64',
    transport: createElectronUpdateTransport(input.request),
    downloadsDir: e2eDownloads ?? input.downloadsDir,
    tempDir: input.tempDir,
    reveal: e2eDownloads
      ? (path) => input.log(`update reveal ${path}`)
      : (path) => input.reveal(path),
    markQuarantine: input.markQuarantine,
    feedOverride,
    automatic,
    disabledReason: automatic
      ? null
      : input.packagedSmoke
        ? 'smoke'
        : 'development',
  }
}

/**
 * 设置 › 子智能体 › 版本 (AGT-13): npm's public version numbers through the
 * same net (no cookies, no credentials). The check once a day at startup
 * runs in the packaged app (not the packaged smoke); a development build
 * checks by itself only with EMPEROR_EXECUTOR_REGISTRY_URL, a test registry
 * on this Mac. Opening the page checks in any build.
 */
export function executorVersionHostOptions(
  input: Pick<
    UpdateHostInput,
    'env' | 'isPackaged' | 'packagedSmoke' | 'request' | 'log'
  >,
): { transport: UpdateTransport; registry: string | null; automatic: boolean } {
  let registry: string | null = null
  const raw = input.env.EMPEROR_EXECUTOR_REGISTRY_URL
  if (raw) {
    try {
      registry = registryOverrideUrl(raw)?.href ?? null
      if (registry) input.log(`test executor registry in effect: ${registry}`)
    } catch {
      input.log(
        'EMPEROR_EXECUTOR_REGISTRY_URL ignored: only a registry on this Mac',
      )
    }
  }
  return {
    transport: createElectronUpdateTransport(input.request),
    registry,
    automatic: !input.packagedSmoke && (input.isPackaged || registry !== null),
  }
}

/**
 * Electron's net for the update check: `credentials: 'omit'`, no session
 * cookies, redirects returned (not followed), custom protocols bypassed.
 */
export function createElectronUpdateTransport(
  request: ElectronRequestFactory,
): UpdateTransport {
  const transport = new ElectronPublicHttpTransport(
    request,
    DOWNLOAD_CEILING_MS,
  )
  return (input) =>
    transport.request({
      url: input.url,
      // net resolves the host itself; the address fields are unused.
      address: '',
      family: 4,
      signal: input.signal,
      headers: input.headers,
    })
}
