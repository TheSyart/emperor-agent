/**
 * SEC-05: the visual suite runs under the renderer CSP (the dev server
 * sends it as a header with `report-uri`, src/shared/vite-csp-plugin.ts) and
 * fails when any page reported a violation. With
 * EMPEROR_CSP_REPORT_ONLY=1 the dev server only reports (collection run) and
 * this prints the list without failing.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Playwright runs from desktop/ (like visualBridge.ts's paths).
export const CSP_REPORT_FILE = resolve(
  process.cwd(),
  'out-e2e',
  'visual-csp-reports.jsonl',
)

export function clearCspReports(): void {
  mkdirSync(dirname(CSP_REPORT_FILE), { recursive: true })
  rmSync(CSP_REPORT_FILE, { force: true })
}

export function readCspReports(): Array<Record<string, unknown>> {
  let text = ''
  try {
    text = readFileSync(CSP_REPORT_FILE, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return { unreadable: line }
      }
    })
}

export function summarizeCspReports(
  reports: ReadonlyArray<Record<string, unknown>>,
): string {
  const counts = new Map<string, number>()
  for (const report of reports) {
    const key = `${String(report.directive)} ← ${String(report.blocked)} (${String(report.source ?? report.document)})`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `  ${count}× ${key}`)
    .join('\n')
}
