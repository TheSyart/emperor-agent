import { Worker } from 'node:worker_threads'
import { DelegationError, type NativeSessionInspection } from '../types'

/**
 * The reader runs in a worker thread. The SDK memoizes its config directory
 * from `process.env`, so it gets a fresh module instance and an environment
 * of its own: the delegation's `CLAUDE_CONFIG_DIR` never reaches the host.
 * It used to run as `process.execPath` with `ELECTRON_RUN_AS_NODE`, which
 * packaged builds turn off (the RunAsNode fuse, SEC-04).
 */
const READER = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { getSessionMessages } = await import(workerData.sdkUrl)
  const rows = await getSessionMessages(workerData.sessionId, { dir: workerData.cwd })
  const text = (row) =>
    Array.isArray(row.message?.content)
      ? row.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\\n')
      : typeof row.message?.content === 'string'
        ? row.message.content
        : ''
  const turns = rows
    .slice(-20)
    .map((row) => ({ id: row.uuid, status: row.type, text: text(row).slice(-8192) }))
  parentPort.postMessage({ sessionId: workerData.sessionId, nativeStatus: 'unknown', turns })
})().catch((error) => parentPort.postMessage({ error: String(error?.message ?? error) }))
`

export interface ClaudeHistoryInput {
  /** `file:` URL of the Claude Agent SDK entry. */
  sdkUrl: string
  sessionId: string
  cwd: string
  /** The delegation's environment (its `CLAUDE_CONFIG_DIR`). */
  env: Record<string, string>
  signal?: AbortSignal
}

/** The last 20 turns of a Claude Code session, read with the SDK. */
export function readClaudeSessionHistory(
  input: ClaudeHistoryInput,
): Promise<NativeSessionInspection> {
  if (input.signal?.aborted)
    return Promise.reject(
      new DelegationError('HISTORY_UNAVAILABLE', 'history inspection stopped'),
    )
  return new Promise((resolve, reject) => {
    const worker = new Worker(READER, {
      eval: true,
      env: { ...input.env },
      workerData: {
        sdkUrl: input.sdkUrl,
        sessionId: input.sessionId,
        cwd: input.cwd,
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      stdout: true,
      stderr: true,
    })
    let settled = false
    const finish = (error: Error | null, value?: NativeSessionInspection) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (error) reject(error)
      else resolve(value!)
    }
    const onAbort = () =>
      finish(
        new DelegationError(
          'HISTORY_UNAVAILABLE',
          'history inspection stopped',
        ),
      )
    input.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: unknown) => {
      const row = message as Partial<NativeSessionInspection> & {
        error?: string
      }
      if (typeof row.error === 'string')
        return finish(
          new DelegationError(
            'HISTORY_UNAVAILABLE',
            'SDK history inspection failed',
          ),
        )
      if (row.sessionId !== input.sessionId || !Array.isArray(row.turns))
        return finish(
          new DelegationError(
            'PROTOCOL_INVALID',
            'unexpected SDK history response',
          ),
        )
      finish(null, row as NativeSessionInspection)
    })
    worker.once('error', () =>
      finish(
        new DelegationError(
          'HISTORY_UNAVAILABLE',
          'SDK history inspection failed',
        ),
      ),
    )
    worker.once('exit', () =>
      finish(
        new DelegationError(
          'HISTORY_UNAVAILABLE',
          'SDK history inspection failed',
        ),
      ),
    )
  })
}
