import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  DEFAULT_DEVELOPMENT_ENVIRONMENT,
  type DevelopmentEnvironmentSettings,
} from './dev-environment'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  DEFAULT_CLAUDE_MAX_TURNS,
  DelegationError,
  type ExecutorConfig,
} from './types'
import { durableReplaceSync } from '../../store/persistence'
export { executorSpecialties } from './specialties'
const segment = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const profile = z
  .object({
    id: segment,
    backend: z.enum(['claude-code', 'codex']),
    enabled: z.boolean(),
    executableSource: z.enum(['bundled', 'system']).optional(),
    executablePath: z
      .string()
      .min(1)
      .refine((p) => isAbsolute(p) || p === 'claude' || p === 'codex'),
    // Legacy exact-version pin (AGT-01): accepted, ignored and dropped.
    expectedVersion: z.string().max(64).optional(),
    customModels: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .refine(
            (s) =>
              ![...s].some(
                (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
              ),
          ),
      )
      .max(64)
      .transform((xs) => [...new Set(xs)])
      .optional(),
    defaultModel: z.string().min(1).max(256).optional(),
    specialties: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine((s) => [...s].length <= 24),
      )
      .max(6)
      .optional(),
    authRef: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('model-route'),
          routeId: z.string().max(256),
        })
        .strict(),
      z.object({ kind: z.literal('managed-cli-login') }).strict(),
    ]),
    stateDirectoryId: segment,
    concurrencyLimit: z.number().int().min(1).max(2),
  })
  .strict()
export const executorConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    profiles: z.array(profile).max(32),
    limits: z
      .object({
        globalConcurrency: z.number().int().min(1).max(2),
        maxQueuedMessages: z.number().int().min(1).max(16),
        maxRunsPerTask: z.number().int().min(1).max(32),
        maxDepth: z.number().int().min(1).max(3),
        runTimeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(120 * 60_000),
        questionTimeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(15 * 60_000),
        estimatedBudgetUsd: z.number().positive().max(10),
        // 设置 › 子智能体 › 高级 (AGT-02).
        claudeMaxTurns: z.number().int().min(50).max(1000).optional(),
      })
      .strict(),
    touchedAt: z.number().int().nonnegative().optional(),
    upgradeNotice: z.literal('external-default-off').optional(),
    diagnosticsMode: z.boolean().optional(),
    verifyBeforeApply: z.boolean().optional(),
    // 设置 › 子智能体 › 高级 › 开发环境 (AGT-08).
    developmentEnvironment: z
      .object({
        gitIdentity: z.boolean(),
        proxy: z.boolean(),
        sshAgent: z.boolean(),
        toolchains: z.boolean(),
        github: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      c.profiles.some(
        (p) => p.backend === 'codex' && p.executableSource === 'bundled',
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'only Claude Code ships a bundled binary',
      })
    for (const ids of [
      c.profiles.map((p) => p.id),
      c.profiles.map((p) => p.stateDirectoryId),
    ])
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: 'custom',
          message: 'profile ids and state directories must be unique',
        })
  })
export function parseExecutorConfig(value: unknown): ExecutorConfig {
  const result = executorConfigSchema.safeParse(value)
  if (!result.success)
    throw new DelegationError(
      'EXECUTOR_CONFIG_INVALID',
      'configuration does not match the supported schema',
    )
  // Older defaults referenced no model at all. Reuse the local login without
  // changing saved enable/path/model choices or rewriting the source file.
  for (const profile of result.data.profiles) {
    if (profile.authRef.kind === 'model-route' && !profile.authRef.routeId)
      profile.authRef = { kind: 'managed-cli-login' }
    delete profile.expectedVersion
  }
  return result.data
}
function hasLegacyVersionPin(value: unknown): boolean {
  const profiles = (value as { profiles?: unknown } | null)?.profiles
  return (
    Array.isArray(profiles) &&
    profiles.some((p) => !!p && typeof p === 'object' && 'expectedVersion' in p)
  )
}
export function defaultExecutorConfig(): ExecutorConfig {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: [
      // External executors spend the user's own subscription or API quota:
      // off until the user turns them on (AGT-05).
      {
        id: 'claude-default',
        backend: 'claude-code',
        enabled: false,
        executableSource: 'bundled',
        executablePath: 'claude',
        authRef: { kind: 'managed-cli-login' },
        stateDirectoryId: 'claude-default',
        concurrencyLimit: 1,
      },
      {
        id: 'codex-default',
        backend: 'codex',
        enabled: false,
        executablePath: 'codex',
        authRef: { kind: 'managed-cli-login' },
        stateDirectoryId: 'codex-default',
        concurrencyLimit: 1,
      },
    ],
    limits: {
      globalConcurrency: 2,
      maxQueuedMessages: 16,
      maxRunsPerTask: 32,
      maxDepth: 3,
      runTimeoutMs: 30 * 60_000,
      questionTimeoutMs: 15 * 60_000,
      estimatedBudgetUsd: 10,
    },
  }
}
export class ExecutorConfigStore {
  readonly file: string
  constructor(readonly root: string) {
    this.file = join(root, 'config.json')
  }
  read(): ExecutorConfig {
    if (!existsSync(this.file)) {
      const config = defaultExecutorConfig()
      // Never saved, but external tasks ran under the old enabled default.
      if (this.ranExternalTasks()) config.upgradeNotice = 'external-default-off'
      return config
    }
    let raw: unknown, config: ExecutorConfig
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
      config = parseExecutorConfig(raw)
    } catch {
      throw new DelegationError(
        'EXECUTOR_CONFIG_INVALID',
        'invalid or unsupported configuration; original file retained',
      )
    }
    // External executors are opt-in (AGT-05). A file the user never saved
    // through settings (no touchedAt) holds the old enabled default, not a
    // choice: turn those off once and explain it on the settings page.
    let rewrite = hasLegacyVersionPin(raw)
    if (
      config.touchedAt === undefined &&
      config.profiles.some((p) => p.enabled)
    ) {
      for (const profile of config.profiles) profile.enabled = false
      config.upgradeNotice = 'external-default-off'
      rewrite = true
    }
    // Compatibility is a handshake now (AGT-01). Drop the old exact-version
    // pin from the file once. The revision is unchanged in both cases: no
    // choice of the user's changed.
    if (rewrite)
      try {
        durableReplaceSync(this.file, JSON.stringify(config, null, 2) + '\n')
      } catch {
        /* Still applied in memory; the next save persists it. */
      }
    return config
  }
  private ranExternalTasks(): boolean {
    try {
      return readdirSync(join(this.root, 'conversations')).some((name) =>
        name.startsWith('dlg-'),
      )
    } catch {
      return false
    }
  }
  update(expectedRevision: number, value: unknown): ExecutorConfig {
    const current = this.read()
    if (current.revision !== expectedRevision)
      throw new DelegationError(
        'STALE_REVISION',
        'executor configuration changed',
      )
    const next = parseExecutorConfig(value)
    next.revision = current.revision + 1
    // Saving is the user's choice: later upgrades keep it, the notice is seen.
    next.touchedAt = Date.now()
    delete next.upgradeNotice
    // Written only when on, so an older build can still read the file.
    if (!next.diagnosticsMode) delete next.diagnosticsMode
    if (!next.verifyBeforeApply) delete next.verifyBeforeApply
    if (next.limits.claudeMaxTurns === DEFAULT_CLAUDE_MAX_TURNS)
      delete next.limits.claudeMaxTurns
    if (
      next.developmentEnvironment &&
      sameDevelopmentEnvironment(
        next.developmentEnvironment,
        DEFAULT_DEVELOPMENT_ENVIRONMENT,
      )
    )
      delete next.developmentEnvironment
    durableReplaceSync(this.file, JSON.stringify(next, null, 2) + '\n')
    return next
  }
}

/** What a task's environment passes through: the saved switches, else the defaults. */
export function developmentEnvironmentOf(
  config: Pick<ExecutorConfig, 'developmentEnvironment'>,
): DevelopmentEnvironmentSettings {
  return config.developmentEnvironment ?? DEFAULT_DEVELOPMENT_ENVIRONMENT
}

function sameDevelopmentEnvironment(
  left: DevelopmentEnvironmentSettings,
  right: DevelopmentEnvironmentSettings,
): boolean {
  return (
    left.gitIdentity === right.gitIdentity &&
    left.proxy === right.proxy &&
    left.sshAgent === right.sshAgent &&
    left.toolchains === right.toolchains &&
    left.github === right.github
  )
}
