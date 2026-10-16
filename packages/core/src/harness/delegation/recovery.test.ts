import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { DelegationRecovery } from './recovery'
import { DelegationJournal } from './journal'
import {
  delegationTestDirectory,
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from './testing'
it('loads stored identities without provider dispatch and isolates corrupt journals without deleting originals', async () => {
  const f = delegationTestDirectory(),
    journal = new DelegationJournal(f.root, 'dlg-test'),
    record = {
      ...fixtureDelegationRecord(),
      providerSessionId: 'original-session',
    }
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'message-enqueued',
    message: { id: 'dgm-1', text: 'charged operation', status: 'sending' },
  })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  const corrupt = join(f.root, 'conversations', 'dlg-corrupt', 'journal.jsonl')
  mkdirSync(join(f.root, 'conversations', 'dlg-corrupt'), { recursive: true })
  writeFileSync(corrupt, 'future schema\n')
  const attach = vi.fn(
      async (
        _journal: DelegationJournal,
        _state: import('./fold').DelegationState,
      ) => {},
    ),
    recovery = new DelegationRecovery({ root: f.root, attach })
  const result = await recovery.reconcile()
  expect(result.loaded).toEqual(['dlg-test'])
  expect(result.issues).toContainEqual({
    id: 'dlg-corrupt',
    code: 'JOURNAL_CORRUPT',
  })
  expect(attach).toHaveBeenCalledTimes(1)
  expect(attach.mock.calls[0]?.[1].record?.providerSessionId).toBe(
    'original-session',
  )
  expect(existsSync(corrupt)).toBe(true)
  expect(readFileSync(corrupt, 'utf8')).toBe('future schema\n')
  f.cleanup()
})
it('an empty home reconciles without creating executable work', async () => {
  const f = delegationTestDirectory(),
    attach = vi.fn(async () => {})
  expect(
    await new DelegationRecovery({ root: f.root, attach }).reconcile(),
  ).toEqual({ loaded: [], issues: [] })
  expect(attach).not.toHaveBeenCalled()
  f.cleanup()
})
