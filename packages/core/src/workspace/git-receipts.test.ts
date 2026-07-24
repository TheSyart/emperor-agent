import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitOperationReceiptStore } from './git-receipts'

describe('GitOperationReceiptStore', () => {
  it('persists renderer-safe receipts without commands or credentials', () => {
    const store = new GitOperationReceiptStore(
      mkdtempSync(join(tmpdir(), 'emperor-git-receipts-')),
    )
    store.append('session-1', {
      action: 'push',
      branch: 'main',
      remoteHost: 'github.com',
      completedAt: 42,
    })

    expect(store.list('session-1')).toEqual([
      {
        action: 'push',
        branch: 'main',
        remoteHost: 'github.com',
        completedAt: 42,
      },
    ])
    expect(JSON.stringify(store.list('session-1'))).not.toMatch(
      /command|token|environment/i,
    )
  })
})
