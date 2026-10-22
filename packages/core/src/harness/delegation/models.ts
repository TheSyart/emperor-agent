import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { durableReplaceSync } from '../../store/persistence'
import { ManagedAgentProcess } from './process'
import {
  readNativeModels,
  type NativeModel,
  type PreparedExecutor,
} from './native-models'
import type { ExecutorRuntimeService } from './runtime'
import { replacementModel } from './model-choice'
import type {
  ExecutorProfile,
  ExecutorModelCatalog,
  ExecutorModelCandidate,
} from './types'
interface CacheRow {
  checkedAt: number
  models: NativeModel[]
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const modelId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= 256 &&
  ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
export class ExecutorModelCatalogService {
  private cache: Record<string, CacheRow> = {}
  private flights = new Map<string, Promise<ExecutorModelCatalog>>()
  private controllers = new Set<AbortController>()
  private closed = false
  private closing?: Promise<void>
  private readonly file: string
  constructor(
    private readonly options: {
      root: string
      runtime: ExecutorRuntimeService
      processes?: ManagedAgentProcess
      onPrepared?: (profile: ExecutorProfile, runtime: PreparedExecutor) => void
      readNative?: (
        profile: ExecutorProfile,
        runtime: PreparedExecutor,
      ) => Promise<NativeModel[]>
      /**
       * False when the last check found Claude Code not signed in (its own
       * login is claude's, AGT-12): its CLI is not started for a list.
       */
      signedIn?: (profile: ExecutorProfile) => boolean
    },
  ) {
    this.file = join(options.root, 'model-catalog-cache.json')
    try {
      const raw = readFileSync(this.file)
      if (raw.length <= 2 * 1024 * 1024) {
        const value = JSON.parse(raw.toString())
        if (
          value.schemaVersion === 1 &&
          value.entries &&
          typeof value.entries === 'object'
        )
          this.cache = value.entries
      }
    } catch {
      /* Rebuildable cache; never a configuration source. */
    }
  }
  close() {
    this.closed = true
    for (const c of this.controllers) c.abort()
    this.closing ??= Promise.allSettled([...this.flights.values()]).then(() => {
      this.controllers.clear()
    })
    return this.closing
  }
  list(
    profile: ExecutorProfile,
    refresh = false,
  ): Promise<ExecutorModelCatalog> {
    const key = digest(profile),
      prior = this.flights.get(key)
    if (prior) return prior
    const pending = this.load(profile, refresh).finally(() =>
      this.flights.delete(key),
    )
    this.flights.set(key, pending)
    return pending
  }
  private async load(
    profile: ExecutorProfile,
    refresh: boolean,
  ): Promise<ExecutorModelCatalog> {
    if (this.closed) throw Error('model catalog closed')
    const models = new Map<string, ExecutorModelCandidate>()
    const add = (
      id: unknown,
      source: ExecutorModelCandidate['source'],
      name?: unknown,
    ) => {
      if (modelId(id) && !models.has(id.trim()))
        models.set(id.trim(), {
          id: id.trim(),
          name:
            typeof name === 'string' && name.length <= 256 ? name : id.trim(),
          source,
        })
    }
    for (const id of profile.customModels ?? []) add(id, 'custom')
    if (profile.defaultModel) add(profile.defaultModel, 'configuration')
    let runtime: PreparedExecutor | undefined,
      provider: string | null = null,
      configuredModel: string | null = profile.defaultModel ?? null,
      diagnostic: string | null = null,
      checkedAt: number | null = null,
      defaultUnavailable: ExecutorModelCatalog['defaultUnavailable'] = null
    try {
      runtime = await this.options.runtime.prepare(
        profile,
        'dlg-models-' + randomUUID(),
        { allowUnauthenticatedConfig: true },
      )
      if (this.closed) throw Error('model catalog closed')
      this.options.onPrepared?.(profile, runtime)
      const env = runtime.environment
      const native =
        profile.backend === 'codex'
          ? (env.EMPEROR_EXECUTOR_PROVIDER ?? 'openai') === 'openai' &&
            (!env.OPENAI_BASE_URL ||
              /^https:\/\/api\.openai\.com\/?(?:v1)?\/?$/.test(
                env.OPENAI_BASE_URL,
              ))
          : !env.ANTHROPIC_BASE_URL ||
            /^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)
      provider =
        env.EMPEROR_EXECUTOR_PROVIDER ??
        (profile.backend === 'claude-code'
          ? (env.ANTHROPIC_BASE_URL ?? 'anthropic')
          : (env.OPENAI_BASE_URL ?? 'openai'))
      configuredModel =
        profile.defaultModel ??
        env.ANTHROPIC_MODEL ??
        env.EMPEROR_EXECUTOR_MODEL ??
        null
      if (configuredModel) add(configuredModel, 'configuration')
      if (profile.backend === 'claude-code')
        for (const [key, value] of Object.entries(env))
          if (/^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key))
            add(value, 'configuration')
      const identity = {
        config: env.EMPEROR_EXECUTOR_CONFIG_FINGERPRINT,
        provider,
        model: configuredModel,
        executable: profile.executablePath,
        authRef: profile.authRef,
        credentials: runtime.secretValues,
      }
      const key = digest(identity),
        cached = this.cache[key]
      const validCache =
        cached &&
        Number.isFinite(cached.checkedAt) &&
        Array.isArray(cached.models)
      checkedAt = validCache ? cached.checkedAt : null
      let discovered: NativeModel[] = [],
        source: ExecutorModelCandidate['source'] = 'cli'
      if (!runtime.authenticationAvailable) {
        diagnostic =
          '当前隔离执行读取不到认证，仅展示配置与参考候选；执行前请完成登录接入。'
      } else if (this.options.signedIn?.(profile) === false) {
        diagnostic =
          'Claude Code 还没有登录，仅展示配置与参考候选；登录后点「刷新模型」。'
      } else if (
        !refresh &&
        validCache &&
        Date.now() - cached.checkedAt < 15 * 60_000
      ) {
        discovered = cached.models
        source = 'cache'
      } else {
        const controller = new AbortController()
        this.controllers.add(controller)
        const timer = setTimeout(() => controller.abort(), 12000)
        try {
          discovered = await (this.options.readNative
            ? this.options.readNative(profile, runtime)
            : readNativeModels(
                profile,
                runtime,
                this.options.processes ?? new ManagedAgentProcess(),
                controller.signal,
              ))
          // A custom Codex provider can receive the bundled OpenAI picker catalog. Keep only explicit local/catalog ids in that case.
          if (profile.backend === 'codex' && !native) {
            const path = join(env.CODEX_HOME!, 'config.toml'),
              config = existsSync(path) ? parse(readFileSync(path, 'utf8')) : {}
            if (!config.model_catalog_json)
              discovered = discovered.filter((m) => models.has(m.id))
          }
          discovered = discovered
            .filter(
              (row) =>
                modelId(row.id) &&
                !runtime!.secretValues.some(
                  (secret) =>
                    secret.length >= 8 &&
                    (row.id.includes(secret) || row.name?.includes(secret)),
                ),
            )
            .slice(0, 512)
          checkedAt = Date.now()
          this.cache[key] = { checkedAt, models: discovered }
          const entries = Object.fromEntries(
            Object.entries(this.cache)
              .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
              .slice(0, 64),
          )
          while (
            Buffer.byteLength(JSON.stringify(entries)) > 1800000 &&
            Object.keys(entries).length > 1
          )
            delete entries[Object.keys(entries).at(-1)!]
          this.cache = entries
          durableReplaceSync(
            this.file,
            JSON.stringify({ schemaVersion: 1, entries }),
          )
        } catch {
          diagnostic = '未能更新模型列表，已保留本机配置与已有候选。'
          if (validCache) {
            discovered = cached.models
            source = 'cache'
          }
        } finally {
          clearTimeout(timer)
          this.controllers.delete(controller)
        }
      }
      // The picker offers what Codex's own picker shows (FIX-16).
      for (const row of discovered)
        if (!row.hidden) add(row.id, source, row.name)
      // Codex's own default (its config.toml, as the run inherits it) is
      // not in the list this login offers: say so, and what a run that
      // follows the CLI uses instead (FIX-16).
      const own =
        profile.backend === 'codex' ? env.EMPEROR_EXECUTOR_MODEL : undefined
      const replacement = own ? replacementModel(discovered, own) : undefined
      if (own && replacement) defaultUnavailable = { model: own, replacement }
      const claudeSettings =
        profile.backend === 'claude-code'
          ? JSON.parse(
              existsSync(join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))
                ? readFileSync(
                    join(env.CLAUDE_CONFIG_DIR!, 'settings.json'),
                    'utf8',
                  )
                : '{}',
            )
          : {}
      const restricted =
        Array.isArray(claudeSettings.availableModels) ||
        claudeSettings.modelPicker?.replaceBuiltInOptions === true
      if (!discovered.some((row) => !row.hidden) && native && !restricted)
        for (const id of profile.backend === 'codex'
          ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol']
          : ['sonnet', 'opus', 'haiku'])
          add(id, 'builtin')
    } catch {
      diagnostic = '无法读取当前接入，仍可选择已保存模型或自定义模型。'
    } finally {
      if (runtime) rmSync(runtime.runtimeRoot, { recursive: true, force: true })
    }
    if (provider?.includes('://')) {
      try {
        const url = new URL(provider)
        provider = url.origin + url.pathname
      } catch {
        provider = '自定义提供方'
      }
    }
    return {
      profileId: profile.id,
      models: [...models.values()],
      configuredModel,
      provider,
      checkedAt,
      diagnostic,
      defaultUnavailable,
    }
  }
}
