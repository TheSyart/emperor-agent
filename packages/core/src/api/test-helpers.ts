// Shared fixtures for CoreApi / ChatService tests on the harness kernel: a
// temporary Emperor Home, a scripted model (session-title calls answered
// separately so they never consume the scripted turn replies), an event
// sink, and a passthrough sandbox backend.
import { assertRequestInvariant } from '../harness/agent/invariant'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fakeClaude, fakeCodexCli } from '../harness/delegation/testing'
import { LlmClient } from '../llm/client'
import type { RouteSpec } from '../llm/route'
import type { GenerateOptions, StreamChunk } from '../llm/types'
import type { SandboxBackend } from '../harness/sandbox/backend'
import { loadBundledToolCatalog } from '../environment/catalog'
import type { EnvironmentProcessRunner } from '../environment/process-runner'
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

/**
 * The toolchain probe of a test Core. A tool found on PATH answers its
 * `--version` at once with the catalog's pinned version, so it reads as ready
 * where it is installed, as with a real probe, but without starting a process
 * per tool for every Core: on a loaded CI runner those processes (each allowed
 * 5 s) alone used up a test's 15 s (FIX-17). Tests about the probe itself pass
 * their own runner in `extra`.
 */
export function catalogVersionProbe(): EnvironmentProcessRunner {
  const tools = loadBundledToolCatalog().catalog.tools.map((tool) => ({
    names: tool.probe.executables.map((executable) => basename(executable)),
    output: sampleVersionOutput(tool.probe.versionPattern, tool.version.pinned),
  }))
  return {
    run: async (request) => {
      const name = basename(request.executable)
      const tool = tools.find((candidate) =>
        candidate.names.some(
          (known) =>
            name === known ||
            name.startsWith(`${known}.`) ||
            name.startsWith(`${known}-`),
        ),
      )
      return {
        status: 'completed',
        exitCode: tool?.output ? 0 : 1,
        stdout: tool?.output ?? '',
        stderr: '',
        durationMs: 0,
        error: null,
      }
    },
  }
}

/** `^gh version\s+(<version>)` with 2.101.0 reads `gh version 2.101.0`. */
function sampleVersionOutput(pattern: string, version: string): string | null {
  const output = pattern
    .replace(/^\^/, '')
    .replace(/\\s\+/g, ' ')
    .replace('([0-9]+(?:\\.[0-9]+)+)', version)
  return new RegExp(pattern).exec(output)?.[1] === version ? output : null
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
    /** Overrides of the one scripted model route (`test-route`). */
    route?: Partial<RouteSpec>
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
  llm.setRoutes(
    [testRoute({ ...options.route, id: 'test-route' })],
    'test-route',
  )
  const events: Array<Record<string, unknown>> = []
  const api = await CoreApi.create({
    root,
    stateRoot,
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    templatesDir: TEMPLATES_DIR,
    llm,
    sandboxBackend: passthroughBackend,
    environmentProbeRunner: catalogVersionProbe(),
    initializeMcp: false,
    eventSink: (event) => {
      events.push(event)
    },
    // External executors look for sign-ins in a temporary home, never the
    // user's ~/.claude or ~/.codex, and never run the login shell. A fake
    // claude comes first on PATH: tests never run the real one (AGT-12),
    // so 登录 Claude Code runs the fake's `auth login` (FIX-11). A fake
    // codex that only reports its version comes first too, so a probe sees
    // the same Codex on a developer's Mac and on CI.
    // The offline self-check never starts by itself in tests (VER-04);
    // a test that wants it says so.
    executorSelfCheck: { automatic: false },
    executorHome:
      options.extra?.executorHome === undefined
        ? {
            home: join(root, 'executor-home'),
            environment: {
              PATH: `${dirname(fakeClaude(join(root, 'fake-claude-bin')))}:${dirname(fakeCodexCli(join(root, 'fake-codex-bin')))}:${process.env.PATH ?? '/usr/bin:/bin'}`,
            },
            loginShell: { read: async () => ({}) },
          }
        : options.extra.executorHome,
    // Tests never run sips, qlmanage, textutil or osascript (BUG-10): the
    // converters see tools that fail, unless a test brings its own.
    previewTools: async () => {
      throw new Error('preview tools are not run in tests')
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
