/**
 * Local crash dumps (REL-01): Crashpad writes a minidump for a crashed
 * main, renderer, GPU or utility process into the log folder's `Crashpad`,
 * and never uploads one (Emperor has no crash server). Called before the
 * app is ready, so every renderer is covered.
 */
import * as fs from 'node:fs'

interface CrashReporterLike {
  start(options: {
    productName: string
    uploadToServer: boolean
    ignoreSystemCrashHandler: boolean
    compress: boolean
  }): void
}

export function startCrashReporting(input: {
  dir: string
  app: { setPath(name: 'crashDumps', value: string): void }
  crashReporter: CrashReporterLike
}): { ok: true } | { ok: false; error: string } {
  try {
    fs.mkdirSync(input.dir, { recursive: true, mode: 0o700 })
    input.app.setPath('crashDumps', input.dir)
    input.crashReporter.start({
      productName: 'Emperor Agent',
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
      compress: true,
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
