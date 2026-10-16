export interface ProcessExitReceipt {
  pid: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  quiescent: boolean
  failureCode?: string
}

export interface OwnedProcessIdentity {
  pid: number | null
  startedAt: number
  fingerprint: string
  boundary?: { tag: string; scannerPath: string }
}
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
