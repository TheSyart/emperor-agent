/**
 * What 设置 › 常规 says about updates (REL-02): the status line under
 * 检查更新, the download progress, what the verification covered, and the
 * install steps after a verified download. Pure; the views read it.
 */
import type {
  UpdateAttestation,
  UpdateDownloadState,
  UpdateStatus,
} from '@emperor/core/runtime-contract'

/** 「拖入应用程序…」: the install steps shown with a verified DMG. */
export const UPDATE_INSTALL_STEPS: readonly string[] = [
  '退出 Emperor，把下载的 Emperor Agent 拖进「应用程序」文件夹，替换旧版本。',
  '第一次打开时 macOS 会拦下它：到「系统设置 › 隐私与安全性」，在安全性一栏点「仍要打开」。',
  '重新授权：电脑操作需要「辅助功能」和「屏幕录制」，听写需要「麦克风」和「语音识别」。',
]

export function megabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

function clock(at: number, now: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay
    ? `今天 ${time}`
    : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}

/** The line under 当前版本: what the last check found, or why there is none. */
export function updateStatusText(
  status: UpdateStatus,
  now: number = Date.now(),
): string {
  if (!status.automatic)
    return status.disabledReason === 'development'
      ? '开发版不检查更新'
      : '这个版本不检查更新'
  if (!status.enabled) return '已关闭：Emperor 不会联网查看新版本'
  if (status.checking) return '正在检查…'
  if (status.available) return `Emperor ${status.available.version} 可用`
  if (status.lastError)
    return `上次检查没有成功：${status.lastError.message} 稍后会自动重试。`
  if (status.lastCheckedAt !== null)
    return `已是最新版本 · 上次检查 ${clock(status.lastCheckedAt, now)}`
  return '启动 30 秒后检查'
}

/** 0–1 of the download, for the progress bar. */
export function downloadFraction(state: UpdateDownloadState): number {
  if (state.phase !== 'downloading' || state.totalBytes <= 0) return 0
  return Math.min(1, Math.max(0, state.receivedBytes / state.totalBytes))
}

export function downloadProgressText(state: UpdateDownloadState): string {
  if (state.phase === 'downloading')
    return `已下载 ${megabytes(state.receivedBytes)} / ${megabytes(state.totalBytes)}`
  if (state.phase === 'verifying')
    return state.step === 'checksum'
      ? '正在核对 SHA-256…'
      : '正在核验 GitHub 来源证明…'
  return ''
}

/** What the check of a ready download covered, in one sentence. */
export function attestationText(attestation: UpdateAttestation): string {
  switch (attestation.status) {
    case 'verified':
      return 'SHA-256 与 GitHub 来源证明都已核对。'
    case 'skipped':
      return '已核对 SHA-256。这是测试更新源，没有 GitHub 来源证明可以核验。'
    case 'unavailable':
      if (attestation.reason === 'gh_not_logged_in')
        return '已核对 SHA-256。GitHub CLI 还没有登录，没有核验 GitHub 来源证明；在终端运行 gh auth login 后重新下载即可核验。'
      if (attestation.reason === 'gh_failed')
        return `已核对 SHA-256。GitHub 来源证明这次没能核验${attestation.detail ? `（${attestation.detail}）` : ''}。`
      return '已核对 SHA-256。这台 Mac 没有可用的 GitHub CLI（gh），没有核验 GitHub 来源证明。'
  }
}
