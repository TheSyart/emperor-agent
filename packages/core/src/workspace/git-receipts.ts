import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export interface GitOperationReceipt {
  action:
    | 'commit'
    | 'push'
    | 'pull'
    | 'switch_branch'
    | 'create_worktree'
    | 'remove_worktree'
    | 'publish_pr'
    | 'merge_pr'
    | 'close_pr'
  branch?: string
  commitOid?: string
  remoteHost?: string
  pullRequest?: {
    number: number
    url: string
    state: string
  }
  completedAt: number
}

export class GitOperationReceiptStore {
  constructor(private readonly stateRoot: string) {}

  append(sessionId: string, receipt: GitOperationReceipt): void {
    const path = this.pathFor(sessionId)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(receipt)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(path, 0o600)
  }

  list(sessionId: string): GitOperationReceipt[] {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as GitOperationReceipt]
        } catch {
          return []
        }
      })
      .slice(-100)
  }

  private pathFor(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')
    return join(this.stateRoot, 'git', 'receipts', `${safe}.jsonl`)
  }
}
