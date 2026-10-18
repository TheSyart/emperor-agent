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
export interface NativeModel {
  id: string
  name?: string
}
export type PreparedExecutor = Awaited<
  ReturnType<ExecutorRuntimeService['prepare']>
>
export async function readNativeModels(
  profile: ExecutorProfile,
  runtime: PreparedExecutor,
  processes: ManagedAgentProcess,
  signal: AbortSignal,
): Promise<NativeModel[]> {
  let handle: ManagedProcessHandle | undefined,
    rpc: CodexRpc | undefined,
    warm: WarmQuery | undefined,
    query: Query | undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const policy = {
    mode: 'read-only' as const,
    workspaceRoot: runtime.runtimeRoot,
    runtimeStateRoots: [runtime.runtimeRoot],
    privateTempRoot: runtime.tempRoot,
  }
  try {
    if (profile.backend === 'codex') {
      handle = processes.spawn({
        executable: profile.executablePath,
        args: [
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'mcp_servers={}',
          '-c',
          'features.hooks=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.memories=false',
        ],
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
        const result = await rpc.request(
          'model/list',
          { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
          signal,
        )
        if (Array.isArray(result.data))
          for (const raw of result.data) {
            const row = raw as Record<string, unknown>,
              id = row.model ?? row.id
            if (typeof id === 'string')
              models.push({
                id,
                ...(typeof row.displayName === 'string'
                  ? { name: row.displayName }
                  : {}),
              })
          }
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
      pathToClaudeCodeExecutable: profile.executablePath,
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
        enabledPlugins: {
          'agents-md@builtin': false,
          'telemetry@builtin': false,
        },
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
    warm = await startup({ options, initializeTimeoutMs: 8000 })
    query = warm.query(new AsyncQueue())
    const models = await query.supportedModels()
    return models.map((row) => ({ id: row.value, name: row.displayName }))
  } finally {
    signal.removeEventListener('abort', abort)
    controller.abort()
    query?.close()
    warm?.close()
    rpc?.close()
    if (handle) await handle.terminate()
  }
}
