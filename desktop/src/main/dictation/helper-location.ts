/** Where the dictation helper lives, and the check before its first launch. */
import { join, resolve } from 'node:path'
import {
  macosNativeArch,
  signedIdentity,
  type MacosHelperInstallSystem,
} from '../computer-use/macos-launcher'

export const DICTATION_HELPER_APP = 'Emperor Dictation Helper.app'
export const DICTATION_HELPER_EXECUTABLE = 'emperor-dictation-helper'
export const DICTATION_HELPER_IDENTIFIER =
  'com.emperor.agent.desktop.dictation-helper'

/**
 * Packaged: `Contents/Library/Helpers` of the app, run in place as Emperor's
 * child. Development: the build of `native/macos/scripts/assemble-dictation-app.sh`.
 */
export function dictationHelperAppPath(options: {
  readonly packaged: boolean
  readonly resourcesPath?: string
  readonly desktopRoot?: string
  readonly arch?: string
}): string {
  if (options.packaged) {
    if (!options.resourcesPath)
      throw new Error('Missing packaged resources path')
    return resolve(
      options.resourcesPath,
      '..',
      'Library',
      'Helpers',
      DICTATION_HELPER_APP,
    )
  }
  if (!options.desktopRoot) throw new Error('Missing desktop source root')
  return resolve(
    options.desktopRoot,
    'native',
    'macos',
    'build',
    macosNativeArch(options.arch ?? process.arch),
    DICTATION_HELPER_APP,
  )
}

export function dictationHelperExecutable(appPath: string): string {
  return join(appPath, 'Contents', 'MacOS', DICTATION_HELPER_EXECUTABLE)
}

/**
 * The helper must carry a valid signature naming the dictation helper, from
 * the same signer as Emperor itself: both ad hoc, or the same team.
 */
export async function verifyDictationHelper(
  helperApp: string,
  mainApp: string,
  system?: MacosHelperInstallSystem,
): Promise<void> {
  const [helper, main] = await Promise.all([
    signedIdentity(helperApp, system),
    signedIdentity(mainApp, system),
  ])
  if (helper.identifier !== DICTATION_HELPER_IDENTIFIER)
    throw new Error('Unexpected dictation helper identity')
  if (helper.adHoc !== main.adHoc || helper.team !== main.team)
    throw new Error('Dictation helper is signed by someone else')
}
