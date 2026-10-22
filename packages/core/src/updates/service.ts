/**
 * 检查更新 (REL-02, MAIN-22). Emperor's packages are unsigned, so Squirrel
 * cannot replace the app: this service only tells the user a newer release
 * exists and, when asked, downloads and verifies its DMG; installing stays
 * a drag into 「应用程序」.
 *
 * - Checks GitHub's release list 30 s after start, then every 24 hours,
 *   while 设置 › 常规 › 更新 › 检查更新 is on (settings.json `updates.check`,
 *   default on). Off: no request of any kind. A failed check is retried
 *   quietly 10 minutes, 1 hour and 4 hours later — at most 3 retries per
 *   24 hours — and only shows as a line in the status.
 * - Only higher versions on the build's channel count (feed.ts).
 * - 下载: SHA256SUMS.txt first, then the DMG into a private staging folder
 *   (progress events), its SHA-256 against the list (a mismatch deletes it),
 *   then `gh attestation verify` when the GitHub CLI can (else SHA-256 only,
 *   and the status says why). A verified DMG moves into Downloads (never
 *   over an existing file), gets the downloaded-file mark and is shown in
 *   Finder. Nothing is opened or installed.
 * - Runs only where the host says so: the packaged app, or development
 *   with an explicit loopback test feed (EMPEROR_UPDATE_FEED_URL). The test
 *   feed shows in the status and the diagnostics.
 */
import {
  chmod,
  copyFile,
  constants,
  link,
  mkdir,
  mkdtemp,
  rm,
  unlink,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { UpdateError, updateErrorOf } from './errors'
import {
  CHECKSUMS_FILE,
  electronReference,
  parseChecksums,
  parseReleases,
  selectUpdate,
  type SelectedUpdate,
} from './feed'
import {
  UPDATE_FEED_URL,
  UpdateHttp,
  UpdateUrlPolicy,
  feedOverrideUrl,
  nodeUpdateTransport,
} from './http'
import { parseAppVersion, versionChannel } from './version'
import type {
  UpdateAttestation,
  UpdateAttestationResult,
  UpdateDiagnostics,
  UpdateDownloadState,
  UpdateElectronFacts,
  UpdateHostOptions,
  UpdateStatus,
} from './types'

export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Retries after a failed check, inside one 24-hour period. */
export const RETRY_DELAYS_MS: readonly number[] = [
  10 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
]
const MAX_FEED_BYTES = 4 * 1024 * 1024
const MAX_CHECKSUMS_BYTES = 256 * 1024
const MAX_DMG_BYTES = 2 * 1024 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 250

export interface UpdateClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: UpdateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface CoreUpdateServiceDeps {
  appVersion: string
  /** Null: no desktop host (headless Core, tests): never checks. */
  host: UpdateHostOptions | null
  /** settings.json `updates.check`. */
  settings: {
    load(): Promise<boolean>
    save(enabled: boolean): Promise<void>
  }
  /** Host events to the renderer (`update_status`, `update_available`). */
  emit: (event: Record<string, unknown>) => void
  /** `gh attestation verify` for a downloaded file; none: gh unavailable. */
  attestation?: (
    file: string,
    release: SelectedUpdate,
  ) => Promise<UpdateAttestationResult>
  clock?: UpdateClock
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export class CoreUpdateService {
  private readonly deps: CoreUpdateServiceDeps
  private readonly clock: UpdateClock
  private readonly http: UpdateHttp | null
  private readonly feedUrl: URL
  private readonly override: URL | null
  private readonly channel: UpdateStatus['channel']
  private enabled = true
  private started = false
  private closed = false
  private timer: unknown = null
  private windowStart = 0
  private retries = 0
  private checking: Promise<UpdateStatus> | null = null
  private checkAbort: AbortController | null = null
  private lastCheckedAt: number | null = null
  private lastError: UpdateStatus['lastError'] = null
  private available: SelectedUpdate | null = null
  private announced = new Set<string>()
  private electronLatest: string | null = null
  private downloadState: UpdateDownloadState = { phase: 'idle' }
  private downloadAbort: AbortController | null = null
  private downloadJob: Promise<void> | null = null
  private lastProgressAt = 0

  constructor(deps: CoreUpdateServiceDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    const version = parseAppVersion(deps.appVersion)
    this.channel = version ? versionChannel(version) : 'stable'
    let override: URL | null = null
    try {
      override = feedOverrideUrl(deps.host?.feedOverride ?? null)
    } catch (error) {
      deps.log?.('update test feed refused', { error: String(error) })
    }
    this.override = override
    this.feedUrl = override ?? new URL(UPDATE_FEED_URL)
    this.http = deps.host
      ? new UpdateHttp({
          transport: deps.host.transport ?? nodeUpdateTransport,
          policy: new UpdateUrlPolicy(override),
          userAgent: `Emperor-Agent/${deps.appVersion}`,
        })
      : null
  }

  /** Read the switch and schedule the first check (30 s from now). */
  async start(): Promise<void> {
    if (this.started || this.closed) return
    this.started = true
    try {
      this.enabled = await this.deps.settings.load()
    } catch {
      this.enabled = true
    }
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  close(): void {
    this.closed = true
    this.clearTimer()
    this.checkAbort?.abort()
    this.downloadAbort?.abort()
  }

  status(): UpdateStatus {
    const host = this.deps.host
    return {
      supported: Boolean(host),
      automatic: this.canCheck(),
      disabledReason: !host
        ? 'unsupported'
        : this.canCheck()
          ? null
          : (host.disabledReason ?? 'development'),
      enabled: this.enabled,
      currentVersion: this.deps.appVersion,
      channel: this.channel,
      checking: this.checking !== null,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      available: this.available ? publicRelease(this.available) : null,
      download: { ...this.downloadState },
      electron: this.electronFacts(),
      feedOverride: this.override?.href ?? null,
    }
  }

  diagnostics(): UpdateDiagnostics {
    const status = this.status()
    return {
      enabled: status.enabled,
      automatic: status.automatic,
      disabledReason: status.disabledReason,
      channel: status.channel,
      lastCheckedAt: status.lastCheckedAt,
      lastError: status.lastError,
      available: status.available?.version ?? null,
      electron: status.electron,
      feedOverride: status.feedOverride,
    }
  }

  async setEnabled(enabled: boolean): Promise<UpdateStatus> {
    const next = Boolean(enabled)
    await this.deps.settings.save(next)
    this.enabled = next
    if (!next) {
      // Off means quiet: no timer, nothing in flight, nothing offered.
      this.clearTimer()
      this.checkAbort?.abort()
      this.downloadAbort?.abort()
      this.available = null
      if (this.downloadState.phase !== 'ready')
        this.downloadState = { phase: 'idle' }
      this.lastError = null
    } else if (this.started) {
      this.schedule(FIRST_CHECK_DELAY_MS)
    }
    this.publish()
    return this.status()
  }

  /** 立即检查: one check now (the schedule is unchanged). */
  async check(): Promise<UpdateStatus> {
    this.assertUsable()
    return await this.runCheck()
  }

  /** 下载: starts in the background; progress comes as status events. */
  async download(): Promise<UpdateStatus> {
    this.assertUsable()
    const release = this.available
    if (!release)
      throw new UpdateError('update_not_available', '现在没有可下载的新版本。')
    if (
      this.downloadState.phase === 'downloading' ||
      this.downloadState.phase === 'verifying'
    )
      return this.status()
    const abort = new AbortController()
    this.downloadAbort = abort
    this.setDownload({
      phase: 'downloading',
      version: release.version,
      fileName: release.asset.name,
      receivedBytes: 0,
      totalBytes: release.asset.size,
    })
    this.downloadJob = this.runDownload(release, abort).finally(() => {
      if (this.downloadAbort === abort) this.downloadAbort = null
    })
    return this.status()
  }

  async cancelDownload(): Promise<UpdateStatus> {
    if (
      this.downloadState.phase === 'downloading' ||
      this.downloadState.phase === 'verifying'
    ) {
      this.downloadAbort?.abort()
      // The job unwinds on its own and removes its staging folder.
      this.setDownload({ phase: 'idle' })
    }
    return this.status()
  }

  /** 在访达中显示 the verified DMG again. */
  async reveal(): Promise<UpdateStatus> {
    const host = this.deps.host
    if (
      !host ||
      this.downloadState.phase !== 'ready' ||
      !existsSync(this.downloadState.path)
    )
      throw new UpdateError(
        'update_download_missing',
        '下载的安装包已不在原来的位置，请重新下载。',
      )
    host.reveal(this.downloadState.path)
    return this.status()
  }

  // ── checking ──────────────────────────────────────────────────────────

  private canCheck(): boolean {
    return Boolean(this.deps.host?.automatic && this.http)
  }

  private assertUsable(): void {
    if (!this.canCheck())
      throw new UpdateError('update_unsupported', '这个版本不检查更新。')
    if (!this.enabled)
      throw new UpdateError(
        'update_check_disabled',
        '检查更新已关闭，可在「设置 › 常规 › 更新」打开。',
      )
  }

  private schedule(delay: number): void {
    this.clearTimer()
    if (this.closed || !this.enabled || !this.canCheck()) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.runScheduled()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** A scheduled check opens a 24-hour period with up to 3 retries. */
  private async runScheduled(retry = false): Promise<void> {
    if (!retry) {
      this.windowStart = this.clock.now()
      this.retries = 0
    }
    await this.runCheck()
    if (this.closed || !this.enabled) return
    if (this.lastError && this.retries < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[this.retries]!
      this.retries += 1
      const nextWindow = this.windowStart + CHECK_INTERVAL_MS
      if (this.clock.now() + delay < nextWindow) {
        this.clearTimer()
        this.timer = this.clock.setTimeout(() => {
          this.timer = null
          void this.runScheduled(true)
        }, delay)
        return
      }
    }
    this.schedule(
      Math.max(0, this.windowStart + CHECK_INTERVAL_MS - this.clock.now()),
    )
  }

  private runCheck(): Promise<UpdateStatus> {
    if (this.checking) return this.checking
    const abort = new AbortController()
    this.checkAbort = abort
    this.checking = (async () => {
      // After `checking` is set, so this status says a check is running.
      await Promise.resolve()
      this.publish()
      try {
        const body = await this.http!.getBytes(this.feedUrl, {
          accept: 'application/vnd.github+json',
          api: true,
          maxBytes: MAX_FEED_BYTES,
          signal: abort.signal,
        })
        let json: unknown
        try {
          json = JSON.parse(Buffer.from(body).toString('utf8'))
        } catch {
          throw new UpdateError(
            'update_bad_response',
            'GitHub 返回的版本列表无法识别。',
          )
        }
        if (!Array.isArray(json))
          throw new UpdateError(
            'update_bad_response',
            'GitHub 返回的版本列表无法识别。',
          )
        if (abort.signal.aborted || !this.enabled) return this.status()
        const releases = parseReleases(json, { policy: this.http!.policy })
        this.electronLatest = electronReference(releases)
        this.lastCheckedAt = this.clock.now()
        this.lastError = null
        this.offer(
          selectUpdate(releases, this.deps.appVersion, this.deps.host!.arch),
        )
      } catch (error) {
        if (!abort.signal.aborted) {
          const failure = updateErrorOf(error)
          this.lastError = { code: failure.code, message: failure.message }
          this.deps.log?.('update check failed', { code: failure.code })
        }
      } finally {
        if (this.checkAbort === abort) this.checkAbort = null
        this.checking = null
      }
      this.publish()
      return this.status()
    })()
    return this.checking
  }

  private offer(update: SelectedUpdate | null): void {
    this.available = update
    // A different release on offer replaces a finished or failed download
    // of another one (a verified file stays in Downloads); one still
    // running finishes first. With nothing on offer, a failure is dropped.
    const state = this.downloadState
    if (
      (state.phase === 'ready' || state.phase === 'failed') &&
      (update ? state.version !== update.version : state.phase === 'failed')
    )
      this.downloadState = { phase: 'idle' }
    if (update && !this.announced.has(update.version)) {
      this.announced.add(update.version)
      this.deps.emit({
        event: 'update_available',
        version: update.version,
        tag: update.tag,
        notesUrl: update.notesUrl,
      })
    }
  }

  // ── downloading ───────────────────────────────────────────────────────

  private async runDownload(
    release: SelectedUpdate,
    abort: AbortController,
  ): Promise<void> {
    const host = this.deps.host!
    const http = this.http!
    const base = {
      version: release.version,
      fileName: release.asset.name,
    }
    let staging: string | null = null
    let outcome: UpdateDownloadState | null = null
    try {
      staging = await mkdtemp(join(host.tempDir, 'emperor-update-'))
      const sumsText = Buffer.from(
        await http.getBytes(new URL(release.checksumsUrl), {
          accept: 'text/plain',
          maxBytes: MAX_CHECKSUMS_BYTES,
          signal: abort.signal,
        }),
      ).toString('utf8')
      const expected = parseChecksums(sumsText).get(release.asset.name)
      if (!expected)
        throw new UpdateError(
          'update_checksum_missing',
          `${CHECKSUMS_FILE} 里没有 ${release.asset.name} 的校验值，已停止下载。`,
        )
      const file = join(staging, release.asset.name)
      const digest = await http.downloadTo(new URL(release.assetUrl), file, {
        maxBytes: Math.min(release.asset.size, MAX_DMG_BYTES),
        expectedBytes: release.asset.size,
        signal: abort.signal,
        onProgress: (receivedBytes) => this.progress(release, receivedBytes),
      })
      this.ensureCurrent(abort)
      this.setDownload({ phase: 'verifying', ...base, step: 'checksum' })
      if (digest !== expected)
        throw new UpdateError(
          'update_checksum_mismatch',
          `安装包的 SHA-256 与 ${CHECKSUMS_FILE} 不符，已拒绝并删除下载的文件。`,
        )
      this.setDownload({ phase: 'verifying', ...base, step: 'attestation' })
      const attestation = await this.attest(file, release)
      this.ensureCurrent(abort)
      if (attestation.status === 'failed')
        throw new UpdateError(
          'update_attestation_failed',
          `GitHub 来源证明核验失败（${attestation.detail}），已拒绝并删除下载的文件。`,
        )
      const target = await moveIntoFolder(file, host.downloadsDir)
      try {
        await host.markQuarantine?.(target)
      } catch (error) {
        this.deps.log?.('update quarantine mark failed', {
          error: String(error),
        })
      }
      outcome = { phase: 'ready', ...base, path: target, attestation }
    } catch (error) {
      if (!abort.signal.aborted && this.downloadAbort === abort) {
        const failure = updateErrorOf(error)
        outcome = {
          phase: 'failed',
          ...base,
          code: failure.code,
          message: failure.message,
        }
      }
    } finally {
      // Whatever happened, nothing unverified stays behind.
      if (staging)
        await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
    if (!outcome || abort.signal.aborted) return
    this.setDownload(outcome)
    if (outcome.phase === 'ready') host.reveal(outcome.path)
  }

  private async attest(
    file: string,
    release: SelectedUpdate,
  ): Promise<UpdateAttestationResult> {
    if (this.override) return { status: 'skipped', reason: 'test_feed' }
    if (!this.deps.attestation)
      return { status: 'unavailable', reason: 'gh_missing' }
    try {
      return await this.deps.attestation(file, release)
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'gh_failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private ensureCurrent(abort: AbortController): void {
    if (abort.signal.aborted) throw new UpdateError('cancelled', '已取消下载。')
  }

  private progress(release: SelectedUpdate, receivedBytes: number): void {
    if (this.downloadState.phase !== 'downloading') return
    this.downloadState = { ...this.downloadState, receivedBytes }
    const now = this.clock.now()
    if (
      receivedBytes < release.asset.size &&
      now - this.lastProgressAt < PROGRESS_INTERVAL_MS
    )
      return
    this.lastProgressAt = now
    this.publish()
  }

  private setDownload(state: UpdateDownloadState): void {
    this.downloadState = state
    this.publish()
  }

  private publish(): void {
    if (this.closed) return
    this.deps.emit({ event: 'update_status', status: this.status() })
  }

  private electronFacts(): UpdateElectronFacts {
    const current = this.deps.host?.electronVersion ?? ''
    const latest = this.electronLatest
    const currentMajor = parseAppVersion(current)?.major
    const latestMajor = parseAppVersion(latest)?.major
    const behind =
      currentMajor !== undefined && latestMajor !== undefined
        ? Math.max(0, latestMajor - currentMajor)
        : null
    return { current, latest, behind, outdated: behind !== null && behind > 2 }
  }
}

function publicRelease(release: SelectedUpdate): UpdateStatus['available'] {
  return {
    version: release.version,
    tag: release.tag,
    channel: release.channel,
    name: release.name,
    publishedAt: release.publishedAt,
    notesUrl: release.notesUrl,
    asset: { ...release.asset },
  }
}

/**
 * Move a verified file into `folder` under its own name, or `name (1).dmg`
 * and so on when that is taken; never over an existing file. A hard link
 * is atomic and refuses an existing target; across volumes it is copied
 * (COPYFILE_EXCL).
 */
async function moveIntoFolder(file: string, folder: string): Promise<string> {
  await mkdir(folder, { recursive: true })
  await chmod(file, 0o644)
  const name = basename(file)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 0; n < 100; n += 1) {
    const target = join(folder, n === 0 ? name : `${stem} (${n})${ext}`)
    try {
      await link(file, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP')
        throw error
      try {
        await copyFile(file, target, constants.COPYFILE_EXCL)
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw copyError
      }
    }
    await unlink(file).catch(() => {})
    return target
  }
  throw new UpdateError(
    'update_download_missing',
    '下载文件夹里同名的文件太多，无法保存安装包。',
  )
}

export type { UpdateAttestation }
