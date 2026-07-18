import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  HOOK_EVENT_NAMES,
  HOOK_EVENT_SPECS,
  HookService,
  buildHookInput,
  compileHookPlan,
  defaultHooksConfigV2,
  isHookEventName,
  parseHooksConfigV2,
  serializeHooksConfigV2,
  type HookEventName,
  type HookRuntimeRunOptions,
  type HookSnapshot,
  type HookAggregateDecision,
  type HookDiagnostic,
  type HookEventMode,
  type HookHandlerType,
  type HookSourceV2,
  type HooksConfigV2,
  type ProjectHookTrustStatus,
  type ResolvedHookGroup,
} from '../../hooks'
import type { HookAuditRunRecordV2 } from '../../hooks/orchestrator'

type Dict = Record<string, unknown>

export interface CoreHooksServiceDeps {
  service?: HookService | null
  activeSessionId?: () => string | null
  activeWorkspaceRoot?: () => string
  activeProjectRoot?: () => string | null
  assertMutation?: (area: string, action: string) => void
}

export interface CoreHooksSummaryPayload {
  total: number
  groups: number
  events: Array<{ eventName: HookEventName; groups: number; count: number }>
}

export interface CoreHooksConfigPayload {
  revision: string
  config: HooksConfigV2
  globalConfig: HooksConfigV2
  effectiveGroups: ResolvedHookGroup[]
  sources: HookSourceV2[]
  projectTrust: ProjectHookTrustStatus | null
  diagnostics: HookDiagnostic[]
  summary: CoreHooksSummaryPayload
}

export interface CoreHooksSavePayload extends CoreHooksConfigPayload {
  saved: boolean
  decision: HookAggregateDecision
}

export interface CoreHooksAuditPayload {
  records: HookAuditRunRecordV2[]
  badLines: Array<{ path: string; line: number; raw: string }>
  cursor: string
  nextCursor: string | null
  total: number
}

export interface CoreHookEventMetadataPayload {
  eventName: HookEventName
  matcherField: string | null
  mode: HookEventMode
  allowedHandlers: HookHandlerType[]
}

export interface CoreHooksMetadataPayload {
  version: 2
  events: CoreHookEventMetadataPayload[]
  handlers: Record<string, Record<string, unknown>>
  limits: Record<string, unknown>
}

export interface CoreHooksValidationPayload {
  valid: boolean
  config: Record<string, unknown>
  diagnostics: HookDiagnostic[]
}

export interface CoreHookMatchItemPayload {
  index: number
  eventName: HookEventName
  groupId: string
  handlerId: string
  handlerType: HookHandlerType
  source: HookSourceV2
  failureMode: string
}

export interface CoreHooksMatchPayload {
  revision: string
  eventName: HookEventName
  items: CoreHookMatchItemPayload[]
  diagnostics: HookDiagnostic[]
}

export class CoreHooksService {
  readonly stateRoot: string
  readonly service: HookService
  readonly audit: HookService['audit']
  private readonly deps: CoreHooksServiceDeps

  constructor(stateRoot: string, deps: CoreHooksServiceDeps = {}) {
    this.stateRoot = stateRoot
    this.service = deps.service ?? new HookService({ stateRoot })
    this.audit = this.service.audit
    this.deps = deps
  }

  async getConfig(_opts: Dict = {}): Promise<CoreHooksConfigPayload> {
    const scope = this.scope()
    const snapshot = await this.service.snapshot(scope)
    const global = await this.service.resolver.resolve({
      projectRoot: null,
      sessionId: null,
    })
    return configPayload(snapshot, global.config)
  }

  async saveConfig(raw: unknown): Promise<CoreHooksSavePayload> {
    this.deps.assertMutation?.('hooks', 'saveConfig')
    const envelope = isRecord(raw) && 'config' in raw ? raw : null
    const config = envelope?.config ?? raw
    const expectedRevision =
      envelope && typeof envelope.revision === 'string'
        ? envelope.revision
        : null
    const scope = this.scope()
    const result = await this.service.saveGlobalConfig(config, {
      expectedRevision,
      sessionId: scope.sessionId,
      cwd: this.deps.activeWorkspaceRoot?.() ?? process.cwd(),
      projectRoot: scope.projectRoot,
    })
    return {
      ...configPayload(result.snapshot, result.config),
      saved: result.saved,
      decision: result.decision,
    }
  }

  async notifyConfigChange(
    source: string,
    candidate: unknown = source,
  ): Promise<void> {
    await this.authorizeConfigChange(source, candidate)
  }

  async authorizeConfigChange(
    source: string,
    candidate: unknown,
  ): Promise<{ revision: string; decision: HookAggregateDecision }> {
    const scope = this.scope()
    const revision = stableRevision(candidate)
    const decision = await this.service.authorizeConfigChange({
      source,
      candidateRevision: revision,
      sessionId: scope.sessionId,
      cwd: this.deps.activeWorkspaceRoot?.() ?? process.cwd(),
      projectRoot: scope.projectRoot,
    })
    if (decision.decision === 'deny' || decision.decision === 'ask') {
      throw new Error(`ConfigChange hook denied ${source}: ${decision.reason}`)
    }
    return { revision, decision }
  }

  async getAudit(
    opts: {
      cursor?: string | number | null
      limit?: number | string | null
      eventName?: string | null
      outcome?: string | null
      sourceId?: string | null
      runId?: string | null
    } = {},
  ): Promise<CoreHooksAuditPayload> {
    const replay = await this.audit.replayRuns({ limit: 100_000 })
    const filtered = replay.records
      .filter((record) => {
        if (opts.eventName && record.eventName !== opts.eventName) return false
        if (opts.outcome && record.outcome !== opts.outcome) return false
        if (opts.sourceId && record.source.id !== opts.sourceId) return false
        if (opts.runId && record.hookRunId !== opts.runId) return false
        return true
      })
      .reverse()
    const offset = normalizeCursor(opts.cursor)
    const limit = normalizeLimit(opts.limit, 100)
    const records = filtered.slice(offset, offset + limit)
    const nextOffset = offset + records.length
    return {
      records,
      badLines: replay.badLines,
      cursor: String(offset),
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      total: filtered.length,
    }
  }

  getMetadata(): CoreHooksMetadataPayload {
    const defaults = defaultHooksConfigV2()
    return {
      version: 2,
      events: HOOK_EVENT_NAMES.map((eventName) => ({
        eventName,
        matcherField: HOOK_EVENT_SPECS[eventName].matcherField,
        mode: HOOK_EVENT_SPECS[eventName].mode,
        allowedHandlers: [...HOOK_EVENT_SPECS[eventName].allowedHandlers],
      })),
      handlers: {
        command: {
          shell: ['none', 'bash', 'powershell'],
          async: true,
          defaults: { timeoutMs: defaults.policy.command.defaultTimeoutMs },
        },
        http: {
          defaults: { timeoutMs: defaults.policy.http.defaultTimeoutMs },
          requiresUrlAllowlist: true,
        },
        prompt: {
          modelRole: ['secondary', 'main'],
          defaults: { timeoutMs: defaults.policy.prompt.defaultTimeoutMs },
        },
        agent: {
          modelRole: ['secondary', 'main'],
          defaults: {
            timeoutMs: defaults.policy.agent.defaultTimeoutMs,
            maxTurns: defaults.policy.agent.maxTurns,
          },
        },
      },
      limits: { ...defaults.policy },
    }
  }

  validateConfig(input: Dict): CoreHooksValidationPayload {
    const sourceKind = String(input.sourceKind ?? input.source_kind ?? 'global')
    const parsed = parseHooksConfigV2(input.config, { sourceKind })
    return {
      valid: parsed.diagnostics.length === 0,
      config: serializeHooksConfigV2(parsed.config),
      diagnostics: parsed.diagnostics,
    }
  }

  async setProjectTrust(input: Dict): Promise<ProjectHookTrustStatus> {
    this.deps.assertMutation?.('hooks', 'setProjectTrust')
    const activeRoot = this.deps.activeProjectRoot?.() ?? null
    const requestedRoot = String(
      input.projectRoot ?? input.project_root ?? '',
    ).trim()
    if (!activeRoot || !requestedRoot)
      throw new Error('active project root is required')
    const [activeCanonical, requestedCanonical] = await Promise.all([
      canonical(activeRoot),
      canonical(requestedRoot),
    ])
    if (activeCanonical !== requestedCanonical)
      throw new Error(
        'project trust may only be changed for the active project',
      )
    const expectedDigest = String(
      input.expectedDigest ?? input.expected_digest ?? '',
    )
    if (!expectedDigest) throw new Error('expectedDigest is required')
    return await this.service.resolver.trustStore.set({
      projectRoot: requestedCanonical,
      expectedDigest,
      trusted: Boolean(input.trusted),
    })
  }

  async testMatch(input: Dict): Promise<CoreHooksMatchPayload> {
    const eventName = requiredEvent(input)
    const snapshot = await this.currentRevision(input.revision)
    const runOptions = this.runOptions(input)
    const hookInput = buildHookInput(eventName, {
      ...runOptions,
      stateRoot: this.stateRoot,
    })
    const plan = compileHookPlan(snapshot, hookInput)
    return {
      revision: snapshot.revision,
      eventName,
      items: plan.items.map(planItemPayload),
      diagnostics: plan.diagnostics,
    }
  }

  async testRun(input: Dict): Promise<Dict> {
    this.deps.assertMutation?.('hooks', 'testRun')
    if (input.confirmExecution !== true && input.confirm_execution !== true)
      throw new Error('confirmExecution=true is required')
    const eventName = requiredEvent(input)
    const snapshot = await this.currentRevision(input.revision)
    const groupId = String(input.groupId ?? input.group_id ?? '')
    const handlerId = String(input.handlerId ?? input.handler_id ?? '')
    if (!groupId || !handlerId)
      throw new Error('groupId and handlerId are required')
    const runOptions = this.runOptions(input)
    const hookInput = buildHookInput(eventName, {
      ...runOptions,
      stateRoot: this.stateRoot,
    })
    const plan = compileHookPlan(snapshot, hookInput)
    const selected = plan.items.find(
      (item) => item.groupId === groupId && item.handlerId === handlerId,
    )
    if (!selected)
      throw new Error('selected hook handler does not match the event input')
    if (
      (selected.source.kind === 'project' ||
        selected.source.kind === 'project-local') &&
      snapshot.projectTrust?.status !== 'trusted'
    ) {
      throw new Error('untrusted project hooks cannot be executed')
    }
    const selectedSnapshot: HookSnapshot = {
      ...snapshot,
      groups: [
        {
          eventName: selected.eventName,
          source: selected.source,
          group: { ...selected.group, handlers: [selected.handler] },
        },
      ],
    }
    return (await this.service.run(eventName, runOptions, {
      snapshot: selectedSnapshot,
    })) as unknown as Dict
  }

  async cancelRun(input: Dict): Promise<{ runId: string; cancelled: boolean }> {
    const runId = String(input.runId ?? input.run_id ?? '')
    if (!runId) throw new Error('runId is required')
    return { runId, cancelled: await this.service.background.cancel(runId) }
  }

  private scope(): { sessionId: string; projectRoot: string | null } {
    return {
      sessionId: this.deps.activeSessionId?.() ?? '',
      projectRoot: this.deps.activeProjectRoot?.() ?? null,
    }
  }

  private async currentRevision(expected: unknown): Promise<HookSnapshot> {
    const snapshot = await this.service.snapshot(this.scope())
    const revision = String(expected ?? '')
    if (!revision) throw new Error('revision is required')
    if (revision !== snapshot.revision)
      throw new Error(
        `stale hooks revision: expected ${revision}, current ${snapshot.revision}`,
      )
    return snapshot
  }

  private runOptions(input: Dict): HookRuntimeRunOptions {
    const raw = isRecord(input.input) ? input.input : input
    return {
      ...raw,
      sessionId: String(
        raw.sessionId ?? raw.session_id ?? this.deps.activeSessionId?.() ?? '',
      ),
      cwd: String(
        raw.cwd ?? this.deps.activeWorkspaceRoot?.() ?? process.cwd(),
      ),
      projectRoot: this.deps.activeProjectRoot?.() ?? null,
      stateRoot: this.stateRoot,
      source: typeof raw.source === 'string' ? raw.source : 'test',
      toolName:
        typeof raw.toolName === 'string'
          ? raw.toolName
          : typeof raw.tool_name === 'string'
            ? raw.tool_name
            : null,
      toolInput: isRecord(raw.toolInput)
        ? raw.toolInput
        : isRecord(raw.tool_input)
          ? raw.tool_input
          : null,
      prompt: typeof raw.prompt === 'string' ? raw.prompt : null,
    }
  }
}

function configPayload(
  snapshot: HookSnapshot,
  globalConfig: HooksConfigV2,
): CoreHooksConfigPayload {
  const effectiveGroups = snapshot.groups.map((resolved) => ({
    eventName: resolved.eventName,
    group: resolved.group,
    source: resolved.source,
  }))
  return {
    revision: snapshot.revision,
    config: snapshot.config,
    globalConfig,
    effectiveGroups,
    sources: snapshot.sources,
    projectTrust: snapshot.projectTrust,
    diagnostics: snapshot.diagnostics,
    summary: hooksSummary(snapshot),
  }
}

function hooksSummary(snapshot: HookSnapshot): CoreHooksSummaryPayload {
  const events = HOOK_EVENT_NAMES.map((eventName) => {
    const groups = snapshot.groups.filter(
      (group) => group.eventName === eventName,
    )
    return {
      eventName,
      groups: groups.length,
      count: groups.reduce(
        (sum, group) => sum + group.group.handlers.length,
        0,
      ),
    }
  }).filter((event) => event.groups > 0)
  return {
    total: events.reduce((sum, event) => sum + event.count, 0),
    groups: snapshot.groups.length,
    events,
  }
}

function requiredEvent(input: Dict): HookEventName {
  const eventName = String(input.eventName ?? input.event_name ?? '')
  if (!isHookEventName(eventName))
    throw new Error(`invalid hook event: ${eventName}`)
  return eventName
}

function planItemPayload(
  item: ReturnType<typeof compileHookPlan>['items'][number],
): CoreHookMatchItemPayload {
  return {
    index: item.index,
    eventName: item.eventName,
    groupId: item.groupId,
    handlerId: item.handlerId,
    handlerType: item.handler.type,
    source: item.source,
    failureMode: item.group.failureMode,
  }
}

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10)
  return Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : fallback
}

function normalizeCursor(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(resolve(path))
  } catch {
    return resolve(path)
  }
}

function stableRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isRecord(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
