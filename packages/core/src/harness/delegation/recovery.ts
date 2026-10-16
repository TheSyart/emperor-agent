import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DelegationJournal } from './journal'
import type { DelegationState } from './fold'
import { DelegationError } from './types'
export interface RecoveryReport {
  loaded: string[]
  issues: { id: string; code: string }[]
}
/** Startup reconciliation reads host facts only. It never submits a provider prompt. */
export class DelegationRecovery {
  constructor(
    private readonly options: {
      root: string
      attach: (
        journal: DelegationJournal,
        state: DelegationState,
      ) => Promise<void>
    },
  ) {}
  async reconcile(): Promise<RecoveryReport> {
    const report: RecoveryReport = { loaded: [], issues: [] },
      dir = join(this.options.root, 'conversations')
    if (!existsSync(dir)) return report
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || !entry.name.startsWith('dlg-')) continue
      try {
        const journal = new DelegationJournal(this.options.root, entry.name),
          state = journal.load()
        if (!state.record || state.record.id !== entry.name)
          throw new DelegationError(
            'JOURNAL_CORRUPT',
            'conversation identity mismatch',
          )
        await this.options.attach(journal, state)
        report.loaded.push(entry.name)
      } catch (error) {
        report.issues.push({
          id: entry.name,
          code:
            error instanceof DelegationError ? error.code : 'RECOVERY_FAILED',
        })
      }
    }
    return report
  }
}
