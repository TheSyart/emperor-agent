import { SITE_PERMISSION_KINDS } from '../harness/computer-use/site-permissions'
import {
  EXTERNAL_HISTORY_ACCESS,
  EXTERNAL_SITE_DECISIONS,
} from '../harness/computer-use/external-site-rules'
import { validDownloadDirectory } from '../config/local-config'
import { z } from 'zod'
import { executorConfigSchema } from '../harness/delegation/config'
import type { CoreApi } from './core-api'
import { SessionRequiredError, type ViewScope } from '../harness/host/scope'
import {
  MAX_MESSAGE_REFERENCES,
  referencesFit,
} from '../harness/host/message-references'
import { SKILL_NAME, SKILL_NAME_MAX_LENGTH } from '../skills/name'
import {
  environmentIdSchema,
  environmentToolIdSchema,
  sha256Schema,
} from '../environment/models'

const externalIdSchema = z.string().regex(/^dlg-[a-zA-Z0-9-]+$/)
const externalRunSchema = z.string().regex(/^dgr-[a-zA-Z0-9-]+$/)
const externalSession = z.string().trim().min(1).max(256).optional()
const externalRef = z
  .object({ id: externalIdSchema, sessionId: externalSession })
  .strict()
const externalRunRef = z
  .object({ runId: externalRunSchema, sessionId: externalSession })
  .strict()
const acceptanceCriteriaSchema = z
  .object({
    description: z.string().min(1).max(8192),
    commands: z
      .array(
        z
          .object({
            executable: z.string().min(1).max(4096),
            args: z.array(z.string().max(65536)).max(256),
            timeoutMs: z.number().int().min(1000).max(600000).optional(),
          })
          .strict(),
      )
      .max(16),
    requiresReview: z.boolean().optional(),
  })
  .strict()
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
/** Where a package can be installed. */
const pluginInstallScopeSchema = z.enum(['user', 'project', 'local'])
/** Where a package can live: also `managed`, the packages shipped with Emperor. */
const pluginScopeSchema = z.enum(['user', 'project', 'local', 'managed'])
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
    scope: pluginInstallScopeSchema,
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
/** Fields a user can lock against metadata refreshes (MOD-03). */
const modelMetadataFieldSchema = z.enum([
  'contextWindowTokens',
  'maxTokens',
  'pricing',
  'capabilities',
  'reasoningEffort',
  'displayName',
])
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
    // KRN-07: keep a DeepSeek entry on chat-completions; null clears it.
    transport: z.enum(['chat-completions']).nullable().optional(),
    credentialsFrom: idSchema.optional(),
    // MOD-05: the editor's temperature (null removes it) and the fields the
    // user changed, which metadata refreshes then leave alone.
    sampling: z
      .object({ temperature: z.number().min(0).max(2).nullable().optional() })
      .strict()
      .optional(),
    lockFields: z.array(modelMetadataFieldSchema).max(6).optional(),
  })
  .strict()
const modelEntryReplaceSchema = z
  .object({ entryId: idSchema, modelId: z.string().trim().min(1).max(200) })
  .strict()
const modelEntryIdSchema = z.object({ entryId: idSchema }).strict()
const modelReasoningEffortSchema = z
  .object({
    entryId: idSchema,
    reasoningEffort: z.string().trim().min(1).nullable(),
  })
  .strict()
// A draft connection from the add-model form (MOD-02, UI-29): the typed
// key wins; entryId / connectionId only lend a saved key to the same
// provider, protocol and API base.
const modelConnectionShape = {
  entryId: idSchema.optional(),
  connectionId: idSchema.optional(),
  provider: z.string().trim().min(1).optional(),
  protocol: modelProtocolSchema.optional(),
  apiBase: z.string().trim().optional(),
  apiKey: z.string().nullable().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  workspaceId: z.string().trim().max(63).optional(),
}
const modelDiscoverySchema = z
  .object({ ...modelConnectionShape, refresh: z.boolean().optional() })
  .strict()
const modelProbeSchema = z.object(modelConnectionShape).strict()
// MOD-03: the optional facts an entry carries (validated leniently again
// when the entry is normalized; unknown keys are refused here).
const modelEntryFactsShape = {
  limits: z
    .object({
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  detected: z
    .object({
      toolCall: z.boolean().optional(),
      vision: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      reasoningEfforts: z.array(z.string().trim().min(1)).optional(),
      defaultReasoningEffort: z.string().trim().min(1).optional(),
      reasoningControl: z
        .enum(['effort', 'toggle', 'budget', 'always'])
        .optional(),
      acceptsTemperature: z.boolean().optional(),
      modalities: z.array(z.string().trim().min(1)).optional(),
      kind: z
        .enum(['chat', 'embedding', 'rerank', 'image', 'audio', 'other'])
        .optional(),
    })
    .strict()
    .optional(),
  metadata: z
    .object({
      name: z.string().trim().optional(),
      source: z.enum([
        'vendor_api',
        'catalog',
        'family_rule',
        'fallback',
        'manual',
      ]),
      catalogKey: z.string().optional(),
      catalogVersion: z.string().optional(),
      checkedAt: z.string().optional(),
      userLocked: z.array(modelMetadataFieldSchema).optional(),
      pricingSource: z.enum(['catalog', 'vendor_api', 'manual']).optional(),
      lifecycle: z
        .object({
          status: z.enum(['active', 'deprecated', 'retired']).optional(),
          retiresAt: z.string().optional(),
          replacement: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  sampling: z
    .object({
      temperature: z.number().min(0).max(2).nullable().optional(),
      topP: z.number().min(0).max(1).nullable().optional(),
    })
    .strict()
    .optional(),
}
const modelEntriesSaveSchema = z
  .object({
    connection: z
      .object({
        provider: z.string().trim().min(1),
        protocol: modelProtocolSchema,
        apiBase: z.string().trim().min(1),
        apiKey: z.string().nullable().optional(),
      })
      .strict(),
    entries: z
      .array(
        z
          .object({
            entryId: idSchema.optional(),
            modelId: z.string().trim().min(1),
            displayName: z.string().trim().optional(),
            capabilityOverrides: modelCapabilityOverridesSchema.optional(),
            pricing: modelPricingSchema.nullable().optional(),
            contextWindowTokens: z.number().int().positive(),
            maxTokens: z.number().int().positive(),
            reasoningEffort: z.string().trim().nullable().optional(),
            ...modelEntryFactsShape,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    activateEntryId: idSchema.nullable().optional(),
  })
  .strict()
const modelConnectionUpdateSchema = z
  .object({
    connectionId: idSchema.optional(),
    entryId: idSchema.optional(),
    apiKey: z.string().nullable().optional(),
    apiBase: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.connectionId || value.entryId), {
    message: 'connectionId 或 entryId 必须提供一个',
  })
const modelMetadataRefreshSchema = z
  .object({
    entryIds: z.array(idSchema).min(1).max(200).optional(),
    connectionId: idSchema.optional(),
    apply: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.entryIds?.length || value.connectionId), {
    message: 'entryIds 或 connectionId 必须提供一个',
  })
const modelDefaultsSchema = z
  .object({
    provider: z.string().trim().min(1),
    protocol: modelProtocolSchema,
    apiBase: z.string().trim().optional(),
    modelId: z.string().trim().min(1),
  })
  .strict()
const modelRejectedKeySchema = z
  .object({ key: z.string().trim().min(1).max(200) })
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
    action: z.enum(['cancel', 'interject', 'send']),
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
/** Chips in a message's text (E-track contract §2). */
const messageReferencesSchema = z
  .array(
    z
      .object({
        kind: z.enum(['skill', 'plugin']),
        id: z.string().min(1).max(160),
        label: z.string().max(80),
        start: z.number().int().min(0),
        end: z.number().int().min(0),
      })
      .strict(),
  )
  .max(MAX_MESSAGE_REFERENCES)

const commandInvokeSchema = z
  .object({
    sessionId: idSchema,
    commandId: idSchema,
    rawInput: z.string().trim().min(1).max(16_384),
    invocationId: idSchema,
    invocationSource: commandInvocationSourceSchema,
    attachments: z.array(idSchema).max(64).optional(),
    references: messageReferencesSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.references === undefined ||
      referencesFit(value.rawInput, value.references),
    { message: 'references do not match the input', path: ['references'] },
  )

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
  .object({
    sessionId: idSchema,
    relativePath: workspaceRelativePathSchema,
    turn: z.number().int().nonnegative().optional(),
  })
  .strict()
const filePreviewSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('project'),
      sessionId: idSchema,
      path: workspaceRelativePathSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('turn'),
      sessionId: idSchema,
      path: workspaceRelativePathSchema,
      turn: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      source: z.literal('reference'),
      sessionId: idSchema,
      referenceId: idSchema,
    })
    .strict(),
  z
    .object({ source: z.literal('attachment'), attachmentId: idSchema })
    .strict(),
])
const fileStatSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('project'),
      sessionId: idSchema,
      path: workspaceRelativePathSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('reference'),
      sessionId: idSchema,
      referenceId: idSchema,
    })
    .strict(),
])
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
const pullRequestRepoSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
    'invalid repository',
  )
  .refine((value) => !/\/\.{1,2}$/.test(value), 'invalid repository')
const pullRequestRefSchema = z
  .object({
    repo: pullRequestRepoSchema,
    number: z.number().int().min(1).max(1_000_000_000),
  })
  .strict()
const pullRequestListSchema = z
  .object({
    filter: z.enum(['all', 'reviewing', 'mine']),
    query: z
      .string()
      .max(200)
      .refine(
        (value) =>
          ![...value].some((character) => {
            const code = character.charCodeAt(0)
            return code < 32 || code === 127
          }),
        'invalid search query',
      )
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
const githubQuerySchema = z
  .string()
  .max(200)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      }),
    'invalid search query',
  )
const githubIssueListSchema = z
  .object({
    filter: z
      .enum(['involved', 'owned', 'assigned', 'created', 'mentioned'])
      .optional(),
    query: githubQuerySchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
const githubRunListSchema = z
  .object({
    repo: pullRequestRepoSchema,
    branch: z
      .string()
      .regex(/^(?!-)[A-Za-z0-9._/-]{1,200}$/, 'invalid branch')
      .refine((value) => !value.includes('..'), 'invalid branch')
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
const githubRunRefSchema = z
  .object({
    repo: pullRequestRepoSchema,
    runId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
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
    delegationId: z
      .string()
      .regex(/^dlg-[a-zA-Z0-9-]+$/)
      .optional(),
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
    references: messageReferencesSchema.optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      value.references === undefined ||
      referencesFit(value.content, value.references),
    { message: 'references do not match the content', path: ['references'] },
  )

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

/**
 * What travels with a call besides its arguments (KRN-01): the session the
 * calling UI shows. The desktop passes it with every call; an operation
 * whose input names no session uses it, and one that needs a session gets
 * `SESSION_REQUIRED` when there is neither.
 */
export interface CoreOperationContext {
  readonly view?: ViewScope
}

export interface CoreOperationSpec<Schema extends AnyArgsSchema, Result> {
  readonly args: Schema
  readonly audience: 'main_renderer'
  readonly classification: 'application_operation'
  readonly invoke: (
    api: CoreApi,
    args: z.output<Schema>,
    context: CoreOperationContext,
  ) => Result
  readonly parseAndInvoke: (
    api: CoreApi,
    input: unknown,
    context: CoreOperationContext,
  ) => Result
}

function operation<Schema extends AnyArgsSchema, Result>(
  args: Schema,
  invoke: (
    api: CoreApi,
    args: z.output<Schema>,
    context: CoreOperationContext,
  ) => Result,
): CoreOperationSpec<Schema, Result> {
  return {
    args,
    audience: 'main_renderer',
    classification: 'application_operation',
    invoke,
    parseAndInvoke: (api, input, context) =>
      invoke(api, args.parse(input), context),
  }
}

/** The session an input names, else the one the caller shows (KRN-01). */
function sessionOf(
  sessionId: string | null | undefined,
  context: CoreOperationContext,
): string | null | undefined {
  return sessionId !== undefined ? sessionId : context.view?.sessionId
}

/** A named session, else the caller's (null: none in view); `SESSION_REQUIRED` with neither. */
function requiredSession(
  sessionId: string | null | undefined,
  context: CoreOperationContext,
  operation: string,
): string | null {
  const resolved = sessionOf(sessionId, context)
  if (resolved === undefined) throw new SessionRequiredError(operation)
  return resolved
}

/** The caller's view; `SESSION_REQUIRED` when the call carries none. */
function viewOf(context: CoreOperationContext, operation: string): ViewScope {
  if (context.view === undefined) throw new SessionRequiredError(operation)
  return context.view
}

/** An input with its session filled in from the caller's view when it names none. */
function withSession<T extends { sessionId?: string | null }>(
  input: T,
  context: CoreOperationContext,
  operation: string,
): T & { sessionId: string | null } {
  const sessionId = sessionOf(input.sessionId, context)
  if (sessionId === undefined) throw new SessionRequiredError(operation)
  return { ...input, sessionId }
}

export const CORE_OPERATION_REGISTRY = {
  'executors.list': operation(z.tuple([]), (api) => api.executors.list()),
  'executors.models': operation(
    z.tuple([
      z
        .object({
          profileId: z.string().min(1).max(64),
          refresh: z.boolean().optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.executors.models(input),
  ),
  'executors.probe': operation(
    z.tuple([z.object({ profileId: z.string().min(1).max(64) }).strict()]),
    (api, [input]) => api.executors.probe(input),
  ),
  'executors.configure': operation(
    z.tuple([
      z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          config: executorConfigSchema,
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.executors.configure(input, viewOf(ctx, 'executors.configure')),
  ),
  'delegations.get': operation(z.tuple([externalRef]), (api, [input], ctx) =>
    api.delegations.get(withSession(input, ctx, 'delegations.get')),
  ),
  'delegations.history': operation(
    z.tuple([
      externalRef
        .extend({
          before: z.string().max(1024).optional(),
          after: z.string().max(1024).optional(),
          limit: z.number().int().positive().optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.delegations.history(withSession(input, ctx, 'delegations.history')),
  ),
  'delegations.send': operation(
    z.tuple([
      externalRef
        .extend({
          messageId: z.string().regex(/^dgm-[a-zA-Z0-9-]+$/),
          text: z.string().min(1).max(32768),
          delivery: z.enum(['queue', 'steer']),
          expectedRunId: externalRunSchema.optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.delegations.send(withSession(input, ctx, 'delegations.send')),
  ),
  'delegations.interrupt': operation(
    z.tuple([externalRef.extend({ runId: externalRunSchema }).strict()]),
    (api, [input], ctx) =>
      api.delegations.interrupt(
        withSession(input, ctx, 'delegations.interrupt'),
      ),
  ),
  'delegations.recover': operation(
    z.tuple([
      externalRef
        .extend({
          expectedRevision: z.number().int().nonnegative(),
          inspect: z.boolean().optional(),
          verificationId: z
            .string()
            .regex(/^dgr-verification-[a-f0-9-]+$/)
            .optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.delegations.recover(withSession(input, ctx, 'delegations.recover')),
  ),
  'delegations.abandon': operation(
    z.tuple([externalRef]),
    (api, [input], ctx) =>
      api.delegations.abandon(withSession(input, ctx, 'delegations.abandon')),
  ),
  'delegations.collect': operation(
    z.tuple([externalRunRef]),
    (api, [input], ctx) =>
      api.delegations.collect(withSession(input, ctx, 'delegations.collect')),
  ),
  'delegations.receipt': operation(
    z.tuple([externalRunRef]),
    (api, [input], ctx) =>
      api.delegations.receipt(withSession(input, ctx, 'delegations.receipt')),
  ),
  'delegations.validate': operation(
    z.tuple([
      externalRunRef
        .extend({
          receiptId: z.string().regex(/^drr-[a-f0-9-]+$/),
          criteria: acceptanceCriteriaSchema,
          reviewedTreeDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.delegations.validate(withSession(input, ctx, 'delegations.validate')),
  ),
  'delegations.integrate': operation(
    z.tuple([
      externalRunRef
        .extend({
          action: z.enum(['preview', 'apply']),
          expectedBase: z
            .object({
              cwd: z.string().min(1).max(4096),
              head: z.string().nullable(),
              indexDigest: z.string().nullable(),
              treeDigest: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict()
            .optional(),
          previewId: z
            .string()
            .regex(/^dpi-[a-f0-9-]+$/)
            .optional(),
          expectedRevision: z.number().int().nonnegative().optional(),
          previewDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.delegations.integrate(
        withSession(input, ctx, 'delegations.integrate'),
      ),
  ),
  'delegations.close': operation(
    z.tuple([
      externalRef
        .extend({
          failureDisposition: z.string().trim().min(1).max(4096).optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.delegations.close(withSession(input, ctx, 'delegations.close')),
  ),

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
    (api, [input], ctx) => api.config.save(input, viewOf(ctx, 'config.save')),
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
    (api, [sessionId], ctx) =>
      api.control.get(requiredSession(sessionId, ctx, 'control.get')),
  ),
  'control.setPermissionMode': operation(
    z.tuple([
      z.enum(['read-only', 'workspace-write', 'danger-full-access']),
      nullableStringSchema,
    ]),
    (api, [preset, sessionId], ctx) =>
      api.control.setPermissionMode(
        preset,
        requiredSession(sessionId, ctx, 'control.setPermissionMode') ?? '',
      ),
  ),
  'control.setMode': operation(
    z.tuple([z.enum(['plan', 'default']), nullableStringSchema]),
    (api, [mode, sessionId], ctx) =>
      api.control.setMode(
        mode,
        requiredSession(sessionId, ctx, 'control.setMode') ?? '',
      ),
  ),
  'computerUse.status': operation(z.tuple([]), (api) =>
    api.computerUse.status(),
  ),
  'computerUse.listProfiles': operation(z.tuple([]), (api) =>
    api.computerUse.listProfiles(),
  ),
  'computerUse.manageProfile': operation(
    z.tuple([
      z
        .object({
          action: z.enum(['create', 'rename', 'clear', 'delete']),
          profileId: z
            .string()
            .regex(/^p_[0-9a-f]{12}$/)
            .optional(),
          name: z.string().min(1).max(60).optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.computerUse.manageProfile(
        input,
        viewOf(ctx, 'computerUse.manageProfile'),
      ),
  ),
  'computerUse.listSitePermissions': operation(z.tuple([]), (api) =>
    api.computerUse.listSitePermissions(),
  ),
  'computerUse.setSitePermission': operation(
    z.tuple([
      z
        .object({
          profileId: z.string().regex(/^(temporary|p_[0-9a-f]{12})$/),
          origin: z.string().min(1).max(512),
          kind: z.enum(SITE_PERMISSION_KINDS),
          allow: z.boolean(),
          minutes: z
            .number()
            .int()
            .min(1)
            .max(60 * 24 * 365)
            .optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.computerUse.setSitePermission(
        input,
        viewOf(ctx, 'computerUse.setSitePermission'),
      ),
  ),
  // Settings › 电脑操作 › Chrome 和 Edge (PLAN-CAP-001 RV-09).
  'computerUse.externalBrowserSettings': operation(z.tuple([]), (api) =>
    api.computerUse.externalBrowserSettings(),
  ),
  'computerUse.setExternalBrowserSettings': operation(
    z.tuple([
      z
        .object({
          defaults: z
            .object({
              browse: z.enum(EXTERNAL_SITE_DECISIONS).optional(),
              download: z.enum(EXTERNAL_SITE_DECISIONS).optional(),
            })
            .strict()
            .optional(),
          sites: z
            .array(
              z
                .object({
                  pattern: z.string().min(1).max(300),
                  browse: z.enum(EXTERNAL_SITE_DECISIONS),
                  download: z.enum(EXTERNAL_SITE_DECISIONS),
                })
                .strict(),
            )
            .max(1_000)
            .optional(),
          history: z.enum(EXTERNAL_HISTORY_ACCESS).optional(),
          siteTools: z.boolean().optional(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.computerUse.setExternalBrowserSettings(
        input,
        viewOf(ctx, 'computerUse.setExternalBrowserSettings'),
      ),
  ),
  'computerUse.setEnabled': operation(
    z.tuple([z.boolean()]),
    (api, [enabled], ctx) =>
      api.computerUse.setEnabled(
        enabled,
        viewOf(ctx, 'computerUse.setEnabled'),
      ),
  ),
  'computerUse.setDriverEnabled': operation(
    z.tuple([
      z
        .object({
          driver: z.enum(['embedded-browser', 'external-browser', 'desktop']),
          enabled: z.boolean(),
        })
        .strict(),
    ]),
    (api, [input], ctx) =>
      api.computerUse.setDriverEnabled(
        input,
        viewOf(ctx, 'computerUse.setDriverEnabled'),
      ),
  ),
  'computerUse.acknowledgeRetiredApps': operation(z.tuple([]), (api) =>
    api.computerUse.acknowledgeRetiredApps(),
  ),
  'computerUse.setDownloadRetention': operation(
    z.tuple([
      z
        .object({
          days: z.union([
            z.literal(0),
            z.literal(7),
            z.literal(30),
            z.literal(90),
          ]),
        })
        .strict(),
    ]),
    (api, [input]) => api.computerUse.setDownloadRetention(input),
  ),
  'computerUse.clearScreenshots': operation(
    z.tuple([
      z
        .object({ sessionId: z.string().min(1).max(256).optional() })
        .strict()
        .optional(),
    ]),
    (api, [input]) => api.computerUse.clearScreenshots(input ?? {}),
  ),
  'desktopPet.get': operation(z.tuple([]), (api) => api.desktopPet.get()),
  'browser.preferences': operation(z.tuple([]), (api) =>
    api.browser.preferences(),
  ),
  'browser.setPreferences': operation(
    z.tuple([
      z
        .object({
          linkTarget: z.enum(['system', 'builtin']).optional(),
          localTarget: z.enum(['builtin', 'system']).optional(),
          showFullUrl: z.boolean().optional(),
          history: z.boolean().optional(),
          // An absolute folder, or null for the system Downloads folder.
          downloadDirectory: z
            .string()
            .refine(
              (value) => validDownloadDirectory(value) !== null,
              'invalid download directory',
            )
            .nullable()
            .optional(),
          askWhereToSave: z.boolean().optional(),
        })
        .strict(),
    ]),
    (api, [change], ctx) =>
      api.browser.setPreferences(change, viewOf(ctx, 'browser.setPreferences')),
  ),
  'desktopPet.setEnabled': operation(
    z.tuple([z.boolean()]),
    (api, [enabled], ctx) =>
      api.desktopPet.setEnabled(enabled, viewOf(ctx, 'desktopPet.setEnabled')),
  ),
  'diagnostics.get': operation(z.tuple([]), (api, _args, ctx) =>
    api.diagnostics.get(viewOf(ctx, 'diagnostics.get')),
  ),
  'environment.cancelInstall': operation(
    z.tuple([environmentCancelSchema]),
    (api, [input], ctx) =>
      api.environment.cancelInstall(
        input,
        viewOf(ctx, 'environment.cancelInstall'),
      ),
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
    (api, [input], ctx) =>
      api.environment.getStatus(input, viewOf(ctx, 'environment.getStatus')),
  ),
  'environment.install': operation(
    z.tuple([environmentInstallSchema]),
    (api, [input]) => api.environment.install(input),
  ),
  // A goal belongs to a session: the one named, else the one in view.
  'goals.cancel': operation(
    z.tuple([
      idSchema,
      z.string().max(2_000).nullable().optional(),
      nullableStringSchema,
    ]),
    (api, [id, reason, sessionId], ctx) =>
      api.goals.cancel(
        id,
        reason ?? null,
        requiredSession(sessionId, ctx, 'goals.cancel') ?? '',
      ),
  ),
  'goals.get': operation(
    z.tuple([idSchema, nullableStringSchema]),
    (api, [id, sessionId], ctx) =>
      api.goals.get(id, requiredSession(sessionId, ctx, 'goals.get') ?? ''),
  ),
  'goals.list': operation(
    z.tuple([
      z.object({ sessionId: nullableStringSchema }).strict().optional(),
    ]),
    (api, [input], ctx) =>
      api.goals.list({
        sessionId: requiredSession(input?.sessionId, ctx, 'goals.list'),
      }),
  ),
  'goals.pause': operation(
    z.tuple([idSchema, nullableStringSchema]),
    (api, [id, sessionId], ctx) =>
      api.goals.pause(id, requiredSession(sessionId, ctx, 'goals.pause') ?? ''),
  ),
  'goals.resume': operation(
    z.tuple([idSchema, nullableStringSchema]),
    (api, [id, sessionId], ctx) =>
      api.goals.resume(
        id,
        requiredSession(sessionId, ctx, 'goals.resume') ?? '',
      ),
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
  'files.preview': operation(z.tuple([filePreviewSchema]), (api, [input]) =>
    api.files.preview(input),
  ),
  'files.search': operation(
    z.tuple([workspaceFileSearchSchema]),
    (api, [input]) => api.files.search(input),
  ),
  'files.stat': operation(z.tuple([fileStatSchema]), (api, [input]) =>
    api.files.stat(input),
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
  'git.remote': operation(z.tuple([gitStatusSchema]), (api, [input]) =>
    api.git.remote(input),
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
    (api, [options], ctx) =>
      api.hooks.getAudit(options ?? {}, viewOf(ctx, 'hooks.getAudit')),
  ),
  'hooks.getConfig': operation(
    z.tuple([dictSchema.optional()]),
    (api, [options]) => api.hooks.getConfig(options),
  ),
  'hooks.getMetadata': operation(z.tuple([]), (api) => api.hooks.getMetadata()),
  'hooks.saveConfig': operation(z.tuple([z.unknown()]), (api, [input], ctx) =>
    api.hooks.saveConfig(input, viewOf(ctx, 'hooks.saveConfig')),
  ),
  'hooks.setProjectTrust': operation(z.tuple([dictSchema]), (api, [input]) =>
    api.hooks.setProjectTrust(input),
  ),
  'hooks.testMatch': operation(z.tuple([dictSchema]), (api, [input], ctx) =>
    api.hooks.testMatch(input, viewOf(ctx, 'hooks.testMatch')),
  ),
  'hooks.testRun': operation(z.tuple([dictSchema]), (api, [input], ctx) =>
    api.hooks.testRun(input, viewOf(ctx, 'hooks.testRun')),
  ),
  'hooks.validateConfig': operation(
    z.tuple([dictSchema]),
    (api, [input], ctx) => api.hooks.validateConfig(input, ctx.view),
  ),
  'mcp.getConfig': operation(z.tuple([]), (api) => api.mcp.getConfig()),
  'mcp.status': operation(z.tuple([]), (api) => api.mcp.status()),
  'mcp.saveConfig': operation(z.tuple([mcpConfigSchema]), (api, [input], ctx) =>
    api.mcp.saveConfig({ ...input }, viewOf(ctx, 'mcp.saveConfig')),
  ),
  'mcp.importServers': operation(
    z.tuple([mcpImportSchema]),
    (api, [input], ctx) => api.mcp.importServers(input, ctx.view),
  ),
  'mcp.setServerEnabled': operation(
    z.tuple([mcpServerEnabledSchema]),
    (api, [input], ctx) =>
      api.mcp.setServerEnabled(input, viewOf(ctx, 'mcp.setServerEnabled')),
  ),
  'mcp.removeServer': operation(
    z.tuple([mcpServerRefSchema]),
    (api, [input], ctx) =>
      api.mcp.removeServer(input, viewOf(ctx, 'mcp.removeServer')),
  ),
  'memory.checkWatchlist': operation(z.tuple([]), (api) =>
    api.memory.checkWatchlist(),
  ),
  'memory.compact': operation(
    z.tuple([
      z
        .object({
          force: z.boolean().optional(),
          sessionId: nullableStringSchema,
        })
        .strict()
        .optional(),
    ]),
    (api, [options], ctx) =>
      api.memory.compact(withSession(options ?? {}, ctx, 'memory.compact')),
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
    (api, [options], ctx) =>
      api.memory.explainContext(
        withSession(options ?? {}, ctx, 'memory.explainContext'),
      ),
  ),
  'memory.get': operation(z.tuple([]), (api, _args, ctx) =>
    api.memory.get(viewOf(ctx, 'memory.get')),
  ),
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
  'memory.restoreVersion': operation(z.tuple([idSchema]), (api, [id], ctx) =>
    api.memory.restoreVersion(id, viewOf(ctx, 'memory.restoreVersion')),
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
  'memory.tokens': operation(z.tuple([]), (api, _args, ctx) =>
    api.memory.tokens(viewOf(ctx, 'memory.tokens')),
  ),
  'model.activate': operation(
    z.tuple([modelEntryIdSchema]),
    (api, [input], ctx) =>
      api.model.activate(input, viewOf(ctx, 'model.activate')),
  ),
  'model.deleteEntry': operation(
    z.tuple([modelEntryIdSchema]),
    (api, [input], ctx) =>
      api.model.deleteEntry(input, viewOf(ctx, 'model.deleteEntry')),
  ),
  'model.discoverModels': operation(
    z.tuple([modelDiscoverySchema]),
    (api, [input]) => api.model.discoverModels(input),
  ),
  'model.getConfig': operation(z.tuple([]), (api) => api.model.getConfig()),
  'model.probeConnection': operation(
    z.tuple([modelProbeSchema]),
    (api, [input]) => api.model.probeConnection(input),
  ),
  'model.resolveProfile': operation(
    z.tuple([modelProfilePreviewSchema]),
    (api, [input]) => api.model.resolveProfile(input),
  ),
  'model.saveEntry': operation(
    z.tuple([modelEntrySaveSchema]),
    (api, [input], ctx) =>
      api.model.saveEntry(input, viewOf(ctx, 'model.saveEntry')),
  ),
  'model.saveEntries': operation(
    z.tuple([modelEntriesSaveSchema]),
    (api, [input], ctx) =>
      api.model.saveEntries(input, viewOf(ctx, 'model.saveEntries')),
  ),
  'model.updateConnection': operation(
    z.tuple([modelConnectionUpdateSchema]),
    (api, [input], ctx) =>
      api.model.updateConnection(input, viewOf(ctx, 'model.updateConnection')),
  ),
  'model.refreshMetadata': operation(
    z.tuple([modelMetadataRefreshSchema]),
    (api, [input], ctx) =>
      api.model.refreshMetadata(input, viewOf(ctx, 'model.refreshMetadata')),
  ),
  'model.replaceEntry': operation(
    z.tuple([modelEntryReplaceSchema]),
    (api, [input], ctx) =>
      api.model.replaceEntry(input, viewOf(ctx, 'model.replaceEntry')),
  ),
  'model.lookupDefaults': operation(
    z.tuple([modelDefaultsSchema]),
    (api, [input]) => api.model.lookupDefaults(input),
  ),
  'model.discardRejected': operation(
    z.tuple([modelRejectedKeySchema]),
    (api, [input], ctx) =>
      api.model.discardRejected(input, viewOf(ctx, 'model.discardRejected')),
  ),
  'model.savePolicy': operation(
    z.tuple([modelExecutionPolicySchema]),
    (api, [input], ctx) =>
      api.model.savePolicy(input, viewOf(ctx, 'model.savePolicy')),
  ),
  'model.setReasoningEffort': operation(
    z.tuple([modelReasoningEffortSchema]),
    (api, [input], ctx) =>
      api.model.setReasoningEffort(
        input,
        viewOf(ctx, 'model.setReasoningEffort'),
      ),
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
  // Plugins as the project of the session in view sees them.
  'plugins.install': operation(
    z.tuple([pluginInstallSchema]),
    (api, [input], ctx) =>
      api.plugins.install(input, viewOf(ctx, 'plugins.install')),
  ),
  'plugins.getDetail': operation(
    z.tuple([pluginTargetSchema]),
    (api, [input], ctx) =>
      api.plugins.getDetail(input, viewOf(ctx, 'plugins.getDetail')),
  ),
  'plugins.list': operation(z.tuple([]), (api, _args, ctx) =>
    api.plugins.list(viewOf(ctx, 'plugins.list')),
  ),
  'plugins.setEnabled': operation(
    z.tuple([pluginTargetSchema.extend({ enabled: z.boolean() }).strict()]),
    (api, [input], ctx) =>
      api.plugins.setEnabled(input, viewOf(ctx, 'plugins.setEnabled')),
  ),
  'plugins.uninstall': operation(
    z.tuple([pluginTargetSchema]),
    (api, [input], ctx) =>
      api.plugins.uninstall(input, viewOf(ctx, 'plugins.uninstall')),
  ),
  'projects.list': operation(z.tuple([]), (api) => api.projects.list()),
  'projects.resolve': operation(z.tuple([z.string()]), (api, [path]) =>
    api.projects.resolve(path),
  ),
  'github.listIssues': operation(
    z.tuple([githubIssueListSchema]),
    (api, [input]) => api.github.listIssues(input),
  ),
  'github.viewIssue': operation(
    z.tuple([pullRequestRefSchema]),
    (api, [input]) => api.github.viewIssue(input),
  ),
  'github.listRuns': operation(z.tuple([githubRunListSchema]), (api, [input]) =>
    api.github.listRuns(input),
  ),
  'github.viewRun': operation(z.tuple([githubRunRefSchema]), (api, [input]) =>
    api.github.viewRun(input),
  ),
  'pullRequests.status': operation(z.tuple([]), (api) =>
    api.pullRequests.status(),
  ),
  'pullRequests.list': operation(
    z.tuple([pullRequestListSchema]),
    (api, [input]) => api.pullRequests.list(input),
  ),
  'pullRequests.view': operation(
    z.tuple([pullRequestRefSchema]),
    (api, [input]) => api.pullRequests.view(input),
  ),
  'pullRequests.diff': operation(
    z.tuple([pullRequestRefSchema]),
    (api, [input]) => api.pullRequests.diff(input),
  ),
  'runtime.replay': operation(
    z.tuple([runtimeReplayOptionsSchema.optional()]),
    (api, [options], ctx) =>
      api.runtime.replay(withSession(options ?? {}, ctx, 'runtime.replay')),
  ),
  'scheduler.createJob': operation(
    z.tuple([schedulerCreateSchema]),
    (api, [input], ctx) =>
      api.scheduler.createJob(input, viewOf(ctx, 'scheduler.createJob')),
  ),
  'scheduler.deleteJob': operation(z.tuple([idSchema]), (api, [id], ctx) =>
    api.scheduler.deleteJob(id, viewOf(ctx, 'scheduler.deleteJob')),
  ),
  'scheduler.get': operation(z.tuple([]), (api) => api.scheduler.get()),
  'scheduler.pauseJob': operation(z.tuple([idSchema]), (api, [id], ctx) =>
    api.scheduler.pauseJob(id, viewOf(ctx, 'scheduler.pauseJob')),
  ),
  'scheduler.resumeJob': operation(z.tuple([idSchema]), (api, [id], ctx) =>
    api.scheduler.resumeJob(id, viewOf(ctx, 'scheduler.resumeJob')),
  ),
  'scheduler.runJob': operation(z.tuple([idSchema]), (api, [id], ctx) =>
    api.scheduler.runJob(id, viewOf(ctx, 'scheduler.runJob')),
  ),
  'scheduler.updateJob': operation(
    z.tuple([idSchema, schedulerUpdateSchema]),
    (api, [id, input], ctx) =>
      api.scheduler.updateJob(id, input, viewOf(ctx, 'scheduler.updateJob')),
  ),
  'sessions.activate': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.activate(id),
  ),
  'agents.list': operation(
    z.tuple([
      z.object({ rootSessionIds: z.array(idSchema).max(500) }).strict(),
    ]),
    (api, [input]) => api.agents.list(input),
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
  'sessions.listDeleted': operation(z.tuple([]), (api) =>
    api.sessions.listDeleted(),
  ),
  'sessions.defaults': operation(z.tuple([]), (api) => api.sessions.defaults()),
  'sessions.setDefaults': operation(
    z.tuple([
      z
        .object({
          permission: z.enum([
            'read-only',
            'workspace-write',
            'danger-full-access',
          ]),
        })
        .strict(),
    ]),
    (api, [change], ctx) =>
      api.sessions.setDefaults(change, viewOf(ctx, 'sessions.setDefaults')),
  ),
  'sessions.restoreDeleted': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.restoreDeleted(id),
  ),
  'sessions.purgeDeleted': operation(z.tuple([idSchema]), (api, [id]) =>
    api.sessions.purgeDeleted(id),
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
  'sessions.search': operation(
    z.tuple([
      z
        .object({
          query: z.string().max(200),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.sessions.search(input),
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
    (api, [input], ctx) =>
      api.skills.copyToUser(
        withSession(input, ctx, 'skills.copyToUser'),
        viewOf(ctx, 'skills.copyToUser'),
      ),
  ),
  'skills.create': operation(
    z.tuple([skillCreateSchema]),
    (api, [input], ctx) =>
      api.skills.create(input, viewOf(ctx, 'skills.create')),
  ),
  // A Skill call that names no session is for the one in view (null: Chat).
  'skills.delete': operation(
    z.tuple([skillOpNameSchema, skillDeleteOptionsSchema.optional()]),
    (api, [name, options], ctx) =>
      api.skills.delete(
        name,
        withSession(options ?? {}, ctx, 'skills.delete'),
        viewOf(ctx, 'skills.delete'),
      ),
  ),
  'skills.get': operation(
    z.tuple([skillOpNameSchema, skillSessionOptionsSchema.optional()]),
    (api, [name, options], ctx) =>
      api.skills.get(name, withSession(options ?? {}, ctx, 'skills.get')),
  ),
  'skills.import': operation(
    z.tuple([skillImportSchema]),
    (api, [input], ctx) =>
      api.skills.import(
        withSession(input, ctx, 'skills.import'),
        viewOf(ctx, 'skills.import'),
      ),
  ),
  'skills.list': operation(
    z.tuple([skillSessionOptionsSchema.optional()]),
    (api, [options], ctx) =>
      api.skills.list(withSession(options ?? {}, ctx, 'skills.list')),
  ),
  'skills.save': operation(
    z.tuple([
      skillOpNameSchema,
      skillContentSchema,
      skillSessionOptionsSchema.optional(),
    ]),
    (api, [name, content, options], ctx) =>
      api.skills.save(
        name,
        content,
        withSession(options ?? {}, ctx, 'skills.save'),
        viewOf(ctx, 'skills.save'),
      ),
  ),
  'skills.tools': operation(z.tuple([]), (api, _args, ctx) =>
    api.skills.tools(viewOf(ctx, 'skills.tools')),
  ),
  'skills.validate': operation(
    z.tuple([skillValidateSchema]),
    (api, [input], ctx) =>
      api.skills.validate(withSession(input, ctx, 'skills.validate')),
  ),
  'tasks.get': operation(
    z.tuple([
      idSchema,
      z
        .object({ sessionId: sessionLogIdSchema.optional() })
        .strict()
        .optional(),
    ]),
    (api, [id, options], ctx) =>
      api.tasks.get(id, withSession(options ?? {}, ctx, 'tasks.get')),
  ),
  'storage.usage': operation(z.tuple([]), (api) => api.storage.usage()),
  'storage.clean': operation(z.tuple([]), (api, _args, ctx) =>
    api.storage.clean(viewOf(ctx, 'storage.clean')),
  ),
  'tasks.budget': operation(z.tuple([]), (api) => api.tasks.budget()),
  'tasks.setBudget': operation(
    z.tuple([
      z
        .object({
          maxSteps: z.number().int().optional(),
          maxBackgroundSteps: z.number().int().optional(),
          maxActiveAgents: z.number().int().optional(),
          maxTotalAgents: z.number().int().optional(),
          maxNoticeWakes: z.number().int().optional(),
        })
        .strict(),
    ]),
    (api, [change], ctx) =>
      api.tasks.setBudget(change, viewOf(ctx, 'tasks.setBudget')),
  ),
  'tasks.cancel': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({
          reason: z.string().trim().min(1).max(500).optional(),
          sessionId: sessionLogIdSchema.optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [id, options], ctx) =>
      api.tasks.cancel(id, withSession(options ?? {}, ctx, 'tasks.cancel')),
  ),
  'tasks.list': operation(
    z.tuple([
      z.object({ sessionId: nullableStringSchema }).strict().optional(),
    ]),
    (api, [options], ctx) =>
      api.tasks.list(withSession(options ?? {}, ctx, 'tasks.list')),
  ),
  'tasks.transcript': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({
          sessionId: sessionLogIdSchema.optional(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [id, options], ctx) =>
      api.tasks.transcript(
        id,
        withSession(options ?? {}, ctx, 'tasks.transcript'),
      ),
  ),
  'tasks.readOutput': operation(
    z.tuple([
      taskIdSchema,
      z
        .object({
          cursor: z.string().max(64).optional(),
          sessionId: sessionLogIdSchema.optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [id, options], ctx) =>
      api.tasks.readOutput(
        id,
        withSession(options ?? {}, ctx, 'tasks.readOutput'),
      ),
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
          sessionId: sessionLogIdSchema.optional(),
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
    (api, [id, options], ctx) =>
      api.tasks.wait(id, withSession(options ?? {}, ctx, 'tasks.wait')),
  ),
  // Processes of a named session: never a default (KRN-01).
  'processes.list': operation(
    z.tuple([
      z
        .object({
          sessionId: nullableStringSchema,
          activeOnly: z.boolean().optional(),
        })
        .strict()
        .optional(),
    ]),
    (api, [options]) => api.processes.list(options ?? {}),
  ),
  'processes.cancel': operation(
    z.tuple([
      idSchema,
      z
        .object({
          sessionId: nullableStringSchema,
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
          sessionId: nullableStringSchema,
          leaseId: idSchema,
          ownerKind: z.enum(['session', 'task', 'terminal']),
          ownerId: idSchema,
        })
        .strict(),
    ]),
    (api, [id, options]) => api.processes.reparent(id, options),
  ),
  'references.preview': operation(
    z.tuple([
      z.object({ sessionId: idSchema, referenceId: idSchema }).strict(),
    ]),
    (api, [input]) => api.references.preview(input),
  ),
  'references.siteIcon': operation(
    z.tuple([
      z.object({ sessionId: idSchema, referenceId: idSchema }).strict(),
    ]),
    (api, [input]) => api.references.siteIcon(input),
  ),
  'references.resolve': operation(
    z.tuple([referenceResolveSchema]),
    (api, [input]) => api.references.resolve(input),
  ),
  'references.image': operation(
    z.tuple([
      z
        .object({ sessionId: sessionLogIdSchema, referenceId: idSchema })
        .strict(),
    ]),
    (api, [input]) => api.references.image(input),
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
  'tools.networkSettings': operation(z.tuple([]), (api) =>
    api.tools.networkSettings(),
  ),
  'tools.readResult': operation(
    z.tuple([
      z
        .object({
          ref: idSchema,
          page: z.number().int().min(1).optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.tools.readResult(input),
  ),
  'tools.setNetworkSettings': operation(
    z.tuple([
      z
        .object({
          webFetch: z.boolean().optional(),
          webSearch: z.boolean().optional(),
        })
        .strict(),
    ]),
    (api, [change], ctx) =>
      api.tools.setNetworkSettings(
        change,
        viewOf(ctx, 'tools.setNetworkSettings'),
      ),
  ),
  'workspace.snapshot': operation(
    z.tuple([workspaceSessionSchema]),
    (api, [input]) => api.workspace.snapshot(input),
  ),
  'workspace.turnDiff': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          turn: z.number().int().positive(),
          path: workspaceRelativePathSchema,
        })
        .strict(),
    ]),
    (api, [input]) => api.workspace.turnDiff(input),
  ),
  'workspace.revertTurn': operation(
    z.tuple([
      z
        .object({
          sessionId: idSchema,
          turn: z.number().int().positive(),
          paths: z
            .array(workspaceRelativePathSchema)
            .min(1)
            .max(200)
            .optional(),
        })
        .strict(),
    ]),
    (api, [input]) => api.workspace.revertTurn(input),
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
  context: CoreOperationContext = {},
): Promise<CoreOperationResult<Key>> {
  const spec = CORE_OPERATION_REGISTRY[key]
  try {
    return (await spec.parseAndInvoke(
      api,
      input,
      context,
    )) as CoreOperationResult<Key>
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
