import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type {
  HookCommandHandler,
  HookCommandHandlerV2,
  HookDecision,
  HookDefinition,
  HookEventName,
  HookExecutionResult,
  HookHandlerType,
  HookHandlerV2,
  HookHttpHandler,
  HookHttpHandlerV2,
  HookInput,
  HookPolicy,
} from './models'
import { parseHookOutput } from './schema'
import type { ExecutionEnvironment } from '../environment/snapshot'
import {
  NodeOwnedProcessRunner,
  type OwnedProcessRunner,
} from '../environment/process-runner'
import {
  analyzeShellCommand,
  analyzeShellCommandFailClosed,
  type ShellCommandAnalyzer,
} from '../permissions/shell-ast'

const MAX_OUTPUT_CHARS = 64_000
const legacyHookProcessRunner = new NodeOwnedProcessRunner()

export type HookExecutorOutcome =
  'completed' | 'failed' | 'timeout' | 'cancelled'

export interface HookExecutorContext {
  eventName: HookEventName
  sessionId?: string | null
  turnId?: string | null
  processOwnerId?: string | null
  cwd: string
  policy: HookPolicy
  signal?: AbortSignal | null
  executionEnvironment?: ExecutionEnvironment | null
}

export interface HookExecutorResultV2 {
  outcome: HookExecutorOutcome
  output: Record<string, unknown> | null
  reason: string
  durationMs: number
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface HookHandlerExecutor<T extends HookHandlerV2 = HookHandlerV2> {
  readonly type: T['type']
  execute(
    handler: T,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2>
}

export class HookExecutorRegistry {
  private readonly executors = new Map<HookHandlerType, HookHandlerExecutor>()

  register(executor: HookHandlerExecutor): void {
    if (this.executors.has(executor.type))
      throw new Error(`Hook executor already registered: ${executor.type}`)
    this.executors.set(executor.type, executor)
  }

  async execute(
    handler: HookHandlerV2,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2> {
    const executor = this.executors.get(handler.type)
    if (!executor)
      return emptyExecutorResult(
        'failed',
        `No hook executor registered for ${handler.type}`,
      )
    return executor.execute(handler, input, context)
  }
}

export class CommandHookExecutor implements HookHandlerExecutor<HookCommandHandlerV2> {
  readonly type = 'command' as const

  constructor(
    private readonly shellAnalyzer: ShellCommandAnalyzer = analyzeShellCommand,
    private readonly ownedRunner: OwnedProcessRunner = new NodeOwnedProcessRunner(),
  ) {}

  async execute(
    handler: HookCommandHandlerV2,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2> {
    const started = Date.now()
    if (context.signal?.aborted)
      return emptyExecutorResult(
        'cancelled',
        'Hook execution cancelled before start',
        started,
      )
    if (!existsSync(context.cwd))
      return emptyExecutorResult(
        'failed',
        `Hook cwd does not exist: ${context.cwd}`,
        started,
      )
    if (handler.shell !== 'none' && !context.policy.command.allowShell) {
      return emptyExecutorResult(
        'failed',
        `Hook shell execution is disabled by policy: ${handler.shell}`,
        started,
      )
    }
    if (handler.shell === 'bash') {
      const analysis = analyzeShellCommandFailClosed(
        handler.command,
        this.shellAnalyzer,
      )
      if (analysis.status !== 'parsed')
        return emptyExecutorResult(
          'failed',
          `Hook bash command classification failed: ${analysis.reasonCodes.join(',') || analysis.status}`,
          started,
        )
    }
    const invocation = commandInvocation(handler)
    const maxOutputBytes = Math.max(
      1,
      Math.trunc(context.policy.command.maxOutputBytes),
    )
    const stdout = new ByteTailBuffer(maxOutputBytes)
    const stderr = new ByteTailBuffer(maxOutputBytes)
    const timeoutMs = Math.min(
      handler.timeoutMs,
      context.policy.command.maxTimeoutMs,
    )

    const result = await this.ownedRunner.run({
      executable: invocation.command,
      args: invocation.args,
      cwd: context.cwd,
      env: commandEnvironment(
        handler,
        context.policy,
        context.executionEnvironment ?? null,
      ) as Record<string, string>,
      stdin: `${JSON.stringify(input)}\n`,
      timeoutMs,
      maxOutputBytes,
      outputPolicy: 'truncate_tail',
      outputQuotaScope: 'per_stream',
      ...(context.signal ? { signal: context.signal } : {}),
      owner: {
        kind: 'hook',
        id: String(
          context.processOwnerId ||
            `${context.eventName}:${context.turnId || context.sessionId || 'unbound'}`,
        ),
        sessionId: context.sessionId ?? null,
      },
      containment: {
        mode: 'preferred',
        workspaceRoot: context.cwd,
        stateRoot: String(input.state_root ?? '').trim() || null,
        tempRoot: context.cwd,
        readOnlyRoots: [],
        network: 'allow',
      },
    })
    stdout.append(result.stdout)
    stderr.append(result.stderr)
    let mapped: HookExecutorResultV2
    if (result.status === 'cancelled')
      mapped = commandResult({
        outcome: 'cancelled',
        reason: 'Hook execution cancelled',
        started,
        stdout,
        stderr,
      })
    else if (result.status === 'timeout')
      mapped = commandResult({
        outcome: 'timeout',
        reason: `Hook timed out after ${timeoutMs}ms`,
        started,
        stdout,
        stderr,
      })
    else if (
      result.status === 'spawn_error' ||
      result.status === 'containment_unavailable' ||
      result.status === 'output_limit'
    )
      mapped = commandResult({
        outcome: 'failed',
        reason: result.error || `Hook process failed: ${result.status}`,
        started,
        stdout,
        stderr,
      })
    else
      mapped = resultFromCommandExit(
        context.eventName,
        result.exitCode ?? 0,
        started,
        stdout,
        stderr,
      )
    return {
      ...mapped,
      stdoutBytes: result.stdoutBytes ?? mapped.stdoutBytes,
      stderrBytes: result.stderrBytes ?? mapped.stderrBytes,
      stdoutTruncated: result.stdoutTruncated ?? mapped.stdoutTruncated,
      stderrTruncated: result.stderrTruncated ?? mapped.stderrTruncated,
    }
  }
}

type HookDnsLookup = (hostname: string) => Promise<string[]>
type HookHttpPolicy = HookPolicy['http']

export class HttpHookExecutor implements HookHandlerExecutor<HookHttpHandlerV2> {
  readonly type = 'http' as const
  private readonly lookup: HookDnsLookup

  constructor(opts: { lookup?: HookDnsLookup } = {}) {
    this.lookup = opts.lookup ?? defaultHookDnsLookup
  }

  async execute(
    handler: HookHttpHandlerV2,
    input: Record<string, unknown>,
    context: HookExecutorContext,
  ): Promise<HookExecutorResultV2> {
    const started = Date.now()
    if (context.signal?.aborted)
      return emptyExecutorResult(
        'cancelled',
        'Hook execution cancelled before start',
        started,
      )
    const policy = context.policy.http
    if (!policy.allowedUrlPatterns.length)
      return emptyExecutorResult(
        'failed',
        'HTTP hook URL allowlist is empty',
        started,
      )
    let url: URL
    try {
      url = new URL(handler.url)
    } catch (error) {
      return emptyExecutorResult(
        'failed',
        `Invalid HTTP hook URL: ${error instanceof Error ? error.message : String(error)}`,
        started,
      )
    }
    if (!['http:', 'https:'].includes(url.protocol))
      return emptyExecutorResult(
        'failed',
        `Unsupported HTTP hook protocol: ${url.protocol}`,
        started,
      )
    if (url.username || url.password)
      return emptyExecutorResult(
        'failed',
        'HTTP hook URLs may not contain userinfo',
        started,
      )
    if (
      !policy.allowedUrlPatterns.some((pattern) =>
        wildcardUrlMatch(pattern, url.href),
      )
    ) {
      return emptyExecutorResult(
        'failed',
        `HTTP hook URL is not allowed: ${url.href}`,
        started,
      )
    }

    let addresses: string[]
    try {
      addresses = isIP(url.hostname)
        ? [url.hostname]
        : await this.lookup(url.hostname)
    } catch (error) {
      return emptyExecutorResult(
        'failed',
        `HTTP hook DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        started,
      )
    }
    if (!addresses.length)
      return emptyExecutorResult(
        'failed',
        `HTTP hook DNS lookup returned no addresses for ${url.hostname}`,
        started,
      )
    for (const address of addresses) {
      const blocked = blockedAddressReason(address, policy)
      if (blocked) return emptyExecutorResult('failed', blocked, started)
    }

    const body = Buffer.from(JSON.stringify(input))
    const headers = hookHttpHeaders(
      handler,
      policy.allowedEnv,
      context.executionEnvironment ?? null,
    )
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(body.length)
    headers.host = url.host
    const address = addresses[0]!
    const timeoutMs = Math.min(handler.timeoutMs, policy.maxTimeoutMs)
    const responseBody = new ByteTailBuffer(
      Math.max(1, policy.maxResponseBytes),
    )

    return await new Promise<HookExecutorResultV2>((resolveResult) => {
      let settled = false
      let timedOut = false
      let cancelled = false
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: address,
          family: isIP(address),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers,
          ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        },
        (response) => {
          response.on('data', (chunk: Buffer | string) => {
            responseBody.append(chunk)
            if (responseBody.truncated && !settled) {
              response.destroy()
              settle(
                httpExecutorResult({
                  outcome: 'failed',
                  reason: `HTTP hook response exceeded ${policy.maxResponseBytes} bytes`,
                  started,
                  body: responseBody,
                }),
              )
            }
          })
          response.on('end', () => {
            if (settled) return
            const status = response.statusCode ?? 0
            if (status < 200 || status >= 300) {
              settle(
                httpExecutorResult({
                  outcome: 'failed',
                  reason: `HTTP ${status}`,
                  started,
                  body: responseBody,
                }),
              )
              return
            }
            settle(resultFromHttpBody(context.eventName, started, responseBody))
          })
          response.on('error', (error) => {
            if (!settled)
              settle(
                httpExecutorResult({
                  outcome: 'failed',
                  reason: error.message,
                  started,
                  body: responseBody,
                }),
              )
          })
        },
      )
      const settle = (result: HookExecutorResultV2): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', cancelFromCaller)
        resolveResult(result)
      }
      const cancelFromCaller = (): void => {
        cancelled = true
        request.destroy(new Error('Hook execution cancelled'))
      }
      const timer = setTimeout(
        () => {
          timedOut = true
          request.destroy(new Error(`Hook timed out after ${timeoutMs}ms`))
        },
        Math.max(1, timeoutMs),
      )

      context.signal?.addEventListener('abort', cancelFromCaller, {
        once: true,
      })
      request.on('error', (error) => {
        if (cancelled) {
          settle(
            httpExecutorResult({
              outcome: 'cancelled',
              reason: 'Hook execution cancelled',
              started,
              body: responseBody,
            }),
          )
        } else if (timedOut) {
          settle(
            httpExecutorResult({
              outcome: 'timeout',
              reason: `Hook timed out after ${timeoutMs}ms`,
              started,
              body: responseBody,
            }),
          )
        } else {
          settle(
            httpExecutorResult({
              outcome: 'failed',
              reason: error.message,
              started,
              body: responseBody,
            }),
          )
        }
      })
      request.end(body)
    })
  }
}

async function defaultHookDnsLookup(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map((entry) => entry.address)
}

function wildcardUrlMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}

function blockedAddressReason(
  rawAddress: string,
  policy: HookHttpPolicy,
): string | null {
  const address =
    rawAddress.startsWith('[') && rawAddress.endsWith(']')
      ? rawAddress.slice(1, -1)
      : rawAddress
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1]
  if (mapped) return blockedAddressReason(mapped, policy)

  const family = isIP(address)
  if (family === 4) return blockedIpv4Reason(address, policy)
  if (family === 6) return blockedIpv6Reason(address, policy)
  return `HTTP hook DNS returned an invalid address: ${rawAddress}`
}

function blockedIpv4Reason(
  address: string,
  policy: HookHttpPolicy,
): string | null {
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return `HTTP hook DNS returned an invalid address: ${address}`
  }
  const [a, b] = octets as [number, number, number, number]
  if (a === 127)
    return policy.allowLoopback
      ? null
      : `HTTP hook loopback address is denied: ${address}`
  const privateOrLocal =
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  if (privateOrLocal && !policy.allowPrivateNetworks) {
    return `HTTP hook private or blocked address is denied: ${address}`
  }
  return null
}

function blockedIpv6Reason(
  address: string,
  policy: HookHttpPolicy,
): string | null {
  const normalized = address.toLowerCase().split('%')[0]!
  if (normalized === '::1')
    return policy.allowLoopback
      ? null
      : `HTTP hook loopback address is denied: ${address}`
  const privateOrLocal =
    normalized === '::' ||
    /^f[cd][0-9a-f]{2}:/.test(normalized) ||
    /^fe[89ab][0-9a-f]:/.test(normalized) ||
    /^ff[0-9a-f]{2}:/.test(normalized)
  if (privateOrLocal && !policy.allowPrivateNetworks) {
    return `HTTP hook private or blocked address is denied: ${address}`
  }
  return null
}

function hookHttpHeaders(
  handler: HookHttpHandlerV2,
  policyAllowedEnv: string[],
  executionEnvironment: ExecutionEnvironment | null,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const allowed = new Set(
    handler.allowedEnv.filter((name) => policyAllowedEnv.includes(name)),
  )
  for (const [name, template] of Object.entries(handler.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue
    let unresolved = false
    const value = template.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, envName: string) => {
        const resolved = !allowed.has(envName)
          ? undefined
          : executionEnvironment
            ? executionEnvironment.selectEnv([envName])[envName]
            : process.env[envName]
        if (resolved === undefined) {
          unresolved = true
          return ''
        }
        return resolved
      },
    )
    if (unresolved) continue
    headers[name.toLowerCase()] = value.replace(/[\r\n\0]/g, '')
  }
  return headers
}

function resultFromHttpBody(
  eventName: HookEventName,
  started: number,
  body: ByteTailBuffer,
): HookExecutorResultV2 {
  const raw = body.text().trim()
  let value: unknown = {}
  if (raw) {
    try {
      value = JSON.parse(raw)
    } catch (error) {
      return httpExecutorResult({
        outcome: 'failed',
        reason: `Invalid hook JSON response: ${error instanceof Error ? error.message : String(error)}`,
        started,
        body,
      })
    }
  }
  const parsed = parseHookOutput(eventName, value)
  if (!parsed.output) {
    return httpExecutorResult({
      outcome: 'failed',
      reason:
        parsed.diagnostics.map((item) => item.message).join('; ') ||
        'Invalid hook output',
      started,
      body,
    })
  }
  return httpExecutorResult({
    outcome: 'completed',
    output: parsed.output,
    reason:
      typeof parsed.output.reason === 'string' ? parsed.output.reason : 'ok',
    started,
    body,
  })
}

function httpExecutorResult(opts: {
  outcome: HookExecutorOutcome
  output?: Record<string, unknown> | null
  reason: string
  started: number
  body: ByteTailBuffer
}): HookExecutorResultV2 {
  return {
    outcome: opts.outcome,
    output: opts.output ?? null,
    reason: opts.reason,
    durationMs: Date.now() - opts.started,
    stdout: opts.body.text(),
    stderr: '',
    stdoutBytes: opts.body.bytes,
    stderrBytes: 0,
    stdoutTruncated: opts.body.truncated,
    stderrTruncated: false,
  }
}

class ByteTailBuffer {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  readonly limit: number
  bytes = 0

  constructor(limit: number) {
    this.limit = limit
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.bytes += chunk.length
    const combined = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk
    this.buffer =
      combined.length > this.limit
        ? combined.subarray(combined.length - this.limit)
        : Buffer.from(combined)
  }

  text(): string {
    return this.buffer.toString('utf8')
  }

  get truncated(): boolean {
    return this.bytes > this.limit
  }
}

function commandInvocation(handler: HookCommandHandlerV2): {
  command: string
  args: string[]
} {
  if (handler.shell === 'bash')
    return {
      command: process.platform === 'win32' ? 'bash.exe' : '/bin/bash',
      args: ['-lc', handler.command],
    }
  if (handler.shell === 'powershell')
    return {
      command: 'pwsh',
      args: ['-NoProfile', '-NonInteractive', '-Command', handler.command],
    }
  return { command: handler.command, args: [...handler.args] }
}

function commandEnvironment(
  handler: HookCommandHandlerV2,
  policy: HookPolicy,
  executionEnvironment: ExecutionEnvironment | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = executionEnvironment
    ? { ...executionEnvironment.env }
    : {}
  if (!executionEnvironment) {
    const platformBasics =
      process.platform === 'win32'
        ? ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
        : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
    for (const name of platformBasics) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
  }
  const policyAllowed = new Set(policy.command.allowedEnv)
  const allowedNames = handler.allowedEnv.filter((name) =>
    policyAllowed.has(name),
  )
  if (executionEnvironment) {
    Object.assign(env, executionEnvironment.selectEnv(allowedNames))
  } else {
    for (const name of allowedNames) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
  }
  return env
}

function resultFromCommandExit(
  eventName: HookEventName,
  code: number,
  started: number,
  stdout: ByteTailBuffer,
  stderr: ByteTailBuffer,
): HookExecutorResultV2 {
  if (code === 2) {
    const reason = stderr.text().trim() || 'Hook denied'
    const parsed = parseHookOutput(eventName, { decision: 'deny', reason })
    if (parsed.output)
      return commandResult({
        outcome: 'completed',
        output: parsed.output,
        reason,
        started,
        stdout,
        stderr,
      })
    return commandResult({
      outcome: 'failed',
      reason: parsed.diagnostics.map((item) => item.message).join('; '),
      started,
      stdout,
      stderr,
    })
  }
  if (code !== 0) {
    return commandResult({
      outcome: 'failed',
      reason: stderr.text().trim() || `Hook exited with code ${code}`,
      started,
      stdout,
      stderr,
    })
  }
  const raw = stdout.text().trim()
  let value: unknown = {}
  if (raw.startsWith('{')) {
    try {
      value = JSON.parse(raw)
    } catch (error) {
      return commandResult({
        outcome: 'failed',
        reason: `Invalid hook JSON output: ${error instanceof Error ? error.message : String(error)}`,
        started,
        stdout,
        stderr,
      })
    }
  } else if (raw) {
    value = { systemMessage: raw }
  }
  const parsed = parseHookOutput(eventName, value)
  if (!parsed.output) {
    return commandResult({
      outcome: 'failed',
      reason:
        parsed.diagnostics.map((item) => item.message).join('; ') ||
        'Invalid hook output',
      started,
      stdout,
      stderr,
    })
  }
  return commandResult({
    outcome: 'completed',
    output: parsed.output,
    reason:
      typeof parsed.output.reason === 'string' ? parsed.output.reason : 'ok',
    started,
    stdout,
    stderr,
  })
}

function commandResult(opts: {
  outcome: HookExecutorOutcome
  output?: Record<string, unknown> | null
  reason: string
  started: number
  stdout: ByteTailBuffer
  stderr: ByteTailBuffer
}): HookExecutorResultV2 {
  return {
    outcome: opts.outcome,
    output: opts.output ?? null,
    reason: opts.reason,
    durationMs: Date.now() - opts.started,
    stdout: opts.stdout.text(),
    stderr: opts.stderr.text(),
    stdoutBytes: opts.stdout.bytes,
    stderrBytes: opts.stderr.bytes,
    stdoutTruncated: opts.stdout.truncated,
    stderrTruncated: opts.stderr.truncated,
  }
}

function emptyExecutorResult(
  outcome: HookExecutorOutcome,
  reason: string,
  started = Date.now(),
): HookExecutorResultV2 {
  return {
    outcome,
    output: null,
    reason,
    durationMs: Date.now() - started,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

export async function executeHook(
  hook: HookDefinition,
  input: HookInput,
): Promise<HookExecutionResult> {
  const started = Date.now()
  if (hook.handler.async) {
    void executeHookSync(hook, input).catch(() => {})
    return {
      hookId: hook.id,
      status: 'skipped',
      decision: 'passthrough',
      reason: 'async hook accepted',
      durationMs: Date.now() - started,
    }
  }
  return executeHookSync(hook, input)
}

async function executeHookSync(
  hook: HookDefinition,
  input: HookInput,
): Promise<HookExecutionResult> {
  const started = Date.now()
  if (hook.handler.type === 'command') {
    return executeCommandHook(hook.id, hook.handler, input, started)
  }
  return executeHttpHook(hook.id, hook.handler, input, started)
}

async function executeCommandHook(
  hookId: string,
  handler: HookCommandHandler,
  input: HookInput,
  started: number,
): Promise<HookExecutionResult> {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  const result = await legacyHookProcessRunner.run({
    executable: handler.command,
    args: handler.args,
    cwd,
    env: allowedEnv(handler.allowedEnv) as Record<string, string>,
    stdin: `${JSON.stringify(input)}\n`,
    timeoutMs: handler.timeoutMs,
    maxOutputBytes: MAX_OUTPUT_CHARS,
    outputPolicy: 'truncate_tail',
    outputQuotaScope: 'per_stream',
    owner: { kind: 'hook', id: hookId, sessionId: null },
    containment: {
      mode: 'preferred',
      workspaceRoot: cwd,
      stateRoot: null,
      tempRoot: cwd,
      readOnlyRoots: [],
      network: 'allow',
    },
  })
  const stdout = capOutput(result.stdout)
  const stderr = capOutput(result.stderr)
  if (result.status === 'timeout')
    return {
      hookId,
      status: 'timeout',
      decision: 'passthrough',
      reason: `Hook timed out after ${handler.timeoutMs}ms`,
      durationMs: Date.now() - started,
      stdout,
      stderr,
    }
  if (result.status !== 'completed')
    return {
      hookId,
      status: 'failed',
      decision: 'passthrough',
      reason: result.error || `Hook process failed: ${result.status}`,
      durationMs: Date.now() - started,
      stdout,
      stderr,
    }
  return resultFromProcessExit(
    hookId,
    result.exitCode ?? 0,
    stdout,
    stderr,
    Date.now() - started,
  )
}

async function executeHttpHook(
  hookId: string,
  handler: HookHttpHandler,
  input: HookInput,
  started: number,
): Promise<HookExecutionResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), handler.timeoutMs)
  try {
    const response = await fetch(handler.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...handler.headers },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
    const text = capOutput(await response.text())
    if (!response.ok) {
      return {
        hookId,
        status: 'failed',
        decision: 'passthrough',
        reason: `HTTP ${response.status}`,
        durationMs: Date.now() - started,
        stdout: text,
      }
    }
    return resultFromJson(hookId, text, Date.now() - started, {
      status: 'completed',
      fallbackReason: response.statusText || 'ok',
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      hookId,
      status: aborted ? 'timeout' : 'failed',
      decision: 'passthrough',
      reason: aborted
        ? `Hook timed out after ${handler.timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

function resultFromProcessExit(
  hookId: string,
  code: number,
  stdout: string,
  stderr: string,
  durationMs: number,
): HookExecutionResult {
  if (code === 2) {
    return {
      hookId,
      status: 'failed',
      decision: 'deny',
      reason: stderr.trim() || 'Hook denied',
      durationMs,
      stdout,
      stderr,
    }
  }
  if (code !== 0) {
    return {
      hookId,
      status: 'failed',
      decision: 'passthrough',
      reason: stderr.trim() || `Hook exited with code ${code}`,
      durationMs,
      stdout,
      stderr,
    }
  }
  return resultFromJson(hookId, stdout, durationMs, {
    status: 'completed',
    fallbackReason: 'ok',
    stderr,
  })
}

function resultFromJson(
  hookId: string,
  raw: string,
  durationMs: number,
  opts: {
    status: HookExecutionResult['status']
    fallbackReason: string
    stderr?: string
  },
): HookExecutionResult {
  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      hookId,
      status: opts.status,
      decision: 'passthrough',
      reason: opts.fallbackReason,
      durationMs,
      stdout: raw,
      stderr: opts.stderr,
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const decision = parseDecision(parsed.decision)
    const result: HookExecutionResult = {
      hookId,
      status: opts.status,
      decision,
      reason:
        typeof parsed.reason === 'string' ? parsed.reason : opts.fallbackReason,
      durationMs,
      stdout: raw,
      stderr: opts.stderr,
    }
    if (typeof parsed.additionalContext === 'string')
      result.additionalContext = parsed.additionalContext
    if (isRecord(parsed.updatedInput)) result.updatedInput = parsed.updatedInput
    return result
  } catch {
    return {
      hookId,
      status: opts.status,
      decision: 'passthrough',
      reason: opts.fallbackReason,
      durationMs,
      stdout: raw,
      stderr: opts.stderr,
    }
  }
}

function parseDecision(value: unknown): HookDecision {
  return value === 'deny' ||
    value === 'ask' ||
    value === 'allow' ||
    value === 'passthrough'
    ? value
    : 'passthrough'
}

function allowedEnv(names: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function capOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS
    ? value.slice(0, MAX_OUTPUT_CHARS)
    : value
}
