/**
 * One Emperor per data directory (MAIN-5). On the default directory the
 * Electron single-instance lock makes a second launch hand over to the
 * first (which brings its window forward) and quit. An explicit
 * EMPEROR_CONFIG_DIR (tests, a second profile) or the packaged smoke is a
 * separate instance on purpose; the data-directory lock
 * (state-directory-lock.ts) still keeps two writers off one directory.
 */
export function claimSingleInstance(
  app: {
    requestSingleInstanceLock(): boolean
    on(event: 'second-instance', listener: () => void): unknown
  },
  options: { stateRootSource: string; packagedSmoke: boolean },
  focusExisting: () => void,
): boolean {
  if (options.packagedSmoke || options.stateRootSource !== 'default')
    return true
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', focusExisting)
  return true
}
