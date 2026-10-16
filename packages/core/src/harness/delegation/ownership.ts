import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync } from '../../store/persistence'
import { safeDelegationKey } from './fold'
import { DelegationError } from './types'
import type { ProcessOwnership, OwnedDescendant } from './process-types'
export type {
  OwnedProcessIdentity,
  OwnedDescendant,
  ProcessOwnership,
} from './process-types'
export function ownershipPath(root: string, runId: string): string {
  safeDelegationKey(runId)
  if (!runId.startsWith('dgr-'))
    throw new DelegationError('INVALID_ID', 'process run id required')
  return join(root, 'processes', runId + '.json')
}
export function saveOwnership(root: string, ownership: ProcessOwnership): void {
  durableReplaceSync(
    ownershipPath(root, ownership.runId),
    JSON.stringify(ownership) + '\n',
  )
}
export function loadOwnership(root: string, runId: string): ProcessOwnership {
  const value = JSON.parse(
    readFileSync(ownershipPath(root, runId), 'utf8'),
  ) as ProcessOwnership
  const identity = (x: OwnedDescendant) =>
    Number.isSafeInteger(x.pid) &&
    x.pid > 1 &&
    typeof x.fingerprint === 'string' &&
    x.fingerprint.length > 0 &&
    x.fingerprint.length < 256
  if (
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.delegationId !== 'string' ||
    typeof value.boundaryReceiptId !== 'string' ||
    typeof value.policyDigest !== 'string' ||
    typeof value.cwd !== 'string' ||
    !value.pid ||
    !identity({ pid: value.pid, fingerprint: value.fingerprint }) ||
    !Array.isArray(value.descendants) ||
    value.descendants.length > 1024 ||
    !value.descendants.every(identity)
  )
    throw new DelegationError(
      'OWNERSHIP_CORRUPT',
      'process ownership cannot be trusted',
    )
  return value
}
