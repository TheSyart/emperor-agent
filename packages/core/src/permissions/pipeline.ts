/**
 * PermissionPipeline (MIG-CTRL-016/017)。对齐 Python `agent/permissions/pipeline.py`。
 * 参数感知的三模式权限评估。规则名逐字保真。
 * PE-13: 高风险命令即便在已批准计划中仍需审批 —— 由 PermissionManager 在 token 前评估高风险体现。
 */
import type { ToolRegistry } from '../tools/registry'
import {
  PermissionDecision,
  PermissionMode,
  RiskLevel,
  traceEntry,
  type PermissionTraceEntry,
  type ToolPermissionProfile,
} from './models'
import {
  executesProjectCodeCommand,
  isHighRiskCommand,
  isLowRiskCommand,
  isReadonlyCommand,
  isSensitivePath,
} from '../tools/resolvers'
import { resolveToolProfile } from './resolve-profile'
import {
  matchPermissionRule,
  parsePermissionRules,
  type PermissionRule,
  type PermissionRuleDiagnostics,
  type PermissionRuleInput,
} from './rules'

export class PermissionPipeline {
  private readonly userRules: PermissionRule[]
  private readonly ruleDiagnostics: PermissionRuleDiagnostics

  constructor(opts: { rules?: PermissionRuleInput[] | null } = {}) {
    const parsed = parsePermissionRules(opts.rules ?? [])
    this.userRules = parsed.rules
    this.ruleDiagnostics = parsed.diagnostics
  }

  diagnostics(): PermissionRuleDiagnostics {
    return {
      loaded: this.ruleDiagnostics.loaded,
      invalid: this.ruleDiagnostics.invalid,
      invalidRules: this.ruleDiagnostics.invalidRules.map((rule) => ({
        ...rule,
      })),
    }
  }

  assess(
    toolName: string,
    args: Record<string, unknown> | null | undefined,
    mode: string,
    opts?: { registry?: ToolRegistry | null },
  ): PermissionDecision {
    const argv = args ?? {}
    const normalizedMode = normalizeMode(mode)
    const profile = resolveToolProfile(toolName, argv, {
      registry: opts?.registry ?? null,
    })
    const trace: PermissionTraceEntry[] = [
      traceEntry('mode.resolve', 'matched', normalizedMode),
    ]

    const userRuleDecision = this.assessUserRule(profile, trace)
    if (userRuleDecision !== null) return userRuleDecision

    if (toolName === 'ask_user') {
      trace.push(
        traceEntry('control.ask_user', 'allow', 'ask_user is always available'),
      )
      return allow(profile, 'control.ask_user', trace)
    }

    if (toolName === 'propose_plan' && normalizedMode !== PermissionMode.PLAN) {
      trace.push(
        traceEntry(
          'control.propose_plan',
          'deny',
          'propose_plan is only available in Plan mode',
        ),
      )
      return deny(
        profile,
        'control.propose_plan',
        'propose_plan is only available in Plan mode.',
        trace,
      )
    }

    if (normalizedMode === PermissionMode.AUTO) {
      // AUTO 只能自动执行经正向证明为只读的诊断命令。脚本、解释器、构建、测试和
      // 未知 executable 都可能承载任意副作用，不能再依赖有限黑名单判断安全性。
      if (profile.name === 'run_command') {
        if (isReadonlyCommand(profile.command)) {
          trace.push(
            traceEntry(
              'mode.auto.read_only_command',
              'allow',
              profile.command.slice(0, 160),
            ),
          )
          return allow(profile, 'mode.auto.read_only_command', trace)
        }
        trace.push(
          traceEntry(
            'mode.auto.command_approval',
            'approval',
            profile.command.slice(0, 160),
          ),
        )
        return approval(
          profile,
          'mode.auto.command_approval',
          `shell commands not proven read-only require approval in auto mode: ${profile.command.slice(0, 160)}`,
          trace,
          RiskLevel.HIGH,
        )
      }
      trace.push(
        traceEntry(
          'mode.auto',
          'allow',
          'policy approval disabled for auto mode',
        ),
      )
      return allow(profile, 'mode.auto', trace)
    }

    if (normalizedMode === PermissionMode.PLAN) {
      return this.assessPlan(profile, trace)
    }

    if (normalizedMode === PermissionMode.ASK_BEFORE_EDIT) {
      return this.assessAskBeforeEdit(profile, trace)
    }

    if (normalizedMode === PermissionMode.ACCEPT_EDITS) {
      return this.assessAcceptEdits(profile, trace)
    }

    trace.push(traceEntry('mode.unknown', 'deny', normalizedMode))
    return deny(
      profile,
      'mode.unknown',
      `unknown permission mode: ${mode}`,
      trace,
    )
  }

  isToolExposed(
    toolName: string,
    mode: string,
    opts?: { registry?: ToolRegistry | null },
  ): boolean {
    const normalizedMode = normalizeMode(mode)
    if (toolName === 'ask_user') return true
    if (toolName === 'propose_plan')
      return normalizedMode === PermissionMode.PLAN
    if (normalizedMode !== PermissionMode.PLAN) return true
    if (toolName === 'scheduler') return true
    if (toolName === 'dispatch_subagent') {
      const tool = opts?.registry ? opts.registry.get(toolName) : undefined
      return Boolean(
        tool &&
        (tool as { supportsPlanReadonlyExploration?: boolean })
          .supportsPlanReadonlyExploration,
      )
    }
    const profile = resolveToolProfile(
      toolName,
      {},
      { registry: opts?.registry ?? null },
    )
    return profile.readOnly
  }

  private assessPlan(
    profile: ToolPermissionProfile,
    trace: PermissionTraceEntry[],
  ): PermissionDecision {
    if (profile.name === 'propose_plan') {
      trace.push(
        traceEntry(
          'plan.control',
          'allow',
          'propose_plan submits the PlanCard',
        ),
      )
      return allow(profile, 'plan.control', trace)
    }

    if (profile.name === 'scheduler') {
      if (profile.schedulerAction === 'list') {
        trace.push(
          traceEntry(
            'plan.scheduler.list',
            'allow',
            'read-only scheduler inspection',
          ),
        )
        return allow(profile, 'plan.scheduler.list', trace)
      }
      trace.push(
        traceEntry(
          'plan.scheduler.mutation',
          'deny',
          profile.schedulerAction || '<missing action>',
        ),
      )
      return deny(
        profile,
        'plan.scheduler.mutation',
        "Plan mode only allows scheduler(action='list'); durable job changes require an approved plan.",
        trace,
      )
    }

    if (profile.readOnly) {
      trace.push(
        traceEntry('plan.read_only', 'allow', 'tool profile is read-only'),
      )
      return allow(profile, 'plan.read_only', trace)
    }

    trace.push(
      traceEntry('plan.write_block', 'deny', 'tool profile is not read-only'),
    )
    return deny(
      profile,
      'plan.write_block',
      'Plan mode only allows read-only tools plus ask_user/propose_plan.',
      trace,
    )
  }

  private assessUserRule(
    profile: ToolPermissionProfile,
    trace: PermissionTraceEntry[],
  ): PermissionDecision | null {
    const rule = matchPermissionRule(this.userRules, profile)
    if (!rule) return null
    const ruleName = `user_rule.${rule.id}`
    trace.push(traceEntry(ruleName, rule.action, rule.reason))
    if (rule.action === 'deny')
      return deny(profile, ruleName, rule.reason, trace)
    if (rule.action === 'ask')
      return approval(profile, ruleName, rule.reason, trace, RiskLevel.MEDIUM)
    return allow(profile, ruleName, trace)
  }

  private assessAskBeforeEdit(
    profile: ToolPermissionProfile,
    trace: PermissionTraceEntry[],
  ): PermissionDecision {
    if (profile.name === 'run_command') {
      if (executesProjectCodeCommand(profile.command)) {
        trace.push(
          traceEntry(
            'ask.run_command.project_code',
            'approval',
            profile.command.slice(0, 160),
          ),
        )
        return approval(
          profile,
          'ask.run_command.project_code',
          `command executes project-controlled code and requires approval: ${profile.command.slice(0, 160)}`,
          trace,
          RiskLevel.HIGH,
        )
      }
      if (isLowRiskCommand(profile.command)) {
        trace.push(
          traceEntry(
            'ask.run_command.low_risk_allowlist',
            'allow',
            profile.command.slice(0, 160),
          ),
        )
        return allow(profile, 'ask.run_command.low_risk_allowlist', trace)
      }
      const risk = isHighRiskCommand(profile.command)
        ? RiskLevel.HIGH
        : RiskLevel.MEDIUM
      trace.push(
        traceEntry(
          'ask.run_command.default_approval',
          'approval',
          profile.command.slice(0, 160),
        ),
      )
      return approval(
        profile,
        'ask.run_command.default_approval',
        `shell command requires approval: ${profile.command.slice(0, 160)}`,
        trace,
        risk,
      )
    }

    if (
      profile.name === 'spawn_teammate' ||
      profile.name === 'broadcast' ||
      profile.name === 'shutdown_teammate'
    ) {
      trace.push(traceEntry('ask.team_roster', 'approval', profile.name))
      return approval(
        profile,
        'ask.team_roster',
        'Agent Team roster or broadcast operation can affect persistent teammates.',
        trace,
      )
    }

    if (
      profile.name === 'send_message' &&
      Boolean((profile.arguments as Record<string, unknown>).wake ?? true)
    ) {
      trace.push(traceEntry('ask.team_wake', 'approval', 'wake=true'))
      return approval(
        profile,
        'ask.team_wake',
        'waking a teammate can run tools in a persistent teammate context.',
        trace,
      )
    }

    if (profile.name === 'scheduler') {
      return this.assessSchedulerInAskMode(profile, trace)
    }

    if (
      (profile.name === 'write_file' || profile.name === 'edit_file') &&
      isSensitivePath(profile.path)
    ) {
      trace.push(
        traceEntry('ask.sensitive_path', 'approval', profile.path || ''),
      )
      return approval(
        profile,
        'ask.sensitive_path',
        `sensitive or runtime path: ${profile.path}`,
        trace,
      )
    }

    if (
      profile.name === 'edit_file' &&
      Boolean((profile.arguments as Record<string, unknown>).replace_all)
    ) {
      trace.push(
        traceEntry('ask.bulk_replace', 'approval', String(profile.path || '')),
      )
      return approval(
        profile,
        'ask.bulk_replace',
        `bulk replace requested in ${profile.path}`,
        trace,
        RiskLevel.MEDIUM,
      )
    }

    trace.push(
      traceEntry('ask.default_allow', 'allow', 'no approval rule matched'),
    )
    return allow(profile, 'ask.default_allow', trace)
  }

  private assessAcceptEdits(
    profile: ToolPermissionProfile,
    trace: PermissionTraceEntry[],
  ): PermissionDecision {
    if (profile.readOnly) {
      trace.push(
        traceEntry(
          'accept_edits.read_only',
          'allow',
          'tool profile is read-only',
        ),
      )
      return allow(profile, 'accept_edits.read_only', trace)
    }

    if (profile.name === 'run_command') {
      const risk = isHighRiskCommand(profile.command)
        ? RiskLevel.HIGH
        : RiskLevel.MEDIUM
      trace.push(
        traceEntry(
          'accept_edits.run_command.approval',
          'approval',
          profile.command.slice(0, 160),
        ),
      )
      return approval(
        profile,
        'accept_edits.run_command.approval',
        `shell command requires approval in accept_edits mode: ${profile.command.slice(0, 160)}`,
        trace,
        risk,
      )
    }

    if (
      profile.name === 'spawn_teammate' ||
      profile.name === 'broadcast' ||
      profile.name === 'shutdown_teammate'
    ) {
      trace.push(
        traceEntry('accept_edits.team_roster', 'approval', profile.name),
      )
      return approval(
        profile,
        'accept_edits.team_roster',
        'Agent Team roster or broadcast operation can affect persistent teammates.',
        trace,
      )
    }

    if (
      profile.name === 'send_message' &&
      Boolean((profile.arguments as Record<string, unknown>).wake ?? true)
    ) {
      trace.push(traceEntry('accept_edits.team_wake', 'approval', 'wake=true'))
      return approval(
        profile,
        'accept_edits.team_wake',
        'waking a teammate can run tools in a persistent teammate context.',
        trace,
      )
    }

    if (profile.name === 'scheduler') {
      return this.assessSchedulerInAcceptEditsMode(profile, trace)
    }

    if (
      (profile.name === 'write_file' || profile.name === 'edit_file') &&
      isSensitivePath(profile.path)
    ) {
      trace.push(
        traceEntry(
          'accept_edits.sensitive_path',
          'approval',
          profile.path || '',
        ),
      )
      return approval(
        profile,
        'accept_edits.sensitive_path',
        `sensitive or runtime path: ${profile.path}`,
        trace,
      )
    }

    if (
      profile.name === 'edit_file' &&
      Boolean((profile.arguments as Record<string, unknown>).replace_all)
    ) {
      trace.push(
        traceEntry(
          'accept_edits.bulk_replace',
          'approval',
          String(profile.path || ''),
        ),
      )
      return approval(
        profile,
        'accept_edits.bulk_replace',
        `bulk replace requested in ${profile.path}`,
        trace,
        RiskLevel.MEDIUM,
      )
    }

    if (profile.name === 'write_file' || profile.name === 'edit_file') {
      trace.push(
        traceEntry(
          'accept_edits.file_edit',
          'allow',
          String(profile.path || ''),
        ),
      )
      return allow(profile, 'accept_edits.file_edit', trace)
    }

    trace.push(
      traceEntry('accept_edits.default_approval', 'approval', profile.name),
    )
    return approval(
      profile,
      'accept_edits.default_approval',
      'non-file mutating tool requires approval in accept_edits mode.',
      trace,
      RiskLevel.MEDIUM,
    )
  }

  private assessSchedulerInAskMode(
    profile: ToolPermissionProfile,
    trace: PermissionTraceEntry[],
  ): PermissionDecision {
    const action = profile.schedulerAction
    if (action === 'list') {
      trace.push(
        traceEntry(
          'ask.scheduler.list',
          'allow',
          'read-only scheduler inspection',
        ),
      )
      return allow(profile, 'ask.scheduler.list', trace)
    }
    if (
      action === 'add' ||
      action === 'update' ||
      action === 'remove' ||
      action === 'pause' ||
      action === 'resume' ||
      action === 'run'
    ) {
      trace.push(traceEntry('ask.scheduler.mutation', 'approval', action))
      const risk =
        action === 'add' ||
        action === 'update' ||
        action === 'remove' ||
        action === 'run'
          ? RiskLevel.HIGH
          : RiskLevel.MEDIUM
      return approval(
        profile,
        'ask.scheduler.mutation',
        'scheduler jobs persist and may run later outside the current user turn.',
        trace,
        risk,
      )
    }
    trace.push(
      traceEntry(
        'ask.scheduler.default',
        'allow',
        action || '<missing action>',
      ),
    )
    return allow(profile, 'ask.scheduler.default', trace)
  }

  private assessSchedulerInAcceptEditsMode(
    profile: ToolPermissionProfile,
    trace: PermissionTraceEntry[],
  ): PermissionDecision {
    const action = profile.schedulerAction
    if (action === 'list') {
      trace.push(
        traceEntry(
          'accept_edits.scheduler.list',
          'allow',
          'read-only scheduler inspection',
        ),
      )
      return allow(profile, 'accept_edits.scheduler.list', trace)
    }
    trace.push(
      traceEntry(
        'accept_edits.scheduler.mutation',
        'approval',
        action || '<missing action>',
      ),
    )
    return approval(
      profile,
      'accept_edits.scheduler.mutation',
      'scheduler jobs persist and may run later outside the current user turn.',
      trace,
      action === 'pause' || action === 'resume'
        ? RiskLevel.MEDIUM
        : RiskLevel.HIGH,
    )
  }
}

function normalizeMode(mode: string): string {
  if (
    mode === '' ||
    mode === 'normal' ||
    mode === PermissionMode.ASK_BEFORE_EDIT
  ) {
    return PermissionMode.ASK_BEFORE_EDIT
  }
  const value = String(mode || '').trim()
  if (value === 'accept-edits' || value === 'accept edits')
    return PermissionMode.ACCEPT_EDITS
  return value
}

function allow(
  profile: ToolPermissionProfile,
  rule: string,
  trace: PermissionTraceEntry[],
): PermissionDecision {
  return PermissionDecision.allow({
    toolName: profile.name,
    arguments: profile.arguments,
    rule,
    trace: [...trace],
  })
}

function deny(
  profile: ToolPermissionProfile,
  rule: string,
  reason: string,
  trace: PermissionTraceEntry[],
): PermissionDecision {
  return PermissionDecision.deny({
    toolName: profile.name,
    arguments: profile.arguments,
    reason,
    rule,
    trace: [...trace],
  })
}

function approval(
  profile: ToolPermissionProfile,
  rule: string,
  reason: string,
  trace: PermissionTraceEntry[],
  risk: string = RiskLevel.HIGH,
): PermissionDecision {
  return PermissionDecision.approval({
    toolName: profile.name,
    arguments: profile.arguments,
    reason,
    risk,
    rule,
    trace: [...trace],
  })
}
