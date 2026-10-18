import { readCspReports, summarizeCspReports } from './csp-reports'

/**
 * Fail the visual run when a page broke the renderer CSP (SEC-05); report
 * only in a collection run (EMPEROR_CSP_REPORT_ONLY=1).
 */
export default async function globalTeardown(): Promise<void> {
  // Reports are sent asynchronously by the browser; give the last ones time.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const reports = readCspReports()
  if (!reports.length) {
    console.log('CSP: no violation reported by the visual suite')
    return
  }
  const summary = summarizeCspReports(reports)
  if (process.env.EMPEROR_CSP_REPORT_ONLY === '1') {
    console.log(`CSP (report-only): ${reports.length} violations\n${summary}`)
    return
  }
  throw new Error(
    `the visual suite broke the renderer CSP ${reports.length} times:\n${summary}`,
  )
}
