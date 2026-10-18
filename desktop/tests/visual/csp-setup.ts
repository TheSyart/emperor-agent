import { clearCspReports } from './csp-reports'

/** Start every visual run with an empty CSP report file. */
export default function globalSetup(): void {
  clearCspReports()
}
