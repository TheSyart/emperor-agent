import { createHash } from 'node:crypto'
import {
  referencesFit,
  type MessageReference,
} from '../harness/host/message-references'
import type { DraftSessionInput } from '../api/chat-service'
import type { SkillInfoPayload } from '../api/services/skill-service'
import { isDraftSessionId } from '../sessions/constants'
import { builtinCommandDescriptors } from './builtins'
import {
  CommandInvocationStore,
  CommandInvocationStoreCorruptError,
} from './invocation-store'
import {
  CommandParseError,
  parseCommandInput,
  type ParsedCommandInput,
} from './parser'
import { CommandRegistry } from './registry'
import { resolveSkillCommandCatalog } from './skill-adapter'
import type {
  CommandCompletion,
  CommandDescriptor,
  CommandInvocationResult,
  CommandInvocationSource,
} from './types'
import {
  CommandValidationError,
  validateCommandArguments,
  type ValidatedCommandArguments,
} from './validation'

export interface CommandSessionContext {
  exists: boolean
}

/**
 * A start-page draft (`draft:<uuid>`): Core has no session for it yet, only
 * the mode and project its session will get — the `draftSession` that
 * `chat.submit` and `goals.start` carry (FIX-14).
 */
export type CommandDraftSession = DraftSessionInput

/** Whose catalog `list` / `complete` read: a session, or a draft id with its context. */
export interface CommandOwner {
  sessionId: string
  /** Read only with a draft id; none: a Chat draft. */
  draftSession?: CommandDraftSession | null
}

export interface CommandExecutionContext {
  sessionId: string
  invocationId: string
  invocationSource: CommandInvocationSource
  descriptor: CommandDescriptor
  parsed: ParsedCommandInput
  arguments: ValidatedCommandArguments
  attachments: string[]
  /** Chips in `parsed.raw` (a message starting with a skill chip). */
  references?: MessageReference[]
  /** Chips were sent but did not fit the parsed text (contract §2.3). */
  referencesDropped?: true
}

export interface CommandPlatformDeps {
  stateRoot: string
  listSkills: (sessionId: string) => SkillInfoPayload[]
  /** The Skills a draft's session will see (its Build project's included). */
  listDraftSkills: (draft: CommandDraftSession) => SkillInfoPayload[]
  sessionContext: (
    sessionId: string,
  ) => CommandSessionContext | Promise<CommandSessionContext>
  isBusy: (sessionId: string) => boolean
  executeBuiltin: (
    context: CommandExecutionContext,
  ) => Promise<CommandInvocationResult>
  submitSkill: (
    context: CommandExecutionContext,
  ) => Promise<CommandInvocationResult>
  queueAfterTurn: (input: {
    sessionId: string
    requestId: string
    run: () => Promise<CommandInvocationResult>
  }) => Promise<string>
  completeDynamic: (
    descriptor: CommandDescriptor,
    rawArgs: string,
    cursor: number,
    sessionId: string,
  ) => Promise<CommandCompletion[]>
}

export class CommandPlatform {
  private readonly deps: CommandPlatformDeps
  private readonly store: CommandInvocationStore

  constructor(deps: CommandPlatformDeps) {
    this.deps = deps
    this.store = new CommandInvocationStore(deps.stateRoot)
  }

  async list(
    input: CommandOwner & {
      includeUnavailable?: boolean
      invocationSource?: CommandInvocationSource
    },
  ): Promise<CommandDescriptor[]> {
    const registry = this.registry(input)
    const session = await this.sessionFor(input)
    const source = input.invocationSource ?? 'desktop'
    return registry
      .list()
      .map((descriptor) => availability(descriptor, session, source))
      .filter((descriptor) => input.includeUnavailable || descriptor.available)
  }

  diagnostics(sessionId: string): {
    status: 'ok' | 'warning'
    registeredSkills: number
    conflicts: ReturnType<typeof resolveSkillCommandCatalog>['conflicts']
    warnings: ReturnType<typeof resolveSkillCommandCatalog>['warnings']
  } {
    const registry = new CommandRegistry()
    registry.registerMany(builtinCommandDescriptors())
    const catalog = resolveSkillCommandCatalog(
      this.deps.listSkills(sessionId),
      registry.reservedNames(),
    )
    return {
      status:
        catalog.conflicts.length || catalog.warnings.length ? 'warning' : 'ok',
      registeredSkills: catalog.descriptors.length,
      conflicts: catalog.conflicts,
      warnings: catalog.warnings,
    }
  }

  async complete(
    input: CommandOwner & {
      commandId: string
      rawArgs: string
      cursor: number
      invocationSource: CommandInvocationSource
    },
  ): Promise<CommandCompletion[]> {
    const descriptor = await this.descriptorFor(input)
    if (!descriptor.available) return []
    const dynamic = await this.deps.completeDynamic(
      descriptor,
      input.rawArgs,
      input.cursor,
      input.sessionId,
    )
    if (dynamic.length) return dynamic
    return descriptor.argumentSchema
      .flatMap((spec) => spec.values ?? [])
      .filter((value) => value.startsWith(input.rawArgs.trim().toLowerCase()))
      .map((value) => ({ value, label: value, kind: 'enum' }))
  }

  async invoke(input: {
    sessionId: string
    commandId: string
    rawInput: string
    invocationId: string
    invocationSource: CommandInvocationSource
    attachments?: string[]
    references?: MessageReference[]
  }): Promise<CommandInvocationResult> {
    const invocationId = String(input.invocationId ?? '').trim()
    if (!invocationId)
      return rejected('invalid_invocation_id', '命令调用缺少 invocationId。')
    const digest = invocationDigest(input)
    let previous
    try {
      previous = this.store.get(input.sessionId, invocationId)
    } catch (error) {
      if (error instanceof CommandInvocationStoreCorruptError)
        return rejected(error.code, error.message)
      throw error
    }
    if (previous) {
      if (previous.digest !== digest)
        return rejected(
          'invocation_conflict',
          '同一 invocationId 不能用于不同命令。',
        )
      return previous.result
    }

    let parsed: ParsedCommandInput | null
    try {
      parsed = parseCommandInput(input.rawInput)
    } catch (error) {
      if (error instanceof CommandParseError)
        return rejected(error.code, error.message)
      throw error
    }
    if (!parsed) return rejected('not_a_command', '输入不是有效斜杠命令。')
    const registry = this.registry({ sessionId: input.sessionId })
    const byId = registry.get(input.commandId)
    const byName = registry.resolveName(parsed.name)
    if (!byId || !byName || byId.id !== byName.id)
      return rejected('command_mismatch', '命令 ID 与输入内容不一致。')
    const descriptor = availability(
      byId,
      await this.deps.sessionContext(input.sessionId),
      input.invocationSource,
    )
    if (!descriptor.invocationSources.includes(input.invocationSource))
      return rejected('source_not_allowed', '当前调用来源不能执行此命令。')
    if (!descriptor.available)
      return rejected(
        'command_unavailable',
        descriptor.unavailableReason || '命令当前不可用。',
      )
    const attachments = [...new Set(input.attachments ?? [])]
      .map((item) => String(item).trim())
      .filter(Boolean)
    if (attachments.length && descriptor.kind !== 'agent_prompt')
      return rejected(
        'command_attachments_unsupported',
        '内置控制命令不能携带附件；请移除附件后重试。',
      )
    let args: ValidatedCommandArguments
    try {
      args = validateCommandArguments(descriptor, parsed)
    } catch (error) {
      if (error instanceof CommandValidationError)
        return rejected(error.code, error.message)
      throw error
    }
    const context: CommandExecutionContext = {
      sessionId: input.sessionId,
      invocationId,
      invocationSource: input.invocationSource,
      descriptor,
      parsed,
      arguments: args,
      attachments,
      // Offsets hold only for the text as parsed.
      ...(input.references?.length
        ? referencesFit(parsed.raw, input.references)
          ? { references: input.references }
          : { referencesDropped: true }
        : {}),
    }
    const execute = async () => {
      let result: CommandInvocationResult
      try {
        result =
          descriptor.kind === 'agent_prompt'
            ? await this.deps.submitSkill(context)
            : await this.deps.executeBuiltin(context)
      } catch (error) {
        result = rejected(
          commandErrorCode(error),
          error instanceof Error ? error.message : '命令执行失败。',
        )
      }
      this.store.put(input.sessionId, invocationId, digest, result, {
        commandId: descriptor.id,
        invocationSource: input.invocationSource,
      })
      return result
    }
    if (this.deps.isBusy(input.sessionId)) {
      if (descriptor.busyPolicy === 'reject_when_busy')
        return rejected('command_busy', '请等待当前任务结束后再执行此命令。')
      if (descriptor.busyPolicy === 'after_turn') {
        let result: CommandInvocationResult
        try {
          const requestId = await this.deps.queueAfterTurn({
            sessionId: input.sessionId,
            requestId: `command:${invocationId}`,
            run: execute,
          })
          result = { status: 'queued', requestId }
        } catch (error) {
          result = rejected(
            commandErrorCode(error),
            error instanceof Error ? error.message : '命令排队失败。',
          )
        }
        this.store.put(input.sessionId, invocationId, digest, result, {
          commandId: descriptor.id,
          invocationSource: input.invocationSource,
        })
        return result
      }
    }
    return await execute()
  }

  private registry(owner: CommandOwner): CommandRegistry {
    const registry = new CommandRegistry()
    registry.registerMany(builtinCommandDescriptors())
    registry.registerMany(
      resolveSkillCommandCatalog(
        isDraftSessionId(owner.sessionId)
          ? this.deps.listDraftSkills(owner.draftSession ?? {})
          : this.deps.listSkills(owner.sessionId),
        registry.reservedNames(),
      ).descriptors,
    )
    return registry
  }

  /**
   * A draft lists and completes as the new, idle session it becomes: the
   * desktop creates that session before `commands.invoke`, which still
   * needs a real one.
   */
  private async sessionFor(
    owner: CommandOwner,
  ): Promise<CommandSessionContext> {
    return isDraftSessionId(owner.sessionId)
      ? { exists: true }
      : await this.deps.sessionContext(owner.sessionId)
  }

  private async descriptorFor(
    input: CommandOwner & {
      commandId: string
      invocationSource: CommandInvocationSource
    },
  ): Promise<CommandDescriptor> {
    const descriptor = this.registry(input).get(input.commandId)
    if (!descriptor) throw new Error(`unknown command: ${input.commandId}`)
    return availability(
      descriptor,
      await this.sessionFor(input),
      input.invocationSource,
    )
  }
}

function commandErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'command_failed'
  const code = String((error as { code?: unknown }).code ?? '').trim()
  return /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'command_failed'
}

function availability(
  descriptor: CommandDescriptor,
  session: CommandSessionContext,
  source: CommandInvocationSource,
): CommandDescriptor {
  let reason = ''
  if (!session.exists) reason = '会话不存在。'
  else if (!descriptor.invocationSources.includes(source))
    reason = '当前调用来源不支持此命令。'
  return {
    ...descriptor,
    available: !reason,
    unavailableReason: reason || undefined,
  }
}

function invocationDigest(input: {
  sessionId: string
  commandId: string
  rawInput: string
  invocationSource: CommandInvocationSource
  attachments?: string[]
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.sessionId,
        input.commandId,
        input.rawInput,
        input.invocationSource,
        [...new Set(input.attachments ?? [])].sort(),
      ]),
    )
    .digest('hex')
}

function rejected(code: string, message: string): CommandInvocationResult {
  return { status: 'rejected', code, message }
}
