import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

/** What the fake `claude auth login` prints, as the CLI does (FIX-11). */
export const FAKE_LOGIN_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&state=FAKE-STATE-0f1e2d'
export const FAKE_LOGIN_CODE = 'FAKE-CODE-9c1d8b7a'

/**
 * A stand-in for the installed `claude` (AGT-12), written as `<dir>/claude`:
 * `--version`, and `auth status | login | logout` answered the way the CLI
 * answers them — JSON, exit 0 signed in, 1 not — keyed to its own
 * CLAUDE_CONFIG_DIR. Like the CLI it prefers ANTHROPIC_AUTH_TOKEN, then
 * ANTHROPIC_API_KEY, then its own sign-in. Every call appends its
 * arguments and environment to `<CLAUDE_CONFIG_DIR>/fake-claude.log`
 * ({@link fakeClaudeCalls}). Tests never run the real claude.
 *
 * `auth login` (FIX-11) prints a sign-in link and a code-like line the way
 * the CLI does ({@link FAKE_LOGIN_LINK}, {@link FAKE_LOGIN_CODE}), records
 * its pid and process group in `fake-login-pid` / `fake-login-pgid`, then
 * follows `<CLAUDE_CONFIG_DIR>/fake-login-mode`: empty signs in and exits
 * 0; `fail` exits 3; `signed-out` exits 0 without signing in; `hang` waits
 * on a child `sleep` (its pid in `fake-login-child`) until it is stopped.
 */
export function fakeClaude(
  dir: string,
  options: {
    version?: string
    status?: 'fail' | 'garbage'
    /** `--version` reads this package.json's version (AGT-13). */
    versionFrom?: string
  } = {},
): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'claude')
  const status =
    options.status === 'fail'
      ? '      echo "status exploded" >&2; exit 3'
      : options.status === 'garbage'
        ? '      echo "Logged in somehow"; exit 0'
        : [
            '      source=ANTHROPIC_API_KEY',
            '      if [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then method=oauth_token; ok=true',
            '      elif [ -n "$ANTHROPIC_API_KEY" ]; then method=api_key; ok=true',
            '      elif [ "$(cat "$dir/fake-signed-in" 2>/dev/null)" = console ]; then method=api_key; ok=true; source="/login managed key"',
            '      elif [ -f "$dir/fake-signed-in" ]; then method=claude.ai; ok=true',
            '      else method=none; ok=false; fi',
            '      if [ "$method" = claude.ai ]; then',
            `        printf '{\\n  "loggedIn": true,\\n  "authMethod": "claude.ai",\\n  "apiProvider": "firstParty",\\n  "configDirectory": "%s",\\n  "email": "ada@example.com",\\n  "orgId": "11111111-2222-3333-4444-555555555555",\\n  "orgName": "Ada Lab",\\n  "subscriptionType": "max"\\n}\\n' "$dir"`,
            '      elif [ "$method" = api_key ]; then',
            `        printf '{\\n  "loggedIn": true,\\n  "authMethod": "api_key",\\n  "apiProvider": "firstParty",\\n  "configDirectory": "%s",\\n  "apiKeySource": "%s"\\n}\\n' "$dir" "$source"`,
            '      else',
            `        printf '{\\n  "loggedIn": %s,\\n  "authMethod": "%s",\\n  "apiProvider": "firstParty",\\n  "configDirectory": "%s"\\n}\\n' "$ok" "$method" "$dir"`,
            '      fi',
            '      [ "$ok" = true ] && exit 0 || exit 1',
          ].join('\n')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'dir="$CLAUDE_CONFIG_DIR"',
      'if [ -n "$dir" ] && [ -d "$dir" ]; then',
      `  { printf '\\036ARGS %s\\n' "$*"; env; } >> "$dir/fake-claude.log"`,
      'fi',
      options.versionFrom
        ? `if [ "$1" = "--version" ]; then v=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "${options.versionFrom}"); echo "$v (Claude Code)"; exit 0; fi`
        : `if [ "$1" = "--version" ]; then echo "${options.version ?? '2.1.300'} (Claude Code)"; exit 0; fi`,
      'if [ "$1" = "auth" ]; then',
      '  case "$2" in',
      '    status)',
      status,
      '      ;;',
      '    login)',
      '      mode="$(cat "$dir/fake-login-mode" 2>/dev/null)"',
      '      echo $$ > "$dir/fake-login-pid"',
      `      /bin/ps -o pgid= -p $$ | tr -d ' ' > "$dir/fake-login-pgid"`,
      '      echo "Opening browser to sign in…"',
      `      echo "If the browser didn't open, visit: ${FAKE_LOGIN_LINK}"`,
      `      printf 'Paste code here if prompted > '`,
      `      echo "${FAKE_LOGIN_CODE}" >&2`,
      '      case "$mode" in',
      '        fail) exit 3 ;;',
      '        signed-out) exit 0 ;;',
      '        hang) sleep 600 & echo $! > "$dir/fake-login-child"; wait; exit 0 ;;',
      '      esac',
      '      if [ "$3" = "--console" ]; then echo console > "$dir/fake-signed-in"; else echo claude.ai > "$dir/fake-signed-in"; fi',
      '      echo "Login successful."; exit 0',
      '      ;;',
      '    logout)',
      '      rm -f "$dir/fake-signed-in"; echo "Successfully logged out from your Anthropic account."; exit 0',
      '      ;;',
      '  esac',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return path
}

/**
 * A `codex` that only answers `--version` (and fails anything else, such as
 * the schema generation), so a probe sees a supported but unverified Codex
 * on every machine: tests never depend on whether the developer's or the
 * CI runner's PATH has a real Codex.
 */
export function fakeCodexCli(
  dir: string,
  options: { version?: string } = {},
): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'codex')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "codex-cli ${options.version ?? '0.163.0'}"; exit 0; fi`,
      'echo "fake codex: $*" >&2',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return path
}

/** The fake `claude auth login`'s pid, process group and child (FIX-11). */
export function fakeLoginProcess(configDirectory: string): {
  pid?: number
  pgid?: number
  child?: number
} {
  const read = (name: string) => {
    try {
      const value = Number(
        readFileSync(join(configDirectory, name), 'utf8').trim(),
      )
      return value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
  const pid = read('fake-login-pid'),
    pgid = read('fake-login-pgid'),
    child = read('fake-login-child')
  return {
    ...(pid ? { pid } : {}),
    ...(pgid ? { pgid } : {}),
    ...(child ? { child } : {}),
  }
}

/** A process is still there (not yet reaped counts as there). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What the fake `claude` was asked, with the environment it saw. */
export function fakeClaudeCalls(
  configDirectory: string,
): Array<{ args: string; env: Record<string, string> }> {
  let log = ''
  try {
    log = readFileSync(join(configDirectory, 'fake-claude.log'), 'utf8')
  } catch {
    return []
  }
  return log
    .split('\u001eARGS ')
    .slice(1)
    .map((chunk) => {
      const [args = '', ...lines] = chunk.split('\n')
      const env: Record<string, string> = {}
      for (const line of lines) {
        const at = line.indexOf('=')
        if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
      }
      return { args, env }
    })
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

import { ManagedAgentProcess } from './process'

/** A Codex model the fake app-server offers in `model/list`. */
export interface FakeCodexModel {
  id: string
  isDefault?: boolean
  hidden?: boolean
}
/**
 * What the fake `codex app-server` does (FIX-16, AGT-13). Tests never run
 * the real codex.
 */
export interface FakeCodexOptions {
  /**
   * The Codex release it speaks (default 0.153.4): `initialize` reports it
   * in the user agent a real app-server returns, and from 0.163 turns carry
   * `rootTurnId` as they do there.
   */
  version?: string
  /**
   * The model its own configuration selects (the user's
   * `~/.codex/config.toml`): `thread/start` without a model reports it.
   */
  defaultModel?: string
  /** `model/list`: the models this login offers. */
  models?: FakeCodexModel[]
  /**
   * A model the account refuses: a turn on it fails at once with the 400
   * payload a ChatGPT login gets ({@link codexModelRejection}).
   */
  rejectModel?: string
  /** `model/list` answers with an error this many times first. */
  modelListFailures?: number
  /** A completed turn's final message; the model it ran on follows it. */
  reply?: string
  /**
   * A completed turn's agent messages instead, as sent, each with its
   * MessagePhase (0.163 can split an answer into `partial_answer` ones).
   */
  answer?: { text: string; phase?: string }[]
}
/**
 * The error a Codex turn reports when the account refuses its model, as
 * Codex 0.153.4 reported it for the user on 2026-10-22 (FIX-16).
 */
export function codexModelRejection(model: string): string {
  return JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
    },
  })
}
/**
 * A stand-in for `codex app-server --listen stdio://` (FIX-16, AGT-13):
 * JSON-RPC over stdio, answering `initialize`, `thread/start|resume`
 * (reporting the model it will use), `config/read`, `model/list`,
 * `turn/start` and `turn/interrupt`. Every request is appended, with its
 * `model`, to `$TMPDIR/fake-codex.jsonl` ({@link fakeCodexRequests}); the
 * run's TMPDIR is its private temp folder.
 */
export function fakeCodexScript(options: FakeCodexOptions = {}): string {
  return `
const options = ${JSON.stringify(options)}
const fs = require('node:fs'), path = require('node:path')
const log = path.join(process.env.TMPDIR || '.', 'fake-codex.jsonl')
let threadId = null, threadModel = null, turns = 0
let listFailures = options.modelListFailures || 0
const version = options.version || '0.153.4'
const since0163 = (() => { const [a, b] = version.split('.').map(Number); return a > 0 || b >= 163 })()
const turnOf = (id, status, rest) => ({ id, ...(since0163 ? { rootTurnId: id } : {}), status, items: [], itemsView: 'notLoaded', ...rest })
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
const note = (entry) => { try { fs.appendFileSync(log, JSON.stringify(entry) + '\\n') } catch {} }
const rejection = (model) => JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The '" + model + "' model is not supported when using Codex with a ChatGPT account." } })
const lines = require('node:readline').createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', (line) => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.id === undefined || typeof frame.method !== 'string') return
  const params = frame.params || {}
  note({ method: frame.method, model: params.model ?? null, includeHidden: params.includeHidden ?? null })
  const reply = (result) => send({ id: frame.id, result })
  const fail = (message) => send({ id: frame.id, error: { code: -32603, message } })
  switch (frame.method) {
    case 'initialize': {
      // The user agent a real app-server builds from the client's info.
      const client = params.clientInfo || {}
      return reply({ userAgent: client.name + '/' + version + ' (Mac OS 26.4.1; arm64) unknown (' + client.name + '; ' + client.version + ')' })
    }
    case 'thread/start':
    case 'thread/resume':
      threadId = params.threadId || 'thread-fake'
      threadModel = params.model || threadModel || options.defaultModel || 'gpt-5.6-sol'
      return reply({ thread: { id: threadId }, model: threadModel, modelProvider: 'openai' })
    case 'config/read':
      return reply({ config: { model: options.defaultModel ?? null } })
    case 'model/list':
      if (listFailures > 0) { listFailures--; return fail('models are unavailable') }
      return reply({
        data: (options.models || []).map((m) => ({ id: m.id, model: m.id, displayName: m.id, hidden: !!m.hidden, isDefault: !!m.isDefault, ...(since0163 ? { availableAccessPrograms: null } : {}) })),
        nextCursor: null,
      })
    case 'turn/start': {
      if (params.model) threadModel = params.model
      const turnId = 'turn-' + ++turns, model = threadModel
      reply({ turn: turnOf(turnId, 'inProgress') })
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId, turn: turnOf(turnId, 'inProgress') } })
        if (model === options.rejectModel) {
          send({ method: 'turn/completed', params: { threadId, turn: turnOf(turnId, 'failed', { error: { message: rejection(model) } }) } })
          return
        }
        const messages = options.answer || [{ text: (options.reply || 'done') + ' (' + model + ')' }]
        const items = messages.map((m, i) => ({ type: 'agentMessage', id: 'msg-' + turnId + '-' + i, text: m.text, ...(m.phase ? { phase: m.phase } : {}) }))
        for (const item of items) {
          send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: item.id, delta: item.text } })
          send({ method: 'item/completed', params: { threadId, turnId, item } })
        }
        // As the real app-server sends them, turn notifications list no
        // items (itemsView notLoaded): the answer comes from item/completed.
        send({ method: 'turn/completed', params: { threadId, turn: turnOf(turnId, 'completed') } })
      }, 10)
      return
    }
    case 'turn/interrupt':
      return reply({})
    default:
      return send({ id: frame.id, error: { code: -32601, message: 'unsupported ' + frame.method } })
  }
})
`
}
/** Processes whose every spawn runs the fake Codex app-server instead. */
export function fakeCodexProcesses(
  options: FakeCodexOptions = {},
): ManagedAgentProcess {
  const processes = new ManagedAgentProcess({ stopGraceMs: 500 })
  const spawn = processes.spawn.bind(processes)
  processes.spawn = (spec) =>
    spawn({
      ...spec,
      executable: process.execPath,
      args: ['-e', fakeCodexScript(options)],
    })
  return processes
}
/** What the fake Codex was asked, in order, under one temp folder. */
export function fakeCodexRequests(tempRoot: string): Array<{
  method: string
  model: string | null
  includeHidden: boolean | null
}> {
  try {
    return readFileSync(join(tempRoot, 'fake-codex.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * A global npm prefix (AGT-13) with Claude Code and Codex installed the way
 * npm links them (`<prefix>/bin/claude` → `../lib/node_modules/…`), each
 * reporting the version in its package.json, and a fake `npm` following
 * `<root>/npm-mode`: empty writes the requested version into the package
 * (an upgrade), `eacces` fails as npm does without write permission,
 * `hang` waits on a child `sleep` (pids in `<root>/npm-pids`), `noop`
 * changes nothing. Every call is appended to `<root>/npm-calls`. Tests
 * never run the real npm.
 */
export function fakeNpmPrefix(
  root: string,
  versions: { 'claude-code': string; codex: string } = {
    'claude-code': '2.1.281',
    codex: '0.153.4',
  },
): { prefix: string; mode(mode: '' | 'eacces' | 'hang' | 'noop'): void } {
  const prefix = join(root, 'prefix')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  const pkg = (name: string, version: string) => {
    const dir = join(prefix, 'lib/node_modules', name)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
    return dir
  }
  const claude = pkg('@anthropic-ai/claude-code', versions['claude-code'])
  fakeClaude(join(claude, 'bin'), {
    versionFrom: join(claude, 'package.json'),
  })
  symlinkSync(
    '../lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    join(prefix, 'bin/claude'),
  )
  const codex = pkg('@openai/codex', versions.codex)
  writeFileSync(
    join(codex, 'bin/codex.js'),
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  v=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "${codex}/package.json")`,
      '  echo "codex-cli $v"; exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
  )
  chmodSync(join(codex, 'bin/codex.js'), 0o755)
  symlinkSync(
    '../lib/node_modules/@openai/codex/bin/codex.js',
    join(prefix, 'bin/codex'),
  )
  writeFileSync(
    join(prefix, 'bin/npm'),
    [
      '#!/bin/sh',
      `echo "$*" >> "${root}/npm-calls"`,
      `mode=$(cat "${root}/npm-mode" 2>/dev/null)`,
      'spec=""',
      'for a in "$@"; do case "$a" in *@[0-9]*) spec="$a";; esac; done',
      'pkg="${spec%@*}"; ver="${spec##*@}"',
      'case "$mode" in',
      '  eacces) echo "npm error code EACCES" >&2',
      '    echo "npm error path $npm_config_prefix/lib/node_modules/$pkg" >&2',
      '    echo "npm error Error: EACCES: permission denied, rename" >&2; exit 243;;',
      `  hang) sleep 600 & echo "$$ $!" > "${root}/npm-pids"; wait; exit 0;;`,
      '  noop) echo "up to date in 1s"; exit 0;;',
      'esac',
      'printf \'{"name":"%s","version":"%s"}\\n\' "$pkg" "$ver" > "$npm_config_prefix/lib/node_modules/$pkg/package.json"',
      'echo "changed 1 package in 1s"',
      '',
    ].join('\n'),
  )
  chmodSync(join(prefix, 'bin/npm'), 0o755)
  return {
    prefix,
    mode: (mode) => writeFileSync(join(root, 'npm-mode'), mode),
  }
}

/** A plugin as Claude Code's SDK reports it (reloadPlugins, system/init). */
export interface FakeClaudePlugin {
  name: string
  path: string
  source?: string
}

export interface FakeClaudeSdkOptions {
  /** `claude_code_version` in system/init. */
  version?: string
  /** What the CLI loads unless `enabledPlugins` names it false. */
  plugins?: FakeClaudePlugin[]
  /** MCP servers the CLI connects whatever Emperor asks. */
  mcpServers?: string[]
  /** false: reloadPlugins is refused (older CLI); 'hang': never answers. */
  supportsReload?: boolean | 'hang'
  /** false: applyFlagSettings is accepted and changes nothing. */
  honoursFlagSettings?: boolean
  /** reloadPlugins' error_count. */
  errorCount?: number
  /** initialize's hooks_applied (default true). */
  hooksApplied?: boolean
}

export interface FakeClaudeControlRequest {
  subtype: 'reload_plugins' | 'apply_flag_settings' | 'mcp_server_status'
  /** Which process (0, 1, …) received it. */
  launch: number
  /** User messages the fake had received when the request arrived. */
  modelCallsBefore: number
  settings?: Record<string, unknown>
}

/**
 * A stand-in for the Agent SDK and the installed claude (VER-02), passed
 * as ClaudeExecutorAdapter's `startup`. Each launch spawns a quiet node
 * process through the adapter's managed spawn (as the SDK does) and
 * answers the control requests Emperor sends before a prompt from its
 * options: a plugin is loaded unless the launch's `settings.enabledPlugins`
 * or an honoured applyFlagSettings names it false. Every control request
 * and user message is recorded; `modelCalls` counts user messages (each
 * would be a model call). Tests never run the real claude.
 */
export function fakeClaudeSdk(options: FakeClaudeSdkOptions = {}): {
  startup: (
    options: import('@anthropic-ai/claude-agent-sdk').Options,
  ) => Promise<
    Pick<import('@anthropic-ai/claude-agent-sdk').WarmQuery, 'query' | 'close'>
  >
  launches: import('@anthropic-ai/claude-agent-sdk').Options[]
  controlRequests: FakeClaudeControlRequest[]
  userMessages: unknown[]
  readonly modelCalls: number
} {
  type Options = import('@anthropic-ai/claude-agent-sdk').Options
  type Query = import('@anthropic-ai/claude-agent-sdk').Query
  const launches: Options[] = [],
    controlRequests: FakeClaudeControlRequest[] = [],
    userMessages: unknown[] = []
  const sourceOf = (p: FakeClaudePlugin) => p.source ?? p.name
  const startup = async (opts: Options) => {
    const launch = launches.push(opts) - 1
    const proc = opts.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      cwd: opts.cwd ?? process.cwd(),
      env: {},
      signal: new AbortController().signal,
    })
    let flags: Record<string, unknown> = {}
    const loaded = () => {
      const enabled = {
        ...((opts.settings as { enabledPlugins?: Record<string, unknown> })
          ?.enabledPlugins ?? {}),
        ...((flags.enabledPlugins as Record<string, unknown>) ?? {}),
      }
      return (options.plugins ?? []).filter(
        (p) => enabled[sourceOf(p)] !== false,
      )
    }
    const control = (
      subtype: FakeClaudeControlRequest['subtype'],
      settings?: Record<string, unknown>,
    ) =>
      controlRequests.push({
        subtype,
        launch,
        modelCallsBefore: userMessages.length,
        ...(settings ? { settings } : {}),
      })
    const mcp = () =>
      (options.mcpServers ?? []).map((name) => ({ name, status: 'connected' }))
    return {
      close: () => proc.stdin.end(),
      query: (prompts: string | AsyncIterable<unknown>) => {
        const messages = (async function* () {
          if (typeof prompts === 'string') throw new Error('must stream')
          for await (const prompt of prompts) {
            userMessages.push(prompt)
            yield {
              type: 'system',
              subtype: 'init',
              session_id: opts.resume ?? opts.sessionId,
              tools: ['Read'],
              plugins: loaded(),
              mcp_servers: mcp(),
              claude_code_version: options.version ?? '2.1.310',
            }
            yield {
              type: 'result',
              subtype: 'success',
              result: 'done',
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          }
        })()
        return Object.assign(messages, {
          initializationResult: async () => ({
            hooks_applied: options.hooksApplied ?? true,
          }),
          reloadPlugins: async () => {
            control('reload_plugins')
            if (options.supportsReload === 'hang')
              return await new Promise<never>(() => {})
            if (options.supportsReload === false)
              throw new Error('Unsupported control request: reload_plugins')
            return {
              commands: [],
              agents: [],
              plugins: loaded(),
              mcpServers: mcp(),
              error_count: options.errorCount ?? 0,
            }
          },
          applyFlagSettings: async (settings: Record<string, unknown>) => {
            control('apply_flag_settings', settings)
            if (options.honoursFlagSettings !== false)
              flags = { ...flags, ...settings }
          },
          mcpServerStatus: async () => {
            control('mcp_server_status')
            return mcp()
          },
          interrupt: async () => undefined,
          close: () => proc.stdin.end(),
        }) as unknown as Query
      },
    }
  }
  return {
    startup,
    launches,
    controlRequests,
    userMessages,
    get modelCalls() {
      return userMessages.length
    },
  }
}
