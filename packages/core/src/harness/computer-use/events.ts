/**
 * Computer Use session events (spec 00 §10.1) and crash repair (§10.2).
 *
 * Journal rule: `ui/action-prepared` is written before a driver is asked to
 * act, `ui/action-dispatched` right before the first side effect, and
 * `ui/action-settled` once the outcome is known. Repair never replays an
 * action: a dispatched action without an outcome becomes `unknown`.
 *
 * Text typed into pages is never copied here — `fill` / `typeText` keep only
 * the length and SHA-256 (the text already sits in `tool/call`).
 */

import { createHash } from 'node:crypto'
import type { RepairContributor } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type {
  ActionOutcome,
  ControlState,
  CredentialField,
  DriverKind,
  GrantDisplayInput,
  RedactedUiAction,
  TargetKind,
  UiAction,
  UiActionClass,
  UiGrantScope,
  UiTargetScope,
  DownloadState,
} from './types'

export type TargetClosedReason =
  'user' | 'agent' | 'lost' | 'revoked' | 'shutdown'
export type GrantDecision = UiGrantScope | 'denied'
export type GrantDecisionCause =
  'user' | 'cancelled' | 'unavailable' | 'invalid' | 'repair' | 'kill-switch'

declare module '../../session-log/types' {
  interface SessionEventMap {
    'ui/target-opened': {
      targetId: string
      kind: TargetKind
      driver: DriverKind
      generation: number
      profileId?: string
      appId?: string
      title?: string
      origin?: string
    }
    'ui/target-closed': { targetId: string; reason: TargetClosedReason }
    'ui/grant-requested': {
      requestId: string
      subject: string
      driver: DriverKind
      targetScope: UiTargetScope
      actions: UiActionClass[]
      allowedScopes: UiGrantScope[]
      reason?: string
      callId?: string
      toolName?: string
      /** What the card shows: the full URL or the app/window name. */
      display?: {
        url?: string
        title?: string
        appName?: string
        embeddedIn?: string
        /** Keyboard input the card asks about (never a secret). */
        input?: GrantDisplayInput
      }
      highImpact?: boolean
      highRiskApp?: boolean
      background?: boolean
    }
    'ui/grant-decided': {
      requestId: string
      decision: GrantDecision
      grantId?: string
      expiresAt?: string
      /** Timed grants: the chosen duration. */
      minutes?: number
      backgroundAllowed?: boolean
      cause?: GrantDecisionCause
    }
    'ui/grant-revoked': {
      grantId: string
      by: 'user' | 'expiry' | 'kill-switch'
    }
    'ui/grant-delegated': {
      grantId: string
      sourceGrantId: string
      childId: string
      actions: UiActionClass[]
      targetScope: UiTargetScope
    }
    'ui/action-prepared': {
      operationId: string
      callId: string
      targetId: string
      action: RedactedUiAction
      expectedRevision: number
      actionClass?: UiActionClass
      grantId?: string
    }
    'ui/action-dispatched': { operationId: string }
    'ui/action-settled': {
      operationId: string
      outcome: ActionOutcome
      afterRevision?: number
      errorCode?: string
    }
    'ui/control-state': { targetId?: string; state: ControlState }
    /** An action auto-approved by the persisted Computer Use mode. */
    'ui/auto-approved': {
      operationId: string
      preset: 'danger-full-access' | 'computer-use-unrestricted'
      actionClass: UiActionClass
    }
    /** Credential autofill; never carries a value. */
    'ui/credential-used': {
      operationId: string
      handleId: string
      targetId: string
      bindingMatched: string
      field: CredentialField
    }
    /** A download into the inbox finished (or was refused). No file content. */
    'ui/download': {
      operationId: string
      targetId: string
      downloadId: string
      state: DownloadState
      filename: string
      bytes: number
      sha256?: string
      /** Origin of the download URL. */
      origin?: string
      /** The download URL (bounded). */
      url?: string
      mimeType?: string
      /** Origin of the page that started the download. */
      pageOrigin?: string
    }
    /** Files the user picked were put into a file input. Names only. */
    'ui/upload': {
      operationId: string
      targetId: string
      files: string[]
      bytes: number
    }
  }
}

function digest(text: string): { textLength: number; textSha256: string } {
  return {
    textLength: text.length,
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}

/** The journal form of an action: typed text is reduced to length + hash. */
export function redactAction(action: UiAction): RedactedUiAction {
  switch (action.kind) {
    case 'fill':
    case 'appendText':
      return { kind: action.kind, ref: action.ref, ...digest(action.text) }
    case 'typeText':
      return {
        kind: 'typeText',
        ...(action.ref === undefined ? {} : { ref: action.ref }),
        ...digest(action.text),
      }
    default:
      return action
  }
}

type Repair = Omit<SessionEvent, 'seq' | 'time'>

/**
 * §10.2 crash repair:
 * - prepared, never dispatched → settled `cancelled`
 * - dispatched, never settled → settled `unknown` (never replayed)
 * - grant asked, never decided → decided `denied` (fail closed)
 * - target opened, never closed → closed `shutdown`
 */
export const computerUseRepair: RepairContributor = (events) => {
  const prepared = new Map<string, true>()
  const dispatched = new Map<string, true>()
  const grants = new Map<string, true>()
  const targets = new Map<string, true>()
  for (const event of events) {
    switch (event.type) {
      case 'ui/action-prepared':
        prepared.set(event.data.operationId, true)
        break
      case 'ui/action-dispatched':
        prepared.delete(event.data.operationId)
        dispatched.set(event.data.operationId, true)
        break
      case 'ui/action-settled':
        prepared.delete(event.data.operationId)
        dispatched.delete(event.data.operationId)
        break
      case 'ui/grant-requested':
        grants.set(event.data.requestId, true)
        break
      case 'ui/grant-decided':
        grants.delete(event.data.requestId)
        break
      case 'ui/target-opened':
        targets.set(event.data.targetId, true)
        break
      case 'ui/target-closed':
        targets.delete(event.data.targetId)
        break
      default:
        break
    }
  }
  const out: Repair[] = []
  for (const operationId of prepared.keys())
    out.push({
      type: 'ui/action-settled',
      data: { operationId, outcome: 'cancelled', errorCode: 'INTERRUPTED' },
    } as Repair)
  for (const operationId of dispatched.keys())
    out.push({
      type: 'ui/action-settled',
      data: { operationId, outcome: 'unknown', errorCode: 'OUTCOME_UNKNOWN' },
    } as Repair)
  for (const requestId of grants.keys())
    out.push({
      type: 'ui/grant-decided',
      data: { requestId, decision: 'denied', cause: 'repair' },
    } as Repair)
  for (const targetId of targets.keys())
    out.push({
      type: 'ui/target-closed',
      data: { targetId, reason: 'shutdown' },
    } as Repair)
  return out
}
