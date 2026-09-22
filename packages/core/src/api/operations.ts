import { z } from 'zod'
import type { CoreApi } from './core-api'
import { SKILL_NAME, SKILL_NAME_MAX_LENGTH } from '../skills/name'
import {
  environmentIdSchema,
  environmentToolIdSchema,
  sha256Schema,
} from '../environment/models'

const dictSchema = z.record(z.string(), z.unknown())
const idSchema = z.string().trim().min(1)
const taskIdSchema = idSchema.refine(
  (value) =>
    /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(value) && !value.includes('..'),
  'invalid task id',
)
const sessionLogIdSchema = idSchema
  .max(256)
  .refine(
    (value) =>
      /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(value) && !value.includes('..'),
    'invalid session id',
  )
const sessionHistorySchema = z
  .object({
    sessionId: sessionLogIdSchema,
    beforeSeq: z.number().int().nonnegative().optional(),
    maxMessages: z.number().int().min(1).max(500).optional(),
  })
  .strict()
const sessionRefSchema = z.object({ sessionId: sessionLogIdSchema }).strict()
const sessionEventSchema = z
  .object({
    sessionId: sessionLogIdSchema,
    seq: z.number().int().nonnegative(),
  })
  .strict()
const sessionWatchSchema = z
  .object({ sessionIds: z.array(sessionLogIdSchema).max(64) })
  .strict()
const skillNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+$/, 'invalid skill name')
const creatorSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(SKILL_NAME, 'invalid skill name')
/** Skill names of read/write ops; the service reports rule violations with reasons. */
const skillOpNameSchema = z.string().trim().min(1).max(128)
const skillScopeSchema = z.enum(['user', 'project'])
const skillSessionOptionsSchema = z
  .object({ sessionId: sessionLogIdSchema.nullable().optional() })
  .strict()
const skillContentSchema = z.string().max(1_048_576)
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
    name: skillOpNameSchema.optional(),
    content: skillContentSchema.optional(),
    sessionId: sessionLogIdSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.content !== undefined,
    'name or content is required',
  )
const skillDeleteOptionsSchema = z
  .object({
    sessionId: sessionLogIdSchema.nullable().optional(),
    scope: skillScopeSchema.nullable().optional(),
  })
  .strict()
const skillImportSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('content'),
      content: skillContentSchema.min(1),
      name: z.string().trim().max(128).nullable().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('folder'), path: z.string().min(1).max(4_096) })
    .strict(),
  z
    .object({ kind: z.literal('zip'), path: z.string().min(1).max(4_096) })
    .strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z.string().url().startsWith('https://').max(2_048),
    })
    .strict(),
])
const skillImportSchema = z
  .object({
    source: skillImportSourceSchema,
    scope: skillScopeSchema,
    sessionId: sessionLogIdSchema.nullable().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()
const skillCopyToUserSchema = z
  .object({
    name: skillOpNameSchema,
    sessionId: sessionLogIdSchema.nullable().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()
const environmentStatusSchema = z
  .object({ forceRefresh: z.boolean().optional() })
  .strict()
const environmentPlanSchema = z
  .object({ toolIds: z.array(environmentToolIdSchema).min(1).max(64) })
  .strict()
const environmentInstallSchema = z
  .object({
    planId: environmentIdSchema,
    acceptedLicenseIds: z.array(environmentIdSchema).max(64),
    confirmedStepIds: z.array(environmentIdSchema).max(128),
  })
  .strict()
const environmentCancelSchema = z
  .object({ jobId: environmentIdSchema })
  .strict()
const environmentLogSchema = z
  .object({
    jobId: environmentIdSchema,
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()
const pluginIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/,
    'invalid Plugin id',
  )
const pluginScopeSchema = z.enum(['user', 'project', 'local'])
const pluginInstallSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('local'), path: z.string().min(1).max(4_096) })
    .strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z.string().url().startsWith('https://').max(2_048),
    })
    .strict(),
])
const pluginInstallSchema = z
  .object({
    previewId: z.string().regex(/^plugin_preview_[a-f0-9]{24}$/),
    digest: sha256Schema,
    scope: pluginScopeSchema,
  })
  .strict()
const pluginTargetSchema = z
  .object({ pluginId: pluginIdSchema, scope: pluginScopeSchema })
  .strict()
const nullableStringSchema = z.string().nullable().optional()
const numberLikeSchema = z.union([z.number(), z.string()]).nullable().optional()
const booleanLikeSchema = z
  .union([z.boolean(), z.string()])
  .nullable()
  .optional()

const modelProtocolSchema = z.enum(['openai', 'anthropic'])
const modelCapabilityOverridesSchema = z
  .object({
    toolCall: z.boolean().optional(),
    vision: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict()
const modelPricingSchema = z
  .object({
    inputUsdPerMillionTokens: z.number().finite().nonnegative(),
    outputUsdPerMillionTokens: z.number().finite().nonnegative(),
    cacheReadUsdPerMillionTokens: z.number().finite().nonnegative(),
    cacheWriteUsdPerMillionTokens: z.number().finite().nonnegative(),
  })
  .strict()
const modelExecutionPolicySchema = z
  .object({
    fallback: z
      .object({
        enabled: z.boolean(),
        entryId: idSchema.nullable(),
        triggerOn: z
          .array(z.enum(['rate_limit', 'transient']))
          .min(1)
          .max(2),
      })
      .strict(),
    cost: z
      .object({
        maxUsdPerAgentTurn: z.number().finite().positive().nullable(),
      })
      .strict(),
  })
  .strict()
const modelEntrySaveSchema = z
  .object({
    entryId: idSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    protocol: modelProtocolSchema.optional(),
    modelId: z.string().trim().min(1).optional(),
    displayName: z.string().trim().optional(),
    apiBase: z.string().trim().min(1).optional(),
    apiKey: z.string().nullable().optional(),
    capabilityOverrides: modelCapabilityOverridesSchema.optional(),
    pricing: modelPricingSchema.nullable().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoningEffort: z.string().trim().nullable().optional(),
  })
  .strict()
const modelEntryIdSchema = z.object({ entryId: idSchema }).strict()
const modelReasoningEffortSchema = z
  .object({
    entryId: idSchema,
    reasoningEffort: z.string().trim().min(1).nullable(),
  })
  .strict()
const modelDiscoverySchema = z
  .object({
    entryId: idSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    protocol: modelProtocolSchema.optional(),
    apiBase: z.string().trim().optional(),
    apiKey: z.string().nullable().optional(),
    extraHeaders: z.record(z.string(), z.string()).optional(),
  })
  .strict()
const modelProfilePreviewSchema = z
  .object({
    provider: z.string().trim().min(1),
    protocol: modelProtocolSchema,
    modelId: z.string().trim().min(1),
    capabilityOverrides: modelCapabilityOverridesSchema.optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict()

const controlResumeSchema = z
  .object({
    clientMessageId: nullableStringSchema,
    turnId: nullableStringSchema,
    displayContent: nullableStringSchema,
    uiHidden: z.boolean().nullable().optional(),
    delivery: z.enum(['queue', 'interject']).nullable().optional(),
  })
  .strict()

const queuedPromptSessionSchema = z
  .object({ sessionId: z.string().trim().min(1) })
  .strict()

const manageQueuedPromptSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    promptId: z.string().trim().min(1),
    action: z.enum(['cancel', 'interject']),
  })
  .strict()

const commandInvocationSourceSchema = z.enum(['desktop', 'automation', 'acp'])
const commandListSchema = z
  .object({
    sessionId: idSchema,
    includeUnavailable: z.boolean().optional(),
    invocationSource: commandInvocationSourceSchema.optional(),
  })
  .strict()
const commandCompleteSchema = z
  .object({
    sessionId: idSchema,
    commandId: idSchema,
    rawArgs: z.string().max(8_192),
    cursor: z.number().int().min(0).max(8_192),
    invocationSource: commandInvocationSourceSchema,
  })
  .strict()
const commandInvokeSchema = z
  .object({
    sessionId: idSchema,
    commandId: idSchema,
    rawInput: z.string().trim().min(1).max(16_384),
    invocationId: idSchema,
    invocationSource: commandInvocationSourceSchema,
    attachments: z.array(idSchema).max(64).optional(),
  })
  .strict()

const workspaceSessionSchema = z.object({ sessionId: idSchema }).strict()
const workspaceRelativePathSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes('\0'), 'invalid workspace path')
const workspaceFilePageSchema = z
  .object({
    sessionId: idSchema,
    relativePath: workspaceRelativePathSchema,
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    showHidden: z.boolean().optional(),
    showIgnored: z.boolean().optional(),
  })
  .strict()
const workspaceFileSearchSchema = workspaceFilePageSchema
  .omit({ relativePath: true })
  .extend({ query: z.string().trim().min(1).max(500) })
  .strict()
const workspaceFileReadSchema = z
  .object({ sessionId: idSchema, relativePath: workspaceRelativePathSchema })
  .strict()
const gitStatusSchema = workspaceSessionSchema
const gitDiffSchema = z
  .object({
    sessionId: idSchema,
    path: workspaceRelativePathSchema.optional(),
    area: z.enum(['worktree', 'staged', 'compare']),
    baseRef: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
const gitCompareSchema = z
  .object({
    sessionId: idSchema,
    baseRef: z.string().trim().min(1).max(512),
    headRef: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
const gitPathsMutationSchema = z
  .object({
    sessionId: idSchema,
    paths: z.array(workspaceRelativePathSchema).min(1).max(500),
    expectedRevision: sha256Schema,
  })
  .strict()
const gitDiscardSchema = gitPathsMutationSchema.extend({
  confirmed: z.literal(true),
})
const gitCommitSchema = z
  .object({
    sessionId: idSchema,
    message: z.string().trim().min(1).max(10_000),
    expectedRevision: sha256Schema,
  })
  .strict()
const gitConfirmedSessionSchema = workspaceSessionSchema.extend({
  confirmed: z.literal(true),
})
const gitPullSchema = gitConfirmedSessionSchema.extend({
  expectedRevision: sha256Schema,
})
const gitPushSchema = gitConfirmedSessionSchema.extend({
  expectedRevision: sha256Schema,
  setUpstream: z.boolean().optional(),
})
const gitCreateBranchSchema = z
  .object({
    sessionId: idSchema,
    name: z.string().trim().min(1).max(512),
    expectedRevision: sha256Schema,
    startPoint: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
const gitSwitchBranchSchema = gitConfirmedSessionSchema.extend({
  name: z.string().trim().min(1).max(512),
  expectedRevision: sha256Schema,
})
const gitLogSchema = workspaceSessionSchema.extend({
  baseRef: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(200).optional(),
})
const gitEnterWorktreeSchema = gitConfirmedSessionSchema.extend({
  name: z.string().trim().min(1).max(128).optional(),
  startPoint: z.string().trim().min(1).max(512).optional(),
  expectedRevision: sha256Schema,
})
const gitExitWorktreeSchema = gitConfirmedSessionSchema.extend({
  action: z.enum(['keep', 'remove']),
  discardChanges: z.boolean(),
  expectedRevision: sha256Schema,
})
const gitPublishPreviewSchema = workspaceSessionSchema.extend({
  baseRef: z.string().trim().min(1).max(512).optional(),
})
const gitPublishPullRequestSchema = gitConfirmedSessionSchema.extend({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(64 * 1024),
  draft: z.boolean(),
  expectedRevision: sha256Schema,
})
const gitPullRequestMutationSchema = gitConfirmedSessionSchema.extend({
  number: z.number().int().positive(),
  expectedRevision: sha256Schema,
})
const gitMergePullRequestSchema = gitPullRequestMutationSchema.extend({
  method: z.enum(['merge', 'squash', 'rebase']),
  deleteBranch: z.boolean(),
})
const terminalIdentitySchema = z
  .object({ sessionId: idSchema, terminalId: idSchema })
  .strict()
const terminalCreateSchema = z
  .object({
    sessionId: idSchema,
    cols: z.number().int().min(2).max(1_000),
    rows: z.number().int().min(2).max(1_000),
  })
  .strict()
const terminalReadSchema = terminalIdentitySchema.extend({
  afterSeq: z.number().int().nonnegative(),
})
const terminalWriteSchema = terminalIdentitySchema.extend({
  data: z.string().max(64 * 1_024),
})
const terminalResizeSchema = terminalIdentitySchema.extend({
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(2).max(1_000),
})
const referenceResolveSchema = z
  .object({
    sessionId: idSchema,
    sourceMessageId: idSchema,
    href: z.string().trim().min(1).max(4_096),
    label: z.string().max(500),
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

const goalStartSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    sessionId: idSchema,
    maxRounds: z.number().int().positive().max(1_000).nullable().optional(),
    clientDraftId: nullableStringSchema,
    draftSession: draftSessionSchema.nullable().optional(),
  })
  .strict()

const schedulerMisfirePolicySchema = z.enum(['skip', 'latest', 'catch-up-one'])
const schedulerScheduleSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('at'), atMs: z.number().int().positive() })
    .strict(),
  z
    .object({ kind: z.literal('every'), everyMs: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal('cron'),
      expr: z.string().trim().min(1).max(512),
      tz: z.string().trim().min(1).max(128).nullable().optional(),
    })
    .strict(),
])
const schedulerAgentPayloadSchema = z
  .object({
    kind: z.literal('agent_turn'),
    message: z.string().trim().min(1).max(16_384),
    target: z.null().optional(),
    projectId: z.string().trim().min(1).max(256).nullable().optional(),
    deliver: z.boolean().optional(),
    meta: dictSchema.optional(),
  })
  .strict()
const schedulerTeamPayloadSchema = z
  .object({
    kind: z.literal('team_wake'),
    message: z.string().trim().min(1).max(16_384),
    target: z.string().trim().min(1).max(256),
    projectId: z.string().trim().min(1).max(256),
    deliver: z.boolean().optional(),
    meta: dictSchema.optional(),
  })
  .strict()
const schedulerPayloadSchema = z.discriminatedUnion('kind', [
  schedulerAgentPayloadSchema,
  schedulerTeamPayloadSchema,
])
const schedulerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    schedule: schedulerScheduleSchema,
    payload: schedulerPayloadSchema,
    deleteAfterRun: z.boolean().optional(),
    misfirePolicy: schedulerMisfirePolicySchema.optional(),
  })
  .strict()
const schedulerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    schedule: schedulerScheduleSchema.optional(),
    payload: schedulerPayloadSchema.optional(),
    deleteAfterRun: z.boolean().optional(),
    misfirePolicy: schedulerMisfirePolicySchema.optional(),
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
    format: z.literal('projection').optional(),
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

const mcpServerNameSchema = z.string().trim().min(1).max(128)
const mcpImportSchema = z
  .object({
    /** Pasted JSON text or an already-parsed object in any supported client format. */
    raw: z.union([z.string().max(256_000), dictSchema]),
    overwrite: z
      .union([z.boolean(), z.array(mcpServerNameSchema).max(256)])
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
const mcpServerEnabledSchema = z
  .object({ name: mcpServerNameSchema, enabled: z.boolean() })
  .strict()
const mcpServerRefSchema = z.object({ name: mcpServerNameSchema }).strict()

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
  readonly audience: 'main_renderer'
  readonly classification: 'application_operation'
  readonly invoke: (api: CoreApi, args: z.output<Schema>) => Result
  readonly parseAndInvoke: (api: CoreApi, input: unknown) => Result
}

function operation<Schema extends AnyArgsSchema, Result>(
  args: Schema,
  invoke: (api: CoreApi, args: z.output<Schema>) => Result,
): CoreOperationSpec<Schema, Result> {
  return {
    args,
    audience: 'main_renderer',
    classification: 'application_operation',
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
            .enum(['turn', 'scheduler', 'watchlist', 'goal', 'job', 'subagent'])
            .nullable()
            .optional(),
          sessionId: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.chat.stopRuntime(options),
  ),
  'chat.submit': operation(z.tuple([chatSubmitSchema]), (api, [input]) =>
    api.chat.submit(input),
  ),
  'chat.listQueuedPrompts': operation(
    z.tuple([queuedPromptSessionSchema]),
    (api, [input]) => api.chat.listQueuedPrompts(input),
  ),
  'chat.manageQueuedPrompt': operation(
    z.tuple([manageQueuedPromptSchema]),
    (api, [input]) => api.chat.manageQueuedPrompt(input),
  ),
  'commands.complete': operation(
    z.tuple([commandCompleteSchema]),
    (api, [input]) => api.commands.complete(input),
  ),
  'commands.invoke': operation(z.tuple([commandInvokeSchema]), (api, [input]) =>
    api.commands.invoke(input),
  ),
  'commands.list': operation(z.tuple([commandListSchema]), (api, [input]) =>
    api.commands.list(input),
  ),
  'config.effective': operation(z.tuple([]), (api) => api.config.effective()),
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
  'control.get': operation(
    z.tuple([nullableStringSchema]),
    (api, [sessionId]) => api.control.get(sessionId),
  ),
  'control.setPermissionMode': operation(
    z.tuple([
      z.enum(['read-only', 'workspace-write', 'danger-full-access']),
      nullableStringSchema,
    ]),
    (api, [preset, sessionId]) =>
      api.control.setPermissionMode(preset, sessionId),
  ),
  'control.setMode': operation(
    z.tuple([z.enum(['plan', 'default']), nullableStringSchema]),
    (api, [mode, sessionId]) => api.control.setMode(mode, sessionId),
  ),
  'desktopPet.get': operation(z.tuple([]), (api) => api.desktopPet.get()),
  'desktopPet.setEnabled': operation(z.tuple([z.boolean()]), (api, [enabled]) =>
    api.desktopPet.setEnabled(enabled),
  ),
  'diagnostics.get': operation(z.tuple([]), (api) => api.diagnostics.get()),
  'environment.cancelInstall': operation(
    z.tuple([environmentCancelSchema]),
    (api, [input]) => api.environment.cancelInstall(input),
  ),
  'environment.createInstallPlan': operation(
    z.tuple([environmentPlanSchema]),
    (api, [input]) => api.environment.createInstallPlan(input),
  ),
  'environment.getInstallLog': operation(
    z.tuple([environmentLogSchema]),
    (api, [input]) => api.environment.getInstallLog(input),
  ),
  'environment.getStatus': operation(
    z.tuple([environmentStatusSchema.optional()]),
    (api, [input]) => api.environment.getStatus(input),
  ),
  'environment.install': operation(
    z.tuple([environmentInstallSchema]),
    (api, [input]) => api.environment.install(input),
  ),
  'goals.cancel': operation(
    z.tuple([idSchema, z.string().max(2_000).nullable().optional()]),
    (api, [id, reason]) => api.goals.cancel(id, reason),
  ),
  'goals.get': operation(z.tuple([idSchema]), (api, [id]) => api.goals.get(id)),
  'goals.list': operation(
    z.tuple([
      z.object({ sessionId: nullableStringSchema }).strict().optional(),
    ]),
    (api, [input]) => api.goals.list(input),
  ),
  'goals.pause': operation(z.tuple([idSchema]), (api, [id]) =>
    api.goals.pause(id),
  ),
  'goals.resume': operation(z.tuple([idSchema]), (api, [id]) =>
    api.goals.resume(id),
  ),
  'goals.start': operation(z.tuple([goalStartSchema]), (api, [input]) =>
    api.goals.start(input),
  ),
  'files.list': operation(z.tuple([workspaceFilePageSchema]), (api, [input]) =>
    api.files.list(input),
  ),
  'files.read': operation(z.tuple([workspaceFileReadSchema]), (api, [input]) =>
    api.files.read(input),
  ),
  'files.search': operation(
    z.tuple([workspaceFileSearchSchema]),
    (api, [input]) => api.files.search(input),
  ),
  'git.branches': operation(z.tuple([gitStatusSchema]), (api, [input]) =>
    api.git.branches(input),
  ),
  'git.commit': operation(z.tuple([gitCommitSchema]), (api, [input]) =>
    api.git.commit(input),
  ),
  'git.compare': operation(z.tuple([gitCompareSchema]), (api, [input]) =>
    api.git.compare(input),
  ),
  'git.createBranch': operation(
    z.tuple([gitCreateBranchSchema]),
    (api, [input]) => api.git.createBranch(input),
  ),
  'git.diff': operation(z.tuple([gitDiffSchema]), (api, [input]) =>
    api.git.diff(input),
  ),
  'git.repository': operation(z.tuple([gitStatusSchema]), (api, [input]) =>
    api.git.repository(input),
  ),
  'git.log': operation(z.tuple([gitLogSchema]), (api, [input]) =>
    api.git.log(input),
  ),
  'git.worktrees': operation(z.tuple([gitStatusSchema]), (api, [input]) =>
    api.git.worktrees(input),
  ),
  'git.enterWorktree': operation(
    z.tuple([gitEnterWorktreeSchema]),
    (api, [input]) => api.git.enterWorktree(input),
  ),
  'git.exitWorktree': operation(
    z.tuple([gitExitWorktreeSchema]),
    (api, [input]) => api.git.exitWorktree(input),
  ),
  'git.pullRequest': operation(z.tuple([gitStatusSchema]), (api, [input]) =>
    api.git.pullRequest(input),
  ),
  'git.publishPreview': operation(
    z.tuple([gitPublishPreviewSchema]),
    (api, [input]) => api.git.publishPreview(input),
  ),
  'git.publishPullRequest': operation(
    z.tuple([gitPublishPullRequestSchema]),
    (api, [input]) => api.git.publishPullRequest(input),
  ),
  'git.readyPullRequest': operation(
    z.tuple([gitPullRequestMutationSchema]),
    (api, [input]) => api.git.readyPullRequest(input),
  ),
  'git.mergePullRequest': operation(
    z.tuple([gitMergePullRequestSchema]),
    (api, [input]) => api.git.mergePullRequest(input),
  ),
  'git.closePullRequest': operation(
    z.tuple([gitPullRequestMutationSchema]),
    (api, [input]) => api.git.closePullRequest(input),
  ),
  'git.discard': operation(z.tuple([gitDiscardSchema]), (api, [input]) =>
    api.git.discard(input),
  ),
  'git.fetch': operation(z.tuple([gitConfirmedSessionSchema]), (api, [input]) =>
    api.git.fetch(input),
  ),
  'git.pull': operation(z.tuple([gitPullSchema]), (api, [input]) =>
    api.git.pull(input),
  ),
  'git.push': operation(z.tuple([gitPushSchema]), (api, [input]) =>
    api.git.push(input),
  ),
  'git.stage': operation(z.tuple([gitPathsMutationSchema]), (api, [input]) =>
    api.git.stage(input),
  ),
  'git.status': operation(z.tuple([gitStatusSchema]), (api, [input]) =>
    api.git.status(input),
  ),
  'git.switchBranch': operation(
    z.tuple([gitSwitchBranchSchema]),
    (api, [input]) => api.git.switchBranch(input),
  ),
  'git.unstage': operation(z.tuple([gitPathsMutationSchema]), (api, [input]) =>
    api.git.unstage(input),
  ),
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
  'mcp.status': operation(z.tuple([]), (api) => api.mcp.status()),
  'mcp.saveConfig': operation(z.tuple([mcpConfigSchema]), (api, [input]) =>
    api.mcp.saveConfig({ ...input }),
  ),
  'mcp.importServers': operation(z.tuple([mcpImportSchema]), (api, [input]) =>
    api.mcp.importServers(input),
  ),
  'mcp.setServerEnabled': operation(
    z.tuple([mcpServerEnabledSchema]),
    (api, [input]) => api.mcp.setServerEnabled(input),
  ),
  'mcp.removeServer': operation(z.tuple([mcpServerRefSchema]), (api, [input]) =>
    api.mcp.removeServer(input),
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
  'model.activate': operation(z.tuple([modelEntryIdSchema]), (api, [input]) =>
    api.model.activate(input),
  ),
  'model.deleteEntry': operation(
    z.tuple([modelEntryIdSchema]),
    (api, [input]) => api.model.deleteEntry(input),
  ),
  'model.discoverModels': operation(
    z.tuple([modelDiscoverySchema]),
    (api, [input]) => api.model.discoverModels(input),
  ),
  'model.getConfig': operation(z.tuple([]), (api) => api.model.getConfig()),
  'model.resolveProfile': operation(
    z.tuple([modelProfilePreviewSchema]),
    (api, [input]) => api.model.resolveProfile(input),
  ),
  'model.saveEntry': operation(
    z.tuple([modelEntrySaveSchema]),
    (api, [input]) => api.model.saveEntry(input),
  ),
  'model.savePolicy': operation(
    z.tuple([modelExecutionPolicySchema]),
    (api, [input]) => api.model.savePolicy(input),
  ),
  'model.setReasoningEffort': operation(
    z.tuple([modelReasoningEffortSchema]),
    (api, [input]) => api.model.setReasoningEffort(input),
  ),
  'model.test': operation(
    z.tuple([
      z
        .object({
          entryId: idSchema,
          kind: z.enum(['text', 'vision']).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.model.test(input),
  ),
  'onboarding.getProfileStatus': operation(z.tuple([]), (api) =>
    api.onboarding.getProfileStatus(),
  ),
  'onboarding.startProfileInterview': operation(z.tuple([]), (api) =>
    api.onboarding.startProfileInterview(),
  ),
  'onboarding.skipProfileInterview': operation(z.tuple([]), (api) =>
    api.onboarding.skipProfileInterview(),
  ),
  'plugins.inspect': operation(
    z.tuple([pluginInstallSourceSchema]),
    (api, [input]) => api.plugins.inspect(input),
  ),
  'plugins.install': operation(z.tuple([pluginInstallSchema]), (api, [input]) =>
    api.plugins.install(input),
  ),
  'plugins.list': operation(z.tuple([]), (api) => api.plugins.list()),
  'plugins.setEnabled': operation(
    z.tuple([pluginTargetSchema.extend({ enabled: z.boolean() }).strict()]),
    (api, [input]) => api.plugins.setEnabled(input),
  ),
  'plugins.uninstall': operation(
    z.tuple([pluginTargetSchema]),
    (api, [input]) => api.plugins.uninstall(input),
  ),
  'projects.list': operation(z.tuple([]), (api) => api.projects.list()),
  'projects.resolve': operation(z.tuple([z.string()]), (api, [path]) =>
    api.projects.resolve(path),
  ),
  'runtime.replay': operation(
    z.tuple([runtimeReplayOptionsSchema.optional()]),
    (api, [options]) => api.runtime.replay(options),
  ),
  'scheduler.createJob': operation(
    z.tuple([schedulerCreateSchema]),
    (api, [input]) => api.scheduler.createJob(input),
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
    z.tuple([idSchema, schedulerUpdateSchema]),
    (api, [id, input]) => api.scheduler.updateJob(id, input),
  ),
  'sessions.activate': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.activate(id),
  ),
  'sessions.children': operation(z.tuple([sessionRefSchema]), (api, [input]) =>
    api.sessions.children(input),
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
  'sessions.event': operation(z.tuple([sessionEventSchema]), (api, [input]) =>
    api.sessions.event(input),
  ),
  'sessions.history': operation(
    z.tuple([sessionHistorySchema]),
    (api, [input]) => api.sessions.history(input),
  ),
  'sessions.lineage': operation(z.tuple([sessionRefSchema]), (api, [input]) =>
    api.sessions.lineage(input),
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
  'sessions.watch': operation(z.tuple([sessionWatchSchema]), (api, [input]) =>
    api.sessions.watch(input),
  ),
  'sidebar.get': operation(z.tuple([]), (api) => api.sidebar.get()),
  'sidebar.patch': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.sidebar.patch(input),
  ),
  'skills.copyToUser': operation(
    z.tuple([skillCopyToUserSchema]),
    (api, [input]) => api.skills.copyToUser(input),
  ),
  'skills.create': operation(z.tuple([skillCreateSchema]), (api, [input]) =>
    api.skills.create(input),
  ),
  'skills.delete': operation(
    z.tuple([skillOpNameSchema, skillDeleteOptionsSchema.optional()]),
    (api, [name, options]) => api.skills.delete(name, options ?? {}),
  ),
  'skills.get': operation(
    z.tuple([skillOpNameSchema, skillSessionOptionsSchema.optional()]),
    (api, [name, options]) => api.skills.get(name, options ?? {}),
  ),
  'skills.import': operation(z.tuple([skillImportSchema]), (api, [input]) =>
    api.skills.import(input),
  ),
  'skills.list': operation(
    z.tuple([skillSessionOptionsSchema.optional()]),
    (api, [options]) => api.skills.list(options ?? {}),
  ),
  'skills.save': operation(
    z.tuple([
      skillOpNameSchema,
      skillContentSchema,
      skillSessionOptionsSchema.optional(),
    ]),
    (api, [name, content, options]) =>
      api.skills.save(name, content, options ?? {}),
  ),
  'skills.tools': operation(z.tuple([]), (api) => api.skills.tools()),
  'skills.validate': operation(z.tuple([skillValidateSchema]), (api, [input]) =>
    api.skills.validate(input),
  ),
  'tasks.get': operation(z.tuple([idSchema]), (api, [id]) => api.tasks.get(id)),
  'tasks.cancel': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({ reason: z.string().trim().min(1).max(500).optional() })
        .strict()
        .optional(),
    ]),
    (api, [id, options]) => api.tasks.cancel(id, options),
  ),
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
  'tasks.readOutput': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({ cursor: z.string().max(64).optional() })
        .strict()
        .optional(),
    ]),
    (api, [id, options]) => api.tasks.readOutput(id, options),
  ),
  'tasks.resume': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({
          mode: z.enum(['foreground', 'background']).optional(),
          ttlMs: z
            .number()
            .int()
            .min(1)
            .max(30 * 60_000)
            .optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [id, options]) => api.tasks.resume(id, options),
  ),
  'tasks.wait': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({
          timeoutMs: z
            .number()
            .int()
            .min(0)
            .max(10 * 60_000)
            .optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [id, options]) => api.tasks.wait(id, options),
  ),
  'processes.list': operation(
    z.tuple([
      z.object({ activeOnly: z.boolean().optional() }).strict().optional(),
    ]),
    (api, [options]) => api.processes.list(options),
  ),
  'processes.cancel': operation(
    z.tuple([
      idSchema,
      z
        .object({
          leaseId: idSchema,
          reason: z.string().trim().min(1).max(500).optional(),
        })
        .strict(),
    ]),
    (api, [id, options]) => api.processes.cancel(id, options),
  ),
  'processes.reparent': operation(
    z.tuple([
      idSchema,
      z
        .object({
          leaseId: idSchema,
          ownerKind: z.enum(['session', 'task', 'terminal']),
          ownerId: idSchema,
        })
        .strict(),
    ]),
    (api, [id, options]) => api.processes.reparent(id, options),
  ),
  'references.resolve': operation(
    z.tuple([referenceResolveSchema]),
    (api, [input]) => api.references.resolve(input),
  ),
  'terminals.close': operation(
    z.tuple([terminalIdentitySchema]),
    (api, [input]) => api.terminals.close(input),
  ),
  'terminals.create': operation(
    z.tuple([terminalCreateSchema]),
    (api, [input]) => api.terminals.create(input),
  ),
  'terminals.list': operation(
    z.tuple([workspaceSessionSchema]),
    (api, [input]) => api.terminals.list(input),
  ),
  'terminals.read': operation(z.tuple([terminalReadSchema]), (api, [input]) =>
    api.terminals.read(input),
  ),
  'terminals.resize': operation(
    z.tuple([terminalResizeSchema]),
    (api, [input]) => api.terminals.resize(input),
  ),
  'terminals.write': operation(z.tuple([terminalWriteSchema]), (api, [input]) =>
    api.terminals.write(input),
  ),
  'tools.readResult': operation(
    z.tuple([z.object({ ref: idSchema }).strict()]),
    (api, [input]) => api.tools.readResult(input),
  ),
  'workspace.snapshot': operation(
    z.tuple([workspaceSessionSchema]),
    (api, [input]) => api.workspace.snapshot(input),
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

export interface CoreOperationDescriptor<Key extends CoreOperationKey> {
  readonly key: Key
  readonly handlerKey: Key
  readonly audience: 'main_renderer'
  readonly classification: 'application_operation'
  readonly inputSchema: (typeof CORE_OPERATION_REGISTRY)[Key]['args']
}

/**
 * Canonical IPC descriptors. Electron and renderer consumers derive their
 * allowlists from these registry-owned keys instead of a retired HTTP route
 * table.
 */
export function coreOperationDescriptors(): Array<
  CoreOperationDescriptor<CoreOperationKey>
> {
  return coreOperationKeys().map((key) => {
    const spec = CORE_OPERATION_REGISTRY[key]
    return Object.freeze({
      key,
      handlerKey: key,
      audience: spec.audience,
      classification: spec.classification,
      inputSchema: spec.args,
    }) as CoreOperationDescriptor<CoreOperationKey>
  })
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
