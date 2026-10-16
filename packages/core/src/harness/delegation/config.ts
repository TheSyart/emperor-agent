import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { DelegationError, type ExecutorConfig } from './types'
import { durableReplaceSync } from '../../store/persistence'
const segment = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const profile = z
  .object({
    id: segment,
    backend: z.enum(['claude-code', 'codex']),
    enabled: z.boolean(),
    executablePath: z
      .string()
      .min(1)
      .refine((p) => isAbsolute(p) || p === 'claude' || p === 'codex'),
    expectedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    defaultModel: z.string().min(1).max(256).optional(),
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
const schema = z
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
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
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
  const result = schema.safeParse(value)
  if (!result.success)
    throw new DelegationError(
      'EXECUTOR_CONFIG_INVALID',
      'configuration does not match the supported schema',
    )
  return result.data
}
export function defaultExecutorConfig(): ExecutorConfig {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: [
      {
        id: 'claude-default',
        backend: 'claude-code',
        enabled: false,
        executablePath: 'claude',
        expectedVersion: '2.1.281',
        authRef: { kind: 'model-route', routeId: '' },
        stateDirectoryId: 'claude-default',
        concurrencyLimit: 1,
      },
      {
        id: 'codex-default',
        backend: 'codex',
        enabled: false,
        executablePath: 'codex',
        expectedVersion: '0.153.4',
        authRef: { kind: 'model-route', routeId: '' },
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
    if (!existsSync(this.file)) return defaultExecutorConfig()
    try {
      return parseExecutorConfig(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      throw new DelegationError(
        'EXECUTOR_CONFIG_INVALID',
        'invalid or unsupported configuration; original file retained',
      )
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
    durableReplaceSync(this.file, JSON.stringify(next, null, 2) + '\n')
    return next
  }
}
