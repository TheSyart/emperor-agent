import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync } from '../../store/persistence'
import type { SecretSealer } from '../../security/secret-sealer'

export type ClaudeTokenKind = 'oauth-token' | 'api-key'
export interface ClaudeTokenStatus {
  kind: ClaudeTokenKind
  last4: string
  savedAt: number
}
interface TokenRow extends ClaudeTokenStatus {
  /** `el1:` envelope bound to the profile and kind. */
  value: string
}

/**
 * Tokens pasted into 设置 › 子智能体 (AGT-02), one per Claude profile, in
 * `<delegations>/credentials.json` (0600). Each value is sealed with the
 * local key Emperor uses for model keys and the credential vault
 * (LocalSecretStore, SEC-06/SEC-09); only the kind and the last four
 * characters are kept in the clear, for the settings page.
 */
export class ClaudeTokenStore {
  readonly file: string
  constructor(
    private readonly options: { root: string; sealer: SecretSealer },
  ) {
    this.file = join(options.root, 'credentials.json')
  }
  private rows(): Record<string, TokenRow> {
    if (!existsSync(this.file)) return {}
    const tokens = (
      JSON.parse(readFileSync(this.file, 'utf8')) as {
        tokens?: Record<string, TokenRow>
      }
    ).tokens
    return tokens && typeof tokens === 'object' ? tokens : {}
  }
  private row(profileId: string): TokenRow | undefined {
    const rows = this.rows()
    return Object.hasOwn(rows, profileId) ? rows[profileId] : undefined
  }
  private context(profileId: string, kind: ClaudeTokenKind) {
    return `delegations/credentials.json#${profileId}.${kind}`
  }
  status(profileId: string): ClaudeTokenStatus | null {
    try {
      const row = this.row(profileId)
      return row
        ? { kind: row.kind, last4: row.last4, savedAt: row.savedAt }
        : null
    } catch {
      return null
    }
  }
  /** Throws when the value cannot be opened (the local key changed). */
  read(profileId: string): { kind: ClaudeTokenKind; token: string } | null {
    const row = this.row(profileId)
    if (!row) return null
    return {
      kind: row.kind,
      token: this.options.sealer.open(
        row.value,
        this.context(profileId, row.kind),
      ),
    }
  }
  set(profileId: string, kind: ClaudeTokenKind, token: string) {
    const status = { kind, last4: token.slice(-4), savedAt: Date.now() }
    const value = this.options.sealer.seal(token, this.context(profileId, kind))
    this.save(profileId, { ...status, value })
    return status
  }
  clear(profileId: string): void {
    this.save(profileId, undefined)
  }
  private save(profileId: string, row: TokenRow | undefined) {
    let rows: Record<string, TokenRow>
    try {
      rows = this.rows()
    } catch {
      rows = {} // A damaged file holds nothing usable.
    }
    if (row) rows[profileId] = row
    else delete rows[profileId]
    durableReplaceSync(
      this.file,
      JSON.stringify({ schemaVersion: 1, tokens: rows }, null, 2) + '\n',
    )
  }
}
