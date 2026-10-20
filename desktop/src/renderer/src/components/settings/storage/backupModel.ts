/**
 * 设置 › 高级 › 存储 › 备份与恢复 and the read-only files (REL-03): words
 * for what Core (`storage.versions`) and main (the backup) report.
 */
import type { CoreOperationResult } from '@emperor/core/api'
import { vaultErrorText } from '../browser/credentialVaultModel'

export type DataVersions = CoreOperationResult<'storage.versions'>
export type DataFileState = DataVersions['files'][number]

export const NEWER_FILE_TEXT = '这个文件来自更新版本的 Emperor，当前版本只读'

/** The files a newer Emperor wrote (read here, never rewritten). */
export function newerFiles(report: DataVersions | null): DataFileState[] {
  return (report?.files ?? []).filter((file) => file.state === 'newer')
}

/** The notice for them: one file, or several. */
export function newerFilesNotice(files: readonly DataFileState[]): {
  title: string
  description: string
} {
  const names = files.map((file) => `${file.path}（${file.label}）`).join('、')
  return {
    title:
      files.length === 1
        ? NEWER_FILE_TEXT
        : `这 ${files.length} 个文件来自更新版本的 Emperor，当前版本只读`,
    description: `${names}。Emperor 照常读取，但不会改写或移走它们；改动需要更新版本的 Emperor。`,
  }
}

/** What each part of a backup is called (main sends the ids). */
export const BACKUP_CATEGORY_TITLES: Record<string, string> = {
  config: '设置与配置',
  memory: '记忆',
  extensions: 'Skills、插件与智能体',
  projects: '项目与定时任务',
  sessions: '会话',
}

/** 「2026年10月19日 16:00」 in the user's time zone. */
export function backupTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** A vault failure in the password manager's words, else the message. */
export function backupErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.includes('[credential-vault:')
    ? vaultErrorText(cause)
    : message
}

export const MIN_PASSPHRASE = 12

/** Why the passphrase cannot be used yet, or '' when it can. */
export function passphraseProblem(
  passphrase: string,
  confirmation: string,
): string {
  if (passphrase.length < MIN_PASSPHRASE) return '备份口令至少需要 12 个字符。'
  if (passphrase !== confirmation) return '两次输入的口令不一致。'
  return ''
}
