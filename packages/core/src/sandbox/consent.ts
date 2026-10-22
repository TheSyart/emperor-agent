/**
 * The user's answers for running a process outside an unavailable sandbox
 * (SEC-08, fallback `ask-user`). Only the user's own MCP servers may ask;
 * the answer is remembered per server and command, so a changed command is
 * asked again. A server with no answer yet is not started: it waits in
 * {@link UnsandboxedConsentRegistry.pending} until the host has asked the
 * user (the approval card of the next conversation step).
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync } from '../store/persistence/sync-io'

export const UNSANDBOXED_CONSENT_FILE = 'unsandboxed-consent.v1.json'

export interface UnsandboxedRequest {
  readonly kind: 'mcp'
  /** The server's name in mcp_config.json. */
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string | null
  /** Why the sandbox cannot run (shown to the user). */
  readonly reason: string
}

export type UnsandboxedAnswer = 'allowed' | 'denied' | 'pending'

/** Decides one request: the remembered answer, or `pending` until the user answered. */
export interface UnsandboxedConsentPort {
  decide(request: UnsandboxedRequest): Promise<UnsandboxedAnswer>
}

type Decision = 'allowed' | 'denied'

interface StoredDecision {
  readonly decision: Decision
  readonly fingerprint: string
  readonly decidedAt: string
}

function keyOf(request: Pick<UnsandboxedRequest, 'kind' | 'name'>): string {
  return `${request.kind}:${request.name}`
}

/** What the answer is bound to: the command, its arguments and folder. */
export function unsandboxedFingerprint(
  request: Pick<UnsandboxedRequest, 'command' | 'args' | 'cwd'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([request.command, [...request.args], request.cwd ?? null]),
    )
    .digest('hex')
}

export class UnsandboxedConsentRegistry implements UnsandboxedConsentPort {
  readonly file: string
  private readonly waiting = new Map<string, UnsandboxedRequest>()
  private listener: (() => void) | null = null

  constructor(stateRoot: string) {
    this.file = join(stateRoot, 'processes', UNSANDBOXED_CONSENT_FILE)
  }

  async decide(request: UnsandboxedRequest): Promise<UnsandboxedAnswer> {
    const stored = this.read()[keyOf(request)]
    if (stored && stored.fingerprint === unsandboxedFingerprint(request))
      return stored.decision
    this.waiting.set(keyOf(request), { ...request, args: [...request.args] })
    this.listener?.()
    return 'pending'
  }

  /** Requests nobody has answered yet, in arrival order. */
  pending(): UnsandboxedRequest[] {
    return [...this.waiting.values()]
  }

  /** Called whenever a new request starts waiting. */
  onPending(listener: (() => void) | null): void {
    this.listener = listener
  }

  /** Remember the user's answer for this server and command. */
  resolve(request: UnsandboxedRequest, decision: Decision): void {
    const decisions = this.read()
    decisions[keyOf(request)] = {
      decision,
      fingerprint: unsandboxedFingerprint(request),
      decidedAt: new Date().toISOString(),
    }
    durableReplaceSync(
      this.file,
      `${JSON.stringify({ schemaVersion: 1, decisions }, null, 2)}\n`,
    )
    this.waiting.delete(keyOf(request))
  }

  private read(): Record<string, StoredDecision> {
    try {
      if (!existsSync(this.file)) return {}
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as {
        schemaVersion?: unknown
        decisions?: unknown
      }
      if (
        value.schemaVersion !== 1 ||
        !value.decisions ||
        typeof value.decisions !== 'object'
      )
        return {}
      const out: Record<string, StoredDecision> = {}
      for (const [key, item] of Object.entries(
        value.decisions as Record<string, Partial<StoredDecision>>,
      ))
        if (
          (item?.decision === 'allowed' || item?.decision === 'denied') &&
          typeof item.fingerprint === 'string'
        )
          out[key] = {
            decision: item.decision,
            fingerprint: item.fingerprint,
            decidedAt: String(item.decidedAt ?? ''),
          }
      return out
    } catch {
      // Unreadable means not decided: the user is asked again.
      return {}
    }
  }
}
