import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * Whether 「用默认应用打开」 may hand a file to its default app (BUG-10):
 * never something that runs when opened — a program, a script, an
 * installer or disk image, an automation, a link that opens elsewhere, a
 * configuration profile, anything inside a bundle, or any file with an
 * executable bit. Those only get 「在访达中显示」. Core marks previews with
 * it (`openable`); Electron main checks again right before shell.openPath.
 */

const RUNS_WHEN_OPENED = new Set([
  // Programs, bundles and installers.
  'app',
  'appex',
  'bundle',
  'framework',
  'plugin',
  'kext',
  'prefpane',
  'xpc',
  'qlgenerator',
  'mdimporter',
  'saver',
  'osax',
  'pkg',
  'mpkg',
  'dmg',
  'sparseimage',
  'iso',
  'mobileconfig',
  'configprofile',
  // Scripts and automations.
  'command',
  'tool',
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'ksh',
  'tcsh',
  'terminal',
  'scpt',
  'scptd',
  'applescript',
  'workflow',
  'action',
  'shortcut',
  'py',
  'pyw',
  'rb',
  'pl',
  'jar',
  'jnlp',
  // Windows programs, should one be opened by a compatibility layer.
  'exe',
  'msi',
  'bat',
  'cmd',
  'com',
  'ps1',
  'vbs',
  'scr',
  // Links that open somewhere else.
  'webloc',
  'inetloc',
  'fileloc',
  'url',
])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase() : ''
}

export function isOpenableFile(path: string): boolean {
  if (RUNS_WHEN_OPENED.has(extensionOf(basename(path)))) return false
  // Anything inside an application or another bundle.
  for (let parent = dirname(path); parent !== dirname(parent);) {
    if (RUNS_WHEN_OPENED.has(extensionOf(basename(parent)))) return false
    parent = dirname(parent)
  }
  try {
    const metadata = statSync(path)
    return metadata.isFile() && (metadata.mode & 0o111) === 0
  } catch {
    return false
  }
}
