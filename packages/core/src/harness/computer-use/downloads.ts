/**
 * Download inbox rules shared by every browser driver (spec 00 §7.5):
 * executables and installers are refused by default, file names are made
 * safe for the inbox directory, and task ids become safe bucket names.
 */

import { createHash } from 'node:crypto'

const EXECUTABLE_EXTENSIONS = new Set([
  'app',
  'apk',
  'appimage',
  'appx',
  'bat',
  'bin',
  'cmd',
  'com',
  'command',
  'cpl',
  'deb',
  'dll',
  'dmg',
  'dylib',
  'exe',
  'gadget',
  'hta',
  'inf',
  'ipa',
  'jar',
  'jse',
  'lnk',
  'mpkg',
  'msi',
  'msix',
  'msp',
  'pif',
  'pkg',
  'ps1',
  'psm1',
  'reg',
  'rpm',
  'run',
  'scr',
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'so',
  'tool',
  'vb',
  'vbe',
  'vbs',
  'workflow',
  'ws',
  'wsf',
  'xpi',
  'crx',
])

const EXECUTABLE_MIME = [
  'application/x-apple-diskimage',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-msi',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-debian-package',
  'application/x-rpm',
  'application/vnd.apple.installer+xml',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/x-chrome-extension',
]

/** Whether a download looks like a program or installer (refused). */
export function isExecutableDownload(filename: string, mimeType = ''): boolean {
  // Windows and some tools drop trailing dots and spaces: `x.exe.` is `x.exe`.
  const lower = filename.toLowerCase().replace(/[.\s]+$/, '')
  const parts = lower.split('.')
  const extension = parts.length > 1 ? parts[parts.length - 1]! : ''
  if (EXECUTABLE_EXTENSIONS.has(extension)) return true
  const mime = mimeType.toLowerCase().split(';')[0]!.trim()
  return EXECUTABLE_MIME.includes(mime)
}

/**
 * A file name safe inside the inbox: no path, no control characters, no
 * leading dots, bounded length (keeping the extension).
 */
export function safeDownloadName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ''
  let clean = base
    .replace(/[<>:"|?*]/g, '_')
    .split('')
    .map((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '_' : char,
    )
    .join('')
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .trim()
  if (clean === '') clean = 'download'
  if (clean.length > 120) {
    const dot = clean.lastIndexOf('.')
    const extension =
      dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : ''
    clean = clean.slice(0, 120 - extension.length) + extension
  }
  return clean
}

/** A task id as an inbox directory name: readable prefix + short hash. */
export function downloadBucket(taskId: string): string {
  const readable = taskId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)
  const hash = createHash('sha256').update(taskId).digest('hex').slice(0, 8)
  return `${readable || 'task'}-${hash}`
}
