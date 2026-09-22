// Shared fixtures for CoreApi / ChatService tests on the harness kernel: a
// temporary Emperor Home, a scripted model (session-title calls answered
// separately so they never consume the scripted turn replies), an event
// sink, and a passthrough sandbox backend.
import { assertRequestInvariant } from '../harness/agent/invariant'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmClient } from '../llm/client'
import type { RouteSpec } from '../llm/route'
import type { GenerateOptions, StreamChunk } from '../llm/types'
import type { SandboxBackend } from '../harness/sandbox/backend'
import {
  replyChunks,
  ScriptedAdapter,
  testRoute,
  type ScriptedReply,
} from '../harness/testing'
import { CoreApi, type CoreApiCreateOptions } from './core-api'

export const TEMPLATES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'templates',
)

/** Backend that runs commands unconfined (tests cannot rely on a real sandbox). */
export const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  }),
}

/** Scripted adapter that answers session-title requests out of band. */
export class KernelTestAdapter extends ScriptedAdapter {
  readonly titleRequests: GenerateOptions[] = []
  titleText = 'Generated'

  override async *stream(
    route: RouteSpec,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (options.purpose === 'session-title') {
      this.titleRequests.push(options)
      for (const chunk of replyChunks({ text: this.titleText })) yield chunk
      return
    }
    yield* super.stream(route, options)
  }
}

export interface ApiFixture {
  api: CoreApi
  adapter: KernelTestAdapter
  events: Array<Record<string, unknown>>
  root: string
  stateRoot: string
}

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function makeApi(
  options: {
    replies?: ScriptedReply[]
    root?: string
    stateRoot?: string
    extra?: Partial<CoreApiCreateOptions>
  } = {},
): Promise<ApiFixture> {
  const root = options.root ?? tmp('emperor-core-api-')
  const stateRoot = options.stateRoot ?? join(root, 'home')
  const adapter = new KernelTestAdapter(options.replies ?? [])
  const ref: { api?: CoreApi } = {}
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => ref.api?.host.sessionLog(id))
    },
  })
  llm.setRoutes([testRoute()], 'test-route')
  const events: Array<Record<string, unknown>> = []
  const api = await CoreApi.create({
    root,
    stateRoot,
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    templatesDir: TEMPLATES_DIR,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
    eventSink: (event) => {
      events.push(event)
    },
    ...options.extra,
  })
  ref.api = api
  return { api, adapter, events, root, stateRoot }
}

export async function waitFor(
  check: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export function eventOf(
  events: Array<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  return events.find((event) => event.event === name)
}

export function pendingInteractionId(
  events: Array<Record<string, unknown>>,
  name: string,
): string {
  const interaction = eventOf(events, name)?.interaction as
    { id?: unknown } | undefined
  if (typeof interaction?.id !== 'string')
    throw new Error(`no ${name} interaction`)
  return interaction.id
}
