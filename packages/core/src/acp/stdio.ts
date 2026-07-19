import type { Readable, Writable } from 'node:stream'
import { CoreApi, type CoreApiCreateOptions } from '../api/core-api'
import { EmperorAcpAdapter } from './adapter'
import {
  createBoundedNodeAcpStream,
  type BoundedNodeAcpStreamOptions,
} from './node-transport'

export interface ServeEmperorAcpStdioOptions
  extends Pick<
      CoreApiCreateOptions,
      'root' | 'stateRoot' | 'templatesDir' | 'appVersion' | 'runtimeRevision'
    >,
    BoundedNodeAcpStreamOptions {
  input: Readable
  output: Writable
  signal?: AbortSignal | null
}

/**
 * Owns one ACP connection and one CoreApi lifecycle. Stdout belongs exclusively
 * to the NDJSON transport; hosts must route diagnostics to stderr themselves.
 */
export async function serveEmperorAcpStdio(
  opts: ServeEmperorAcpStdioOptions,
): Promise<void> {
  const api = await CoreApi.create({
    root: opts.root,
    stateRoot: opts.stateRoot ?? null,
    ...(opts.templatesDir ? { templatesDir: opts.templatesDir } : {}),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    ...(opts.runtimeRevision ? { runtimeRevision: opts.runtimeRevision } : {}),
    enableFirstRunOnboarding: false,
  })
  const adapter = new EmperorAcpAdapter(api, { version: opts.appVersion })
  const connection = adapter.agentApp.connect(
    createBoundedNodeAcpStream(opts.input, opts.output, {
      maxLineBytes: opts.maxLineBytes,
    }),
  )
  const abort = (): void => connection.close(opts.signal?.reason)
  opts.signal?.addEventListener('abort', abort, { once: true })
  if (opts.signal?.aborted) abort()

  try {
    await connection.closed
    adapter.abortAll('connection_closed')
    await boundedSettle(adapter.settle(), 4_000)
  } finally {
    opts.signal?.removeEventListener('abort', abort)
    connection.close()
    adapter.abortAll('stdio_shutdown')
    await boundedSettle(adapter.settle(), 1_000)
    await api.close()
  }
}

async function boundedSettle(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
