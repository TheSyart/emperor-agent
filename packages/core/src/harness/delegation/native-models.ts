import {
  startup,
  type Query,
  type WarmQuery,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ManagedAgentProcess, type ManagedProcessHandle } from './process'
import { CodexRpc } from './adapters/codex-rpc'
import { AsyncQueue } from './adapters/async-queue'
import type { ExecutorProfile } from './types'
import type { ExecutorRuntimeService } from './runtime'
import { claudeModelSettings } from './local-model-config'
import { findExecutable } from './executable'
import { executorGrants } from './environment'
import { acquireCodexAuth, type CodexAuthLease } from './codex-auth'
import { codexAppServerArgs } from './adapters/codex'
import { codexModelRows, type OfferedModel } from './model-choice'
import { BuiltinPluginLedger } from './claude-builtin-plugins'
/**
 * A model the CLI lists for this login. Codex also says which is its
 * default and which its picker hides (FIX-16).
 */
export type NativeModel = OfferedModel
export type PreparedExecutor = Awaited<
  ReturnType<ExecutorRuntimeService['prepare']>
>
export async function readNativeModels(
  profile: ExecutorProfile,
  runtime: PreparedExecutor,
  processes: ManagedAgentProcess,
  signal: AbortSignal,
  sdk: {
    /** Claude Code's builtins, off as in a run (default: the seed). */
    ledger?: BuiltinPluginLedger
    /** Test hook: the Agent SDK's startup. */
    startup?: (options: Options) => Promise<Pick<WarmQuery, 'query' | 'close'>>
  } = {},
): Promise<NativeModel[]> {
  let handle: ManagedProcessHandle | undefined,
    lease: CodexAuthLease | undefined,
    rpc: CodexRpc | undefined,
    warm: Pick<WarmQuery, 'query' | 'close'> | undefined,
    query: Query | undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const policy = {
    mode: 'read-only' as const,
    workspaceRoot: runtime.runtimeRoot,
    privateTempRoot: runtime.tempRoot,
    ...executorGrants(runtime),
  }
  try {
    if (profile.backend === 'codex') {
      // Listing models may refresh the login too. Never wait behind a running
      // Codex task for a picker: keep the cached list instead.
      if (runtime.codexAuth) {
        lease = await acquireCodexAuth(runtime.codexAuth, {
          signal,
          wait: false,
        })
        if (!lease) throw new Error('another Codex process is using this login')
      }
      handle = processes.spawn({
        executable: profile.executablePath,
        // The same features as a run (AGT-13): no daemon, worktrees,
        // plugins or hooks from a process started only to list models.
        args: codexAppServerArgs(),
        cwd: runtime.runtimeRoot,
        env: runtime.environment,
        policy,
        signal,
        secretValues: runtime.secretValues,
      })
      await handle.started
      rpc = new CodexRpc({
        input: handle.stdout,
        output: handle.stdin,
        generation: 1,
        requestTimeoutMs: 8000,
        idleTimeoutMs: 10000,
        secretValues: runtime.secretValues,
        onRequest: (id) => {
          void rpc!.reject(
            id,
            -32601,
            'Model discovery cannot execute tools',
            1,
          )
        },
      })
      await rpc.request(
        'initialize',
        {
          clientInfo: { name: 'emperor-model-picker', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        },
        signal,
      )
      await rpc.notify('initialized')
      // Read the same effective isolated configuration used by execution. No thread or turn is created.
      await rpc.request(
        'config/read',
        { includeLayers: false, cwd: runtime.runtimeRoot },
        signal,
      )
      const models: NativeModel[] = [],
        cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < 8; page++) {
        // Hidden models too: one the picker leaves out still runs, and a
        // default that is only hidden is still offered (FIX-16).
        const result = await rpc.request(
          'model/list',
          { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
          signal,
        )
        models.push(...codexModelRows(result.data))
        if (typeof result.nextCursor !== 'string' || !result.nextCursor) break
        if (cursors.has(result.nextCursor)) throw Error('repeated model cursor')
        cursor = result.nextCursor
        cursors.add(cursor)
      }
      return models
    }
    let settings: Record<string, unknown> = {}
    try {
      settings = claudeModelSettings(
        JSON.parse(
          readFileSync(
            join(runtime.environment.CLAUDE_CONFIG_DIR!, 'settings.json'),
            'utf8',
          ),
        ),
      )
    } catch {
      /* no model policy configured */
    }
    const options: Options = {
      cwd: runtime.runtimeRoot,
      // The installed claude (AGT-12); runtime.prepare put its folder on PATH.
      pathToClaudeCodeExecutable:
        findExecutable(profile.executablePath, runtime.environment.PATH) ??
        profile.executablePath,
      env: runtime.environment,
      abortController: controller,
      settingSources: [],
      tools: [],
      allowedTools: [],
      agents: {},
      plugins: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      settings: {
        ...settings,
        // The same builtins a run turns off (VER-02): the seed and every
        // one Emperor learned.
        enabledPlugins: (
          sdk.ledger ?? new BuiltinPluginLedger()
        ).enabledPluginsSetting(),
        syncClaudeAiSkills: false,
        syncClaudeAiPlugins: false,
      },
      spawnClaudeCodeProcess: (spec) => {
        handle = processes.spawn({
          executable: spec.command,
          args: spec.args,
          cwd: runtime.runtimeRoot,
          env: { ...runtime.environment, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
          policy,
          signal,
          secretValues: runtime.secretValues,
        })
        return handle.spawnedProcess
      },
    }
    warm = await (sdk.startup
      ? sdk.startup(options)
      : startup({ options, initializeTimeoutMs: 8000 }))
    query = warm.query(new AsyncQueue())
    const models = await query.supportedModels()
    return models.map((row) => ({ id: row.value, name: row.displayName }))
  } finally {
    signal.removeEventListener('abort', abort)
    controller.abort()
    query?.close()
    warm?.close()
    rpc?.close()
    try {
      if (handle) await handle.terminate()
    } finally {
      await lease?.release()
    }
  }
}
