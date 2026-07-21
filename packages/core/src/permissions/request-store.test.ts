import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PermissionRequestStore,
  type PermissionRequestRecord,
} from './request-store'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-permission-requests-'))
}

function request(
  overrides: Partial<PermissionRequestRecord> = {},
): PermissionRequestRecord {
  return {
    version: 1,
    id: 'permission_request_1',
    interactionId: 'ask_1',
    sessionId: 'session_a',
    status: 'waiting',
    outcome: null,
    createdAt: 1_000,
    expiresAt: 31_000,
    operations: [
      {
        id: 'operation_1',
        fingerprint: 'fingerprint_a',
        toolName: 'delete_file',
        argumentsHash: 'hash_a',
        remainingUses: 1,
        risk: 'high',
        rule: 'smart_auto.destructive_file',
        trace: [],
        explanation: null,
      },
    ],
    ...overrides,
  }
}

describe('PermissionRequestStore', () => {
  it('persists approved requests privately and consumes an exact ordered sequence once', () => {
    const stateRoot = root()
    const store = new PermissionRequestStore(stateRoot, { now: () => 2_000 })
    store.create(
      request({
        operations: [
          {
            ...request().operations[0]!,
            remainingUses: 2,
          },
        ],
      }),
    )
    store.resolve('permission_request_1', 'allow_once')

    expect(statSync(store.file).mode & 0o777).toBe(0o600)
    expect(
      store.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_a',
        'fingerprint_a',
      ]),
    ).toBe('allow')
    expect(store.get('permission_request_1')?.status).toBe('consumed')
    expect(
      store.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_a',
      ]),
    ).toBe('miss')
  })

  it('binds authorization to operation order as well as multiplicity', () => {
    const store = new PermissionRequestStore(root(), { now: () => 2_000 })
    store.create(
      request({
        operations: [
          request().operations[0]!,
          {
            ...request().operations[0]!,
            id: 'operation_2',
            fingerprint: 'fingerprint_b',
            argumentsHash: 'hash_b',
          },
        ],
      }),
    )
    store.resolve('permission_request_1', 'allow_once')

    expect(
      store.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_b',
        'fingerprint_a',
      ]),
    ).toBe('miss')
    expect(
      store.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_a',
        'fingerprint_b',
      ]),
    ).toBe('allow')
  })

  it('survives restart but rejects changed operations and cross-session use', () => {
    const stateRoot = root()
    const first = new PermissionRequestStore(stateRoot, { now: () => 2_000 })
    first.create(request())
    first.resolve('permission_request_1', 'allow_once')

    const restarted = new PermissionRequestStore(stateRoot, {
      now: () => 3_000,
    })
    expect(
      restarted.consumeExact('permission_request_1', 'session_b', [
        'fingerprint_a',
      ]),
    ).toBe('miss')
    expect(
      restarted.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_changed',
      ]),
    ).toBe('miss')
    expect(
      restarted.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_a',
      ]),
    ).toBe('allow')
  })

  it('returns an exact denial without authorizing the operation', () => {
    const store = new PermissionRequestStore(root(), { now: () => 2_000 })
    store.create(request())
    store.resolve('permission_request_1', 'deny')

    expect(
      store.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_a',
      ]),
    ).toBe('deny')
    expect(store.get('permission_request_1')?.status).toBe('denied')
  })

  it('fails closed after expiry and cleans expired records', () => {
    const stateRoot = root()
    const initial = new PermissionRequestStore(stateRoot, { now: () => 2_000 })
    initial.create(request())
    initial.resolve('permission_request_1', 'allow_once')
    const store = new PermissionRequestStore(stateRoot, { now: () => 50_000 })

    expect(
      store.consumeExact('permission_request_1', 'session_a', [
        'fingerprint_a',
      ]),
    ).toBe('miss')
    expect(store.get('permission_request_1')).toBeNull()
  })
})
