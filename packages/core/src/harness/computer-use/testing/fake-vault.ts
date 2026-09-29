/** An in-memory credential vault for tests: handles out, secrets kept here. */

import type { CredentialVaultPort } from '../port'
import type { CredentialField, CredentialHandle } from '../types'

export interface FakeCredential {
  readonly handle: CredentialHandle
  readonly secrets: Partial<Record<CredentialField, string>>
}

export class FakeCredentialVault implements CredentialVaultPort {
  locked = false
  available = true
  readonly entries: FakeCredential[]

  constructor(entries: FakeCredential[] = FAKE_CREDENTIALS) {
    this.entries = [...entries]
  }

  list(): CredentialHandle[] {
    return this.entries.map((entry) => entry.handle)
  }

  /** What the host process would decrypt at fill time. */
  reveal(handleId: string, field: CredentialField): string | undefined {
    return this.entries.find((entry) => entry.handle.handleId === handleId)
      ?.secrets[field]
  }
}

/** A fixture login for https://fixture.test (auto) and one confirm-each-time. */
export const FAKE_CREDENTIALS: FakeCredential[] = [
  {
    handle: {
      handleId: 'cred_000000000000000000000001',
      label: 'Fixture 账号',
      bindings: [{ kind: 'origin', origin: 'https://fixture.test' }],
      username: 'zhangsan',
      fields: ['username', 'password'],
      fillMode: 'auto',
    },
    secrets: { username: 'zhangsan', password: 'hunter2-SECRET-do-not-log' },
  },
  {
    handle: {
      handleId: 'cred_000000000000000000000002',
      label: '银行',
      bindings: [{ kind: 'origin', origin: 'https://fixture.test' }],
      fields: ['password', 'totp'],
      fillMode: 'confirm',
    },
    secrets: { password: 'bank-SECRET-do-not-log', totp: 'JBSWY3DPEHPK3PXP' },
  },
]
