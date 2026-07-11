import { z } from 'zod'
import type { CoreApi } from './core-api'

const dictSchema = z.record(z.string(), z.unknown())
const idSchema = z.string().trim().min(1)
const taskIdSchema = idSchema.refine(
  (value) =>
    /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(value) && !value.includes('..'),
  'invalid task id',
)
const skillNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+$/, 'invalid skill name')
const creatorSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'invalid creator skill name')
const skillCreateSchema = z
  .object({
    name: creatorSkillNameSchema,
    description: z.string().trim().min(1).max(1_024),
    resources: z
      .array(z.enum(['scripts', 'references', 'assets']))
      .max(3)
      .optional(),
  })
  .strict()
const skillValidateSchema = z
  .object({
    name: creatorSkillNameSchema,
    content: z.string().optional(),
  })
  .strict()
const skillPackageSchema = z.object({ name: creatorSkillNameSchema }).strict()
const nullableStringSchema = z.string().nullable().optional()
const numberLikeSchema = z.union([z.number(), z.string()]).nullable().optional()
const booleanLikeSchema = z
  .union([z.boolean(), z.string()])
  .nullable()
  .optional()

const controlResumeSchema = z
  .object({
    clientMessageId: nullableStringSchema,
    turnId: nullableStringSchema,
    displayContent: nullableStringSchema,
    uiHidden: z.boolean().nullable().optional(),
  })
  .strict()

const draftSessionSchema = z
  .object({
    mode: nullableStringSchema,
    project: z
      .object({
        project_id: nullableStringSchema,
        project_path: nullableStringSchema,
        project_name: nullableStringSchema,
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()

const chatSubmitSchema = z
  .object({
    content: z.string(),
    turnId: nullableStringSchema,
    displayContent: nullableStringSchema,
    clientMessageId: nullableStringSchema,
    sessionId: nullableStringSchema,
    uiHidden: z.boolean().nullable().optional(),
    clientDraftId: nullableStringSchema,
    draftSession: draftSessionSchema.nullable().optional(),
    attachments: z.array(z.string()).optional(),
    requestedSkills: z
      .array(
        z
          .object({
            name: skillNameSchema,
            source: z.string().optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .passthrough()

const hookAuditOptionsSchema = z
  .object({
    cursor: z.union([z.string(), z.number()]).nullable().optional(),
    limit: numberLikeSchema,
    eventName: nullableStringSchema,
    outcome: nullableStringSchema,
    sourceId: nullableStringSchema,
    runId: nullableStringSchema,
  })
  .strict()

const runtimeReplayOptionsSchema = z
  .object({
    sessionId: nullableStringSchema,
    afterSeq: numberLikeSchema,
    after_seq: numberLikeSchema,
    limit: numberLikeSchema,
    includeArchive: booleanLikeSchema,
    include_archive: booleanLikeSchema,
    compact: booleanLikeSchema,
  })
  .strict()

const mcpServerSchema = z
  .object({
    transport: z.string().optional(),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    tool_overrides: z
      .record(
        z.string(),
        z
          .object({
            read_only: z.boolean().optional(),
            exclusive: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

const mcpConfigSchema = z
  .object({
    servers: z.record(z.string(), mcpServerSchema),
    defaults: z
      .object({
        read_only: z.boolean().optional(),
        exclusive: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const sessionPatchSchema = z.union([
  z.string(),
  z
    .object({
      title: nullableStringSchema,
      archived: z.boolean().nullable().optional(),
    })
    .strict(),
])

type AnyArgsSchema = z.ZodType<unknown[]>

export interface CoreOperationSpec<Schema extends AnyArgsSchema, Result> {
  readonly args: Schema
  readonly invoke: (api: CoreApi, args: z.output<Schema>) => Result
  readonly parseAndInvoke: (api: CoreApi, input: unknown) => Result
}

function operation<Schema extends AnyArgsSchema, Result>(
  args: Schema,
  invoke: (api: CoreApi, args: z.output<Schema>) => Result,
): CoreOperationSpec<Schema, Result> {
  return {
    args,
    invoke,
    parseAndInvoke: (api, input) => invoke(api, args.parse(input)),
  }
}

export const CORE_OPERATION_REGISTRY = {
  'attachments.rawPath': operation(z.tuple([idSchema]), (api, [id]) =>
    api.attachments.rawPath(id),
  ),
  'attachments.save': operation(
    z.tuple([
      z
        .object({
          raw: z.instanceof(Uint8Array),
          name: z.string(),
          mime: z.string(),
        })
        .strict(),
    ]),
    (api, [input]) => api.attachments.save(input),
  ),
  bootstrap: operation(
    z.tuple([
      z.object({ sessionId: nullableStringSchema }).strict().optional(),
    ]),
    (api, [options]) => api.bootstrap(options),
  ),
  'chat.stopRuntime': operation(
    z.tuple([
      z
        .object({
          taskId: nullableStringSchema,
          kind: z
            .enum(['turn', 'scheduler', 'team', 'watchlist'])
            .nullable()
            .optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.chat.stopRuntime(options),
  ),
  'chat.submit': operation(z.tuple([chatSubmitSchema]), (api, [input]) =>
    api.chat.submit(input),
  ),
  'config.get': operation(z.tuple([]), (api) => api.config.get()),
  'config.save': operation(
    z.tuple([
      z
        .union([
          z.string(),
          z.object({ content: z.unknown().optional() }).passthrough(),
        ])
        .optional(),
    ]),
    (api, [input]) => api.config.save(input),
  ),
  'control.answerInteraction': operation(
    z.tuple([idSchema, dictSchema, controlResumeSchema.optional()]),
    (api, [id, answers, options]) =>
      api.control.answerInteraction(id, answers, options),
  ),
  'control.approvePlan': operation(
    z.tuple([idSchema, controlResumeSchema.optional()]),
    (api, [id, options]) => api.control.approvePlan(id, options),
  ),
  'control.cancelInteraction': operation(z.tuple([idSchema]), (api, [id]) =>
    api.control.cancelInteraction(id),
  ),
  'control.commentPlan': operation(
    z.tuple([idSchema, z.string(), controlResumeSchema.optional()]),
    (api, [id, comment, options]) =>
      api.control.commentPlan(id, comment, options),
  ),
  'control.get': operation(z.tuple([]), (api) => api.control.get()),
  'control.setMode': operation(z.tuple([z.string()]), (api, [mode]) =>
    api.control.setMode(mode),
  ),
  'desktopPet.get': operation(z.tuple([]), (api) => api.desktopPet.get()),
  'desktopPet.setEnabled': operation(z.tuple([z.boolean()]), (api, [enabled]) =>
    api.desktopPet.setEnabled(enabled),
  ),
  'diagnostics.get': operation(z.tuple([]), (api) => api.diagnostics.get()),
  'external.get': operation(z.tuple([]), (api) => api.external.get()),
  'hooks.cancelRun': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.hooks.cancelRun(input),
  ),
  'hooks.getAudit': operation(
    z.tuple([hookAuditOptionsSchema.optional()]),
    (api, [options]) => api.hooks.getAudit(options),
  ),
  'hooks.getConfig': operation(
    z.tuple([dictSchema.optional()]),
    (api, [options]) => api.hooks.getConfig(options),
  ),
  'hooks.getMetadata': operation(z.tuple([]), (api) => api.hooks.getMetadata()),
  'hooks.saveConfig': operation(z.tuple([z.unknown()]), (api, [input]) =>
    api.hooks.saveConfig(input),
  ),
  'hooks.setProjectTrust': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.hooks.setProjectTrust(input),
  ),
  'hooks.testMatch': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.hooks.testMatch(input),
  ),
  'hooks.testRun': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.hooks.testRun(input),
  ),
  'hooks.validateConfig': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.hooks.validateConfig(input),
  ),
  'mcp.getConfig': operation(z.tuple([]), (api) => api.mcp.getConfig()),
  'mcp.saveConfig': operation(z.tuple([mcpConfigSchema]), (api, [input]) =>
    api.mcp.saveConfig({ ...input }),
  ),
  'memory.checkWatchlist': operation(z.tuple([]), (api) =>
    api.memory.checkWatchlist(),
  ),
  'memory.compact': operation(
    z.tuple([z.object({ force: z.boolean().optional() }).strict().optional()]),
    (api, [options]) => api.memory.compact(options),
  ),
  'memory.explainContext': operation(
    z.tuple([
      z
        .object({
          sessionId: nullableStringSchema,
          turnId: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.memory.explainContext(options),
  ),
  'memory.get': operation(z.tuple([]), (api) => api.memory.get()),
  'memory.getEpisode': operation(
    z.tuple([nullableStringSchema]),
    (api, [date]) => api.memory.getEpisode(date),
  ),
  'memory.getVersion': operation(z.tuple([idSchema]), (api, [id]) =>
    api.memory.getVersion(id),
  ),
  'memory.getWatchlist': operation(z.tuple([]), (api) =>
    api.memory.getWatchlist(),
  ),
  'memory.listVersions': operation(
    z.tuple([
      z
        .object({
          limit: z.number().int().nonnegative().optional(),
          target: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.memory.listVersions(options),
  ),
  'memory.restoreVersion': operation(z.tuple([idSchema]), (api, [id]) =>
    api.memory.restoreVersion(id),
  ),
  'memory.save': operation(z.tuple([z.string()]), (api, [content]) =>
    api.memory.save(content),
  ),
  'memory.saveEpisode': operation(
    z.tuple([z.string(), nullableStringSchema]),
    (api, [content, date]) => api.memory.saveEpisode(content, date),
  ),
  'memory.saveWatchlist': operation(z.tuple([z.string()]), (api, [content]) =>
    api.memory.saveWatchlist(content),
  ),
  'memory.tokens': operation(z.tuple([]), (api) => api.memory.tokens()),
  'model.discoverModels': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.model.discoverModels(input),
  ),
  'model.getConfig': operation(z.tuple([]), (api) => api.model.getConfig()),
  'model.saveConfig': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.model.saveConfig(input),
  ),
  'model.saveOnboardingConfig': operation(
    z.tuple([dictSchema]),
    (api, [input]) => api.model.saveOnboardingConfig(input),
  ),
  'model.test': operation(
    z.tuple([
      z
        .object({
          entryName: z.string(),
          kind: z.enum(['text', 'vision']).optional(),
          role: z.enum(['main', 'secondary']).optional(),
        })
        .passthrough(),
    ]),
    (api, [input]) => api.model.test(input),
  ),
  'plans.get': operation(z.tuple([idSchema]), (api, [id]) => api.plans.get(id)),
  'plans.list': operation(z.tuple([]), (api) => api.plans.list()),
  'projects.list': operation(z.tuple([]), (api) => api.projects.list()),
  'projects.resolve': operation(z.tuple([z.string()]), (api, [path]) =>
    api.projects.resolve(path),
  ),
  'runtime.replay': operation(
    z.tuple([runtimeReplayOptionsSchema.optional()]),
    (api, [options]) => api.runtime.replay(options),
  ),
  'scheduler.createJob': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.scheduler.createJob(input),
  ),
  'scheduler.deleteJob': operation(z.tuple([idSchema]), (api, [id]) =>
    api.scheduler.deleteJob(id),
  ),
  'scheduler.get': operation(z.tuple([]), (api) => api.scheduler.get()),
  'scheduler.pauseJob': operation(z.tuple([idSchema]), (api, [id]) =>
    api.scheduler.pauseJob(id),
  ),
  'scheduler.resumeJob': operation(z.tuple([idSchema]), (api, [id]) =>
    api.scheduler.resumeJob(id),
  ),
  'scheduler.runJob': operation(z.tuple([idSchema]), (api, [id]) =>
    api.scheduler.runJob(id),
  ),
  'scheduler.updateJob': operation(
    z.tuple([idSchema, dictSchema]),
    (api, [id, input]) => api.scheduler.updateJob(id, input),
  ),
  'sessions.activate': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.activate(id),
  ),
  'sessions.create': operation(
    z.tuple([
      z
        .object({
          title: z.string().optional(),
          mode: z.string().optional(),
          project: dictSchema.nullable().optional(),
          project_path: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.sessions.create(options),
  ),
  'sessions.delete': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.delete(id),
  ),
  'sessions.list': operation(
    z.tuple([
      z.object({ includeArchived: z.boolean().optional() }).strict().optional(),
    ]),
    (api, [options]) => api.sessions.list(options),
  ),
  'sessions.rename': operation(
    z.tuple([idSchema, sessionPatchSchema]),
    (api, [id, patch]) => api.sessions.rename(id, patch),
  ),
  'sidebar.get': operation(z.tuple([]), (api) => api.sidebar.get()),
  'sidebar.patch': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.sidebar.patch(input),
  ),
  'skills.delete': operation(z.tuple([idSchema]), (api, [name]) =>
    api.skills.delete(name),
  ),
  'skills.create': operation(z.tuple([skillCreateSchema]), (api, [input]) =>
    api.skills.create(input),
  ),
  'skills.get': operation(z.tuple([idSchema]), (api, [name]) =>
    api.skills.get(name),
  ),
  'skills.importArchive': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.skills.importArchive(input),
  ),
  'skills.list': operation(z.tuple([]), (api) => api.skills.list()),
  'skills.package': operation(z.tuple([skillPackageSchema]), (api, [input]) =>
    api.skills.package(input),
  ),
  'skills.save': operation(
    z.tuple([idSchema, z.string()]),
    (api, [name, content]) => api.skills.save(name, content),
  ),
  'skills.tools': operation(z.tuple([]), (api) => api.skills.tools()),
  'skills.validate': operation(z.tuple([skillValidateSchema]), (api, [input]) =>
    api.skills.validate(input),
  ),
  'tasks.get': operation(z.tuple([idSchema]), (api, [id]) => api.tasks.get(id)),
  'tasks.list': operation(
    z.tuple([
      z.object({ sessionId: nullableStringSchema }).strict().optional(),
    ]),
    (api, [options]) => api.tasks.list(options),
  ),
  'tasks.transcript': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [id, options]) => api.tasks.transcript(id, options),
  ),
  'team.get': operation(z.tuple([]), (api) => api.team.get()),
  'team.getMember': operation(z.tuple([idSchema]), (api, [name]) =>
    api.team.getMember(name),
  ),
  'team.sendMessage': operation(
    z.tuple([
      z
        .object({
          to: idSchema,
          content: z.string(),
          wake: z.boolean().optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.team.sendMessage(input),
  ),
  'team.shutdownMember': operation(z.tuple([idSchema]), (api, [name]) =>
    api.team.shutdownMember(name),
  ),
  'team.spawnMember': operation(
    z.tuple([
      z
        .object({
          name: idSchema,
          role: z.string(),
          task: nullableStringSchema,
          agent_type: nullableStringSchema,
        })
        .strict(),
    ]),
    (api, [input]) => api.team.spawnMember(input),
  ),
  'team.wakeMember': operation(
    z.tuple([
      idSchema,
      z.object({ purpose: z.string().optional() }).strict().optional(),
    ]),
    (api, [name, options]) => api.team.wakeMember(name, options),
  ),
  'tools.readResult': operation(
    z.tuple([z.object({ ref: idSchema }).strict()]),
    (api, [input]) => api.tools.readResult(input),
  ),
} as const

export type CoreOperationKey = keyof typeof CORE_OPERATION_REGISTRY

export type CoreOperationArgs<Key extends CoreOperationKey> = z.output<
  (typeof CORE_OPERATION_REGISTRY)[Key]['args']
>

export type CoreOperationResult<Key extends CoreOperationKey> = Awaited<
  ReturnType<(typeof CORE_OPERATION_REGISTRY)[Key]['invoke']>
>

export type CoreOperationMap = {
  [Key in CoreOperationKey]: {
    args: CoreOperationArgs<Key>
    result: CoreOperationResult<Key>
  }
}

const CORE_OPERATION_KEY_SET = new Set<string>(
  Object.keys(CORE_OPERATION_REGISTRY),
)

export function isCoreOperationKey(value: string): value is CoreOperationKey {
  return CORE_OPERATION_KEY_SET.has(value)
}

export function coreOperationKeys(): CoreOperationKey[] {
  return Object.keys(CORE_OPERATION_REGISTRY).sort() as CoreOperationKey[]
}

export class CoreOperationArgumentsError extends Error {
  readonly code = 'invalid_core_arguments'
  readonly operation: CoreOperationKey

  constructor(operation: CoreOperationKey, cause?: unknown) {
    super(`Invalid arguments for ${operation}`, { cause })
    this.name = 'CoreOperationArgumentsError'
    this.operation = operation
  }

  toSafe(): { message: string; code: string } {
    return { message: this.message, code: this.code }
  }
}

export async function invokeCoreOperation<Key extends CoreOperationKey>(
  api: CoreApi,
  key: Key,
  input: unknown,
): Promise<CoreOperationResult<Key>> {
  const spec = CORE_OPERATION_REGISTRY[key]
  try {
    return (await spec.parseAndInvoke(api, input)) as CoreOperationResult<Key>
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new CoreOperationArgumentsError(key, error)
    }
    throw error
  }
}

export interface CoreIpcSafeError {
  message: string
  code?: string
  action?: string
  errorId?: string
}

export interface CoreIpcErrorEnvelope {
  ok: false
  error: CoreIpcSafeError
}
