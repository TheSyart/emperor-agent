import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExecutorAdapter,
  ExecutorOpenInput,
  ExecutorSession,
  ExecutorTurnInput,
  NormalizedExecutorEvent,
  ExternalBackend,
} from './types'

/** Scripted protocol boundary for control tests; never substitutes provider acceptance. */
export class FakeExecutorAdapter implements ExecutorAdapter {
  readonly opened: ExecutorOpenInput[] = []
  readonly submitted: ExecutorTurnInput[] = []
  readonly sessions: ExecutorSession[] = []
  constructor(
    readonly backend: ExternalBackend,
    private readonly script: (
      input: ExecutorTurnInput,
      open: ExecutorOpenInput,
    ) => AsyncIterable<NormalizedExecutorEvent>,
  ) {}
  async open(input: ExecutorOpenInput): Promise<ExecutorSession> {
    this.opened.push(input)
    let submitted: ExecutorTurnInput | undefined
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const session: ExecutorSession = {
      providerSessionId:
        input.resumeSessionId ?? `fixture-${this.opened.length}`,
      events: (async function* (script) {
        await ready
        if (submitted) yield* script(submitted, input)
      })(this.script),
      submit: async (turn) => {
        submitted = turn
        this.submitted.push(turn)
        release()
        return { providerTurnId: turn.runId }
      },
      steer: async () => {
        if (this.backend !== 'codex') throw new Error('UNSUPPORTED_OPTION')
      },
      answer: async () => {},
      interrupt: async () => {
        release()
      },
      close: async () => {
        release()
        return { quiescent: true }
      },
    }
    this.sessions.push(session)
    return session
  }
}
export class FakeClock {
  private value = 0
  readonly now = (): number => this.value
  advance(ms: number): void {
    this.value += ms
  }
}
export function delegationTestDirectory(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'emperor-delegation-test-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

import type { DelegationRecord, DelegationRunRecord } from './types'
import { ExecutorRegistry } from './registry'
export function fixtureDelegationRecord(): DelegationRecord {
  return {
    schemaVersion: 1,
    id: 'dlg-test',
    owner: {
      rootSessionId: 'root',
      parentAgentId: 'root',
      taskScopeId: 'task',
      requiredForGoal: false,
      depth: 1,
      source: 'model',
    },
    backend: 'codex',
    profileId: 'codex-default',
    cwd: '/fixture',
    workspaceLeaseId: 'lease',
    effectivePermission: 'read-only',
    capabilitySnapshot: new ExecutorRegistry().capabilities('codex'),
    availability: 'idle',
    createdAt: 1,
  }
}
export function fixtureDelegationRun(id = 'dgr-1'): DelegationRunRecord {
  return {
    id,
    delegationId: 'dlg-test',
    revision: 0,
    generation: 1,
    messageId: 'dgm-1',
    phase: 'queued',
    acceptance: 'unverified',
  }
}
