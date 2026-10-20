/**
 * REL-01 in main/index.ts, held by its source (index.ts runs only inside
 * Electron; the e2e `--mode=diagnostics` drives the real thing).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8')

function indexOf(snippet: string): number {
  const at = source.indexOf(snippet)
  if (at < 0) throw new Error(`index.ts lacks ${snippet}`)
  return at
}

describe('main process logging wiring (REL-01)', () => {
  it('resolves the log folder from the Emperor Home before anything else logs', () => {
    expect(source).toMatch(
      /const logLocation = resolveLogLocation\(\{\s*stateRoot: config\.stateRoot,\s*stateRootSource: config\.stateRootSource,/,
    )
    // main.log opens, console output is copied into it, Core logs to core.log.
    expect(indexOf('const mainLog = createAppLog(')).toBeGreaterThan(
      indexOf('const logLocation = resolveLogLocation('),
    )
    expect(source).toContain('teeConsole(console, mainLog)')
    expect(source).toMatch(/setCoreLogSink\(\(line\) =>\s*coreLog\./)
    expect(source).toContain('app.setAppLogsPath(logLocation.dir)')
  })

  it('starts Crashpad locally (no upload) before the app is ready', () => {
    expect(source).toMatch(
      /startCrashReporting\(\{\s*dir: logLocation\.crashDumps,\s*app,\s*crashReporter,/,
    )
    expect(indexOf('startCrashReporting({')).toBeLessThan(
      indexOf('app.whenReady()'),
    )
  })

  it('logs uncaught errors and crashed child processes instead of dying', () => {
    expect(source).toMatch(
      /installProcessErrorHandlers\(\{\s*process,\s*log: mainLog/,
    )
    expect(source).toContain("app.on('render-process-gone'")
    expect(source).toContain("app.on('child-process-gone'")
  })

  it('writes the full cause of a startup failure, then shows the recovery page', () => {
    const recovery = source.slice(
      indexOf('async function showBootstrapRecovery('),
    )
    expect(recovery).toMatch(
      /mainLog\.error\('Emperor startup failed', \{ error \}\)/,
    )
    expect(recovery).not.toContain('console.error(`Emperor startup failed')
    expect(recovery).toContain('openLogs: () =>')
    expect(recovery).toContain('diagnostics: {')
  })

  it('offers the bundle to the trusted main window only', () => {
    expect(source).toMatch(
      /registerDiagnosticsBundleIpc\(\{\s*ipcMain,\s*authorize: \(event\) => trustedRendererPolicy\.authorizeIpc\(event\)/,
    )
  })
})
