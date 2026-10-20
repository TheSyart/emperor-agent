/**
 * REL-03 at startup (kept tiny: App.vue loads it): an older Emperor than
 * last time gets a banner (a sticky notice with 「查看」 → 设置 › 高级 ›
 * 存储); the first start after a restore says so once.
 */
import type { CoreOperationResult } from '@emperor/core/api'
import type { ToastOptions } from './components/ui/toasts'

type Report = CoreOperationResult<'storage.versions'>
interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const SEEN_RESTORE = 'emperor.restore.seen'
const RESTORE_NOTICE_MS = 60 * 60_000

function day(iso: string | null): string {
  const date = iso ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime())
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : ''
}

export async function showDataNotices(deps: {
  load: () => Promise<Report>
  toast: (message: string, options: ToastOptions) => number
  openStorage: () => void
  storage?: KeyValue | null
  now?: () => number
}): Promise<void> {
  let report: Report
  try {
    report = await deps.load()
  } catch {
    return
  }
  if (report.downgradedFrom)
    deps.toast(
      `Emperor ${report.appVersion} 比上次打开的 ${report.downgradedFrom} 旧：新版本写入的文件只读，不会被改写。`,
      {
        tone: 'warn',
        sticky: true,
        action: { label: '查看', run: deps.openStorage },
      },
    )
  const restore = report.lastRestore
  const at = restore?.status === 'applied' ? Date.parse(restore.at) : NaN
  if (!(Math.abs((deps.now ?? Date.now)() - at) < RESTORE_NOTICE_MS)) return
  try {
    const storage =
      deps.storage === undefined ? globalThis.localStorage : deps.storage
    if (storage?.getItem(SEEN_RESTORE) === restore!.at) return
    storage?.setItem(SEEN_RESTORE, restore!.at)
  } catch {
    // Without storage the notice may show once more; that is all.
  }
  const made = day(restore!.backupCreatedAt)
  deps.toast(
    `已从备份恢复${made ? `（${made}的备份）` : ''}。恢复前的数据保存在 Emperor Home 的 ${restore!.backup ?? 'migrations'}。`,
    { tone: 'ok', durationMs: 10_000 },
  )
}
