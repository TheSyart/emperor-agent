/**
 * PlanDecisionPolicy (MIG-CTRL-005)。对齐 Python `agent/control/plan_policy.py`。
 * 信号集 / hard 信号 / 跳过条件 / to_runtime_contract 逐字保真。
 */
import { ControlMode } from './models'

export type PlanBehavior = 'required' | 'recommended' | 'proceed'

const SIGNAL_SCOPES: Record<string, string> = {
  security:
    'Read authentication, authorization, and permission-related modules before proposing edits.',
  architecture:
    'Map the affected architecture, composition roots, and existing extension points.',
  migration:
    'Inspect schema, migration, and persistence code before choosing an approach.',
  deployment:
    'Inspect deployment, release, scheduler, and environment configuration paths.',
  destructive:
    'Search all delete, overwrite, cleanup, and persistence call sites before changing data paths.',
  refactor: 'Trace callers and public contracts before proposing a refactor.',
  multi_module:
    'Search each affected module and identify shared interfaces before implementation.',
}

export class PlanDecision {
  readonly behavior: PlanBehavior
  readonly reason: string
  readonly signals: string[]

  constructor(behavior: PlanBehavior, reason: string, signals: string[]) {
    this.behavior = behavior
    this.reason = reason
    this.signals = signals
  }

  get triggers(): string[] {
    return [...this.signals]
  }

  get suggestedQuestions(): string[] {
    if (this.behavior === 'proceed') return []
    if (this.signals.includes('unclear_acceptance')) {
      return [
        'What acceptance criteria or scope boundaries should be confirmed before implementation?',
      ]
    }
    if (
      this.signals.includes('architecture') ||
      this.signals.includes('refactor')
    ) {
      return [
        'Which implementation approach or migration boundary should be preferred?',
      ]
    }
    return [
      'What scope, success criteria, or tradeoffs should be clarified before implementation?',
    ]
  }

  get recommendedReadonlyScopes(): string[] {
    const scopes: string[] = []
    for (const signal of this.signals) {
      const scope = SIGNAL_SCOPES[signal]
      if (scope) scopes.push(scope)
    }
    if (!scopes.length && this.behavior !== 'proceed') {
      scopes.push(
        'Search existing implementation patterns and related tests.',
        'Read the most relevant files before proposing edits.',
      )
    } else if (
      this.signals.includes('feature') ||
      this.signals.includes('multi_step')
    ) {
      scopes.push(
        'Search existing implementation patterns and related tests.',
        'Read the most relevant files before proposing edits.',
      )
    }
    return dedupe(scopes)
  }

  toRuntimeContract(): Record<string, unknown> {
    return {
      decision: this.behavior,
      reason: this.reason,
      triggers: this.triggers,
      suggested_questions: this.suggestedQuestions,
      recommended_readonly_scopes: this.recommendedReadonlyScopes,
    }
  }
}

export class PlanDecisionPolicy {
  assess(
    userMessage: string,
    opts: { mode: string; hasPending: boolean },
  ): PlanDecision {
    const text = normalize(userMessage)
    if (opts.mode === ControlMode.PLAN) {
      return new PlanDecision('proceed', 'Plan mode is already active.', [
        'already_in_plan',
      ])
    }
    if (opts.hasPending) {
      return new PlanDecision(
        'proceed',
        'Ask / Plan interaction is already pending.',
        ['pending_interaction'],
      )
    }
    if (hasProvidedPlan(text)) {
      return new PlanDecision(
        'proceed',
        'User provided an implementation plan.',
        ['user_provided_plan'],
      )
    }
    if (isSmallDirectWork(text)) {
      return new PlanDecision('proceed', 'Request appears small and direct.', [
        'small_direct_work',
      ])
    }

    const signals = collectSignals(text)
    if (requiresPlan(signals)) {
      return new PlanDecision(
        'required',
        'High-impact implementation should be planned before writing.',
        signals,
      )
    }
    if (recommendsPlan(signals)) {
      return new PlanDecision(
        'recommended',
        'Multi-step implementation would benefit from a plan.',
        signals,
      )
    }
    return new PlanDecision(
      'proceed',
      'No planning guard signal matched.',
      signals,
    )
  }
}

function normalize(text: string): string {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p)
    .join(' ')
}

function hasProvidedPlan(text: string): boolean {
  const markers = [
    'please implement this plan',
    'implement this plan',
    '执行这个计划',
    '按照这个计划',
    '实施这个计划',
    '## test plan',
    '## implementation',
  ]
  return markers.some((m) => text.includes(m))
}

function isSmallDirectWork(text: string): boolean {
  const smallMarkers = [
    'typo',
    '错别字',
    '拼写',
    'readme',
    '注释',
    'console.log',
    '单行',
    'single-line',
  ]
  if (!smallMarkers.some((m) => text.includes(m))) return false
  return !['重构', '架构', 'migration', '部署', '权限', '安全'].some((m) =>
    text.includes(m),
  )
}

function collectSignals(text: string): string[] {
  const checks: Array<[string, string[]]> = [
    ['architecture', ['architecture', 'architectural', '架构', '系统设计']],
    ['refactor', ['refactor', 'restructure', '重构', '改造']],
    [
      'multi_module',
      ['multiple modules', '多模块', '跨模块', '全项目', '从头到尾'],
    ],
    ['deployment', ['deploy', 'deployment', 'release', '发布', '部署', '上线']],
    ['destructive', ['delete', 'remove', 'overwrite', '删除', '覆盖', '清空']],
    [
      'security',
      ['permission', 'permissions', 'security', 'auth', '权限', '安全', '认证'],
    ],
    [
      'migration',
      ['migration', 'migrate', 'schema', '数据迁移', '迁移', '数据库迁移'],
    ],
    [
      'unclear_acceptance',
      ['unclear acceptance', '验收不明确', '需求不明确', '范围不清'],
    ],
    [
      'feature',
      ['feature', 'implement', 'add ', '新增', '增加', '实现', '添加'],
    ],
    [
      'multi_step',
      ['测试', 'test', '多个步骤', 'multi-step', '状态管理', 'ui'],
    ],
  ]
  const signals: string[] = []
  for (const [signal, markers] of checks) {
    if (markers.some((m) => text.includes(m))) signals.push(signal)
  }
  if (countOccurrences(text, '、') >= 2 || countOccurrences(text, ',') >= 2)
    signals.push('multi_step')
  return dedupe(signals)
}

function requiresPlan(signals: string[]): boolean {
  const hard = new Set(['architecture', 'migration', 'unclear_acceptance'])
  return (
    signals.some((s) => hard.has(s)) ||
    (signals.includes('refactor') &&
      (signals.includes('multi_module') || signals.includes('security')))
  )
}

function recommendsPlan(signals: string[]): boolean {
  return (
    signals.includes('feature') ||
    signals.includes('multi_step') ||
    signals.includes('refactor') ||
    signals.includes('multi_module')
  )
}

function countOccurrences(text: string, sub: string): number {
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(sub, pos)) >= 0) {
    count++
    pos += sub.length
  }
  return count
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}
