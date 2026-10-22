export interface ProcessExitReceipt {
  pid: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** The run's process group is empty (AGT-04: no per-descendant proof). */
  quiescent: boolean
  failureCode?: string
  /** Diagnostics mode: processes outside the group still holding the run's boundary, stopped at exit. */
  escaped?: number
}

export interface OwnedProcessIdentity {
  /** The root process; it leads its own process group (pgid = pid). */
  pid: number | null
  startedAt: number
  /** `ps lstart` in the C locale; empty when it could not be read. */
  fingerprint: string
  /** System boot marker when the process started; another value means it cannot still run. */
  bootTime?: string
  /** Diagnostics mode only: Seatbelt boundary markers for the native scanner. */
  boundary?: { tag: string; scannerPath: string }
}
/** Recorded by builds before AGT-04; read for recovery, never written now. */
export interface OwnedDescendant {
  pid: number
  fingerprint: string
}
export interface ProcessOwnership extends OwnedProcessIdentity {
  purpose?: 'inference' | 'inspection' | 'verification'
  parentRunId?: string
  schemaVersion: 1
  delegationId: string
  runId: string
  generation: number
  boundaryReceiptId: string
  policyDigest: string
  cwd: string
  platform: NodeJS.Platform
  descendants: OwnedDescendant[]
  exit?: ProcessExitReceipt
}
