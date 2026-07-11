import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  environmentErrorCodeSchema,
  environmentSafeErrorSchema,
} from './errors'

export const ENVIRONMENT_TOOL_IDS = [
  'git',
  'ripgrep',
  'volta',
  'node',
  'npm',
  'uv',
  'python',
  'go',
  'rustup',
  'rust',
  'cargo',
  'msvc-build-tools',
] as const

export const ENVIRONMENT_TOOL_STATUSES = [
  'ready',
  'missing',
  'version_mismatch',
  'installing',
  'awaiting_user',
  'failed',
  'unsupported',
  'blocked',
] as const

export const ENVIRONMENT_JOB_STATUSES = [
  'planned',
  'running',
  'awaiting_user',
  'cancelling',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const
export const ENVIRONMENT_STEP_STATUSES = [
  'planned',
  'running',
  'awaiting_user',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'blocked',
] as const

export const environmentToolIdSchema = z.enum(ENVIRONMENT_TOOL_IDS)
export const environmentToolStatusSchema = z.enum(ENVIRONMENT_TOOL_STATUSES)
export const environmentJobStatusSchema = z.enum(ENVIRONMENT_JOB_STATUSES)
export const environmentStepStatusSchema = z.enum(ENVIRONMENT_STEP_STATUSES)
export const environmentPlatformSchema = z.enum(['darwin', 'win32', 'linux'])
export const environmentArchSchema = z.enum(['arm64', 'x64'])
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const environmentIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
export const isoTimestampSchema = z.string().refine(isIsoTimestamp, {
  message: 'expected an ISO-8601 UTC timestamp',
})

export type EnvironmentToolId = z.infer<typeof environmentToolIdSchema>
export type EnvironmentToolStatus = z.infer<typeof environmentToolStatusSchema>
export type EnvironmentJobStatus = z.infer<typeof environmentJobStatusSchema>
export type EnvironmentPlatform = z.infer<typeof environmentPlatformSchema>
export type EnvironmentArch = z.infer<typeof environmentArchSchema>

export const environmentToolStateSchema = z
  .object({
    id: environmentToolIdSchema,
    category: z.enum(['base', 'project', 'skill', 'large-prerequisite']),
    required: z.boolean(),
    reason: z.string().min(1).max(1_000),
    declarationSource: z.string().max(1_000).nullable(),
    status: environmentToolStatusSchema,
    detectedVersion: z.string().max(128).nullable(),
    versionSummary: z.string().max(512).nullable(),
    requiredVersion: z.string().max(128).nullable(),
    executablePath: z.string().max(4_096).nullable(),
    installStrategy: environmentIdSchema.nullable(),
    sourceUrl: z.string().url().nullable(),
    requiresElevation: z.boolean(),
    requiresSeparateConfirmation: z.boolean(),
  })
  .strict()

export type EnvironmentToolState = z.infer<typeof environmentToolStateSchema>

export const executionEnvironmentSnapshotSchema = z
  .object({
    revision: sha256Schema,
    projectFingerprint: sha256Schema,
    createdAt: isoTimestampSchema,
    pathEntries: z.array(z.string().min(1).max(4_096)).max(256),
    env: z.record(z.string(), z.string().max(32_768)),
    toolPaths: z.record(environmentToolIdSchema, z.string().max(4_096)),
  })
  .strict()

export type ExecutionEnvironmentSnapshot = z.infer<
  typeof executionEnvironmentSnapshotSchema
>

export const environmentInstallStepSchema = z
  .object({
    stepId: environmentIdSchema,
    toolId: environmentToolIdSchema,
    strategyId: environmentIdSchema,
    dependsOn: z.array(environmentIdSchema).max(32),
    status: environmentStepStatusSchema,
    requiresElevation: z.boolean(),
    requiresSeparateConfirmation: z.boolean(),
  })
  .strict()

export type EnvironmentInstallStep = z.infer<
  typeof environmentInstallStepSchema
>

export const environmentInstallPlanSchema = z
  .object({
    planId: environmentIdSchema,
    catalogRevision: sha256Schema,
    projectFingerprint: sha256Schema,
    toolStateHash: sha256Schema,
    expiresAt: isoTimestampSchema,
    steps: z.array(environmentInstallStepSchema).max(128),
    requiredLicenseIds: z.array(environmentIdSchema).max(64),
    warnings: z.array(z.string().max(1_000)).max(64),
  })
  .strict()

export type EnvironmentInstallPlan = z.infer<
  typeof environmentInstallPlanSchema
>

export const environmentJobRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: environmentIdSchema,
    planId: environmentIdSchema,
    catalogRevision: sha256Schema,
    projectFingerprint: sha256Schema,
    status: environmentJobStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    currentStepId: environmentIdSchema.nullable(),
    steps: z.array(environmentInstallStepSchema).max(128),
    error: environmentSafeErrorSchema.nullable(),
  })
  .strict()
  .superRefine((job, ctx) => {
    if (Date.parse(job.createdAt) > Date.parse(job.updatedAt))
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt must not precede createdAt',
      })
  })

export type EnvironmentJobRecord = z.infer<typeof environmentJobRecordSchema>

export const environmentReceiptStepSchema = z
  .object({
    stepId: environmentIdSchema,
    toolId: environmentToolIdSchema,
    outcome: z.enum(['completed', 'failed', 'skipped', 'cancelled']),
    detectedVersion: z.string().max(128).nullable(),
    errorCode: environmentErrorCodeSchema.nullable(),
  })
  .strict()

export const environmentReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: environmentIdSchema,
    planId: environmentIdSchema,
    catalogRevision: sha256Schema,
    appVersion: z.string().min(1).max(128),
    runtimeRevision: sha256Schema,
    platform: environmentPlatformSchema,
    arch: environmentArchSchema,
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema,
    status: environmentJobStatusSchema,
    steps: z.array(environmentReceiptStepSchema).max(128),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt))
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt must not precede startedAt',
      })
  })

export type EnvironmentReceipt = z.infer<typeof environmentReceiptSchema>

export const environmentLogInputSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    kind: environmentIdSchema,
    message: z.string().max(65_536),
    details: z.record(z.string(), z.unknown()),
  })
  .strict()

export const environmentLogRecordSchema = environmentLogInputSchema.extend({
  schemaVersion: z.literal(1),
  timestamp: isoTimestampSchema,
  jobId: environmentIdSchema,
})

export type EnvironmentLogInput = z.infer<typeof environmentLogInputSchema>
export type EnvironmentLogRecord = z.infer<typeof environmentLogRecordSchema>

export function stableEnvironmentHash(value: unknown): string {
  return createHash('sha256').update(stableEnvironmentJson(value)).digest('hex')
}

function stableEnvironmentJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])]),
  )
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return false
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z')
  return new Date(timestamp).toISOString() === normalized
}
