/**
 * 设置 › 高级 › 存储 (KRN-12): category names, sizes and the 「清理」 result
 * line. Core reports allocated bytes (`du`'s measure) per category in a
 * fixed order (`storage.usage`), and what its retention sweep removed
 * (`storage.clean`).
 */
import type { CoreOperationResult } from '@emperor/core/api'

export type StorageUsage = CoreOperationResult<'storage.usage'>
export type StorageCategoryId = StorageUsage['categories'][number]['id']
export type StorageCleanReport = CoreOperationResult<'storage.clean'>['report']

export const STORAGE_CATEGORY_TEXT: Record<
  StorageCategoryId,
  { title: string; description: string }
> = {
  sessions: {
    title: '会话',
    description: '对话记录、子智能体的会话，以及「最近删除」里的会话',
  },
  attachments: {
    title: '附件',
    description: '对话里添加的图片、文件与媒体',
  },
  spill: {
    title: '溢出文件',
    description: '工具输出过长时保存下来的完整结果',
  },
  memoryVersions: {
    title: '记忆版本',
    description: '记忆文件的历史版本，用于查看差异和恢复',
  },
  ledger: {
    title: '用量账本',
    description: '每次模型调用的用量记录与按月归档',
  },
  delegations: {
    title: '委派',
    description: 'Claude Code、Codex 等外部子智能体的隔离目录、回执与成果',
  },
  other: {
    title: '其他',
    description: '环境工具、插件、浏览器数据与各项设置',
  },
}

const UNITS = ['KB', 'MB', 'GB', 'TB']

/** `0 B`, `512 B`, `1.5 KB`, `12.3 MB`, `1.25 GB`. */
export function formatStorageBytes(bytes: number): string {
  let value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${Math.round(value)} B`
  let unit = -1
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit >= 2 ? 2 : 1
  return `${Number(value.toFixed(digits))} ${UNITS[unit]}`
}

/** What 「清理」 freed, naming only the parts that freed something. */
export function cleanSummary(report: StorageCleanReport): string {
  const parts = [
    [report.sessions.removed, '最近删除的会话', '个'],
    [report.spill.removed, '溢出文件', '项'],
    [report.memoryVersions.removed, '记忆版本', '个'],
    [report.delegations.removed, '委派目录', '项'],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label, unit]) => `${label} ${count} ${unit}`)
  const freed =
    report.freedBytes > 0 && parts.length > 0
      ? `已释放 ${formatStorageBytes(report.freedBytes)}：${parts.join('、')}。`
      : '没有需要清理的文件。'
  return report.errors.length > 0
    ? `${freed}另有 ${report.errors.length} 类文件没能清理，稍后会再试。`
    : freed
}
