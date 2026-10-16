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
