/**
 * Control 子系统集成契约 (MIG-CTRL-001..017 经 ControlManager)。
 * 移植 Python:
 *  - tests/unit/test_control.py (ControlManager-level：不含 AgentRunner 的用例)
 *  - tests/unit/test_plan_decision_policy.py (PlanDecisionPolicy)
 *  - tests/unit/test_permission_pipeline_v2.py::test_high_risk_in_approved_plan_still_requires_approval (PE-13)
 *  - tests/unit/test_plan_quality_gate.py (ProposePlanTool 集成)
 *  - tests/unit/test_plan_verification_matrix.py::test_all_required_legacy_commands_must_pass_before_completion
 *  - tests/unit/test_plan_execution_state.py::test_todo_store_syncs_from_plan_steps (TodoStore)
 * 注: test_runner_* 依赖 AgentRunner (W03) — 留待 W03 测试移植。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ControlManager } from './manager'
import { ControlMode } from './models'
import { PlanDecisionPolicy } from './plan-policy'
import { AskUserTool, ProposePlanTool, RequestPlanModeTool, parsePauseResult } from './tools'
import { ReadFileTool, WriteFileTool } from '../tools/filesystem'
import { Tool } from '../tools/base'
import { toolParamsSchema, S } from '../tools/schema'
import { TodoStore } from '../tools/builtin'
import { ToolRegistry } from '../tools/registry'
import { makePlanRecord, PlanStatus } from '../plans/models'
import { independentVerificationRiskSignals } from './plan-helpers'
import { TaskManager } from '../tasks/manager'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class SchedulerStub extends Tool {
  override name = 'scheduler'
  override description = 'scheduler stub'
  override parameters = toolParamsSchema({ action: S('action') }, ['action'])
  override readOnly = false
  execute(): string { return 'ok' }
}

function makeQuestion(): Record<string, unknown> {
  return {
    id: 'scope',
    header: '范围',
    question: '本次范围怎么定？',
    options: [
      { label: '最小', description: '只做核心路径' },
      { label: '完整', description: '连同文档测试一起做' },
    ],
  }
}

function makeRegistry(manager: ControlManager): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadFileTool('/tmp'))
  registry.register(new WriteFileTool('/tmp'))
  registry.register(new SchedulerStub())
  registry.register(new AskUserTool(manager))
  registry.register(new ProposePlanTool(manager))
  registry.register(new RequestPlanModeTool(manager))
  return registry
}

// ── test_control.py (ControlManager-level) ──

describe('ControlManager (test_control.py)', () => {
  it('control store recovers from corrupt state', () => {
    const root = tmp('emperor-ctrl-corrupt-')
    const manager = new ControlManager(root)
    manager.setMode('plan')
    expect(manager.payload().mode).toBe('plan')
    writeFileSync(join(root, 'memory', 'control', 'state.json'), '{bad', 'utf8')
    expect(new ControlManager(root).payload().mode).toBe(ControlMode.ASK_BEFORE_EDIT)
  })

  it('ask_user validation and answer message', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-ask-'))
    const interaction = manager.createAsk({ questions: [makeQuestion()], context: 'need scope' })
    expect(interaction.kind).toBe('ask')
    expect((manager.payload().pending as Record<string, unknown>).id).toBe(interaction.id)

    const resume = manager.answer(interaction.id, { scope: { choice: '完整', freeform: '包含 README' } })
    expect(resume.message).toContain('本次范围怎么定')
    expect(resume.message).toContain('完整')
    expect(manager.payload().pending).toBeNull()
  })

  it('cancels an executable plan when the user answers to ignore or abandon the stuck plan', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-abandon-plan-'))
    const planInteraction = manager.createPlan({
      title: 'Stale game plan',
      summary: 'A plan the user no longer wants.',
      planMarkdown: '# Plan\n\n- Build game',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Build game',
        description: 'Create a game file.',
        commands: ['echo verify'],
        acceptance: ['file exists'],
      }],
    })
    manager.approve(planInteraction.id)
    expect(manager.latestExecutablePlan()?.status).toBe(PlanStatus.APPROVED)

    const ask = manager.createAsk({
      questions: [{
        id: 'plan_stuck',
        header: '计划系统阻塞',
        question: '是否继续执行这个旧计划？',
        options: [
          { label: '无视系统继续', description: '放弃旧计划，回到用户新指令' },
          { label: '继续执行', description: '继续当前计划' },
        ],
      }],
    })

    manager.answer(ask.id, { plan_stuck: { choice: '无视系统继续', freeform: '' } })

    const latest = manager.planStore.latest()
    expect(latest?.status).toBe(PlanStatus.CANCELLED)
    expect(manager.latestExecutablePlan()).toBeNull()
  })

  it('does not expose executable plans across different session or project scopes', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-plan-scope-'))
    manager.setRuntimeScope({
      sessionId: 'session_old',
      projectId: 'project_old',
      workspaceRoot: '/tmp/old-project',
    })
    const planInteraction = manager.createPlan({
      title: 'Old scoped plan',
      summary: 'Belongs to a different project.',
      planMarkdown: '# Plan\n\n- Old work',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Old work',
        description: 'This must not leak into another project.',
        commands: ['echo old'],
        acceptance: ['old project only'],
      }],
    })
    manager.approve(planInteraction.id)
    expect(manager.latestExecutablePlan()?.id).toBe(String(planInteraction.meta.plan_id))

    manager.setRuntimeScope({
      sessionId: 'session_new',
      projectId: 'project_new',
      workspaceRoot: '/tmp/new-project',
    })

    expect(manager.latestExecutablePlan()).toBeNull()
  })

  it('stamps first-class session ownership onto created plans', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-plan-session-'))
    manager.setRuntimeScope({ sessionId: 'sess_p', projectId: '', workspaceRoot: '' })
    const interaction = manager.createPlan({
      title: 'Owned plan',
      summary: 'Session-scoped plan.',
      planMarkdown: '# Plan\n\n- work',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'work',
        description: 'do work',
        commands: ['echo hi'],
        acceptance: ['done'],
      }],
    })
    const planId = String(interaction.meta.plan_id)
    expect(manager.planStore.get(planId)?.sessionId).toBe('sess_p')
  })

  it('tags plan step tasks with the current runtime scope', () => {
    const root = tmp('emperor-ctrl-plan-task-scope-')
    const manager = new ControlManager(root)
    const taskManager = new TaskManager(root)
    manager.setTodoStore(new TodoStore())
    manager.setTaskManager(taskManager)
    manager.setRuntimeScope({
      sessionId: 'session_1',
      projectId: 'project_1',
      workspaceRoot: '/tmp/project_1',
    })
    const planInteraction = manager.createPlan({
      title: 'Scoped plan task',
      summary: 'Plan step tasks must be queryable by session/project scope.',
      planMarkdown: '# Plan\n\n- Scoped work',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Scoped work',
        description: 'Create a scoped task.',
        commands: ['echo ok'],
        acceptance: ['task metadata includes scope'],
      }],
    })

    manager.approve(planInteraction.id)

    const plan = manager.planStore.latest()
    const taskId = String((plan!.metadata.plan_step_tasks as Record<string, string>).step_1)
    expect(taskManager.store.get(taskId)?.metadata.scope).toEqual({
      session_id: 'session_1',
      project_id: 'project_1',
      workspace_root: '/tmp/project_1',
    })
  })

  it('propose_plan comment and approve restores previous (plan) mode', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-plan-'))
    manager.setMode('plan')
    const interaction = manager.createPlan({
      title: '实现 Ask',
      summary: '先做控制层',
      planMarkdown: '# Plan\n\n- Build it',
      assumptions: ['v1 only'],
      riskLevel: 'medium',
    })
    expect(String(((manager.payload().pending as Record<string, unknown>).meta as Record<string, unknown>).plan_id)).toMatch(/^plan_/)

    const comment = manager.comment(interaction.id, '补充 CLI')
    expect(comment.message).toContain('补充 CLI')
    expect(manager.payload().pending).toBeNull()
    expect(manager.payload().mode).toBe('plan')

    const revised = manager.createPlan({
      title: '实现 Ask v2',
      summary: '加入 CLI',
      planMarkdown: '# Plan\n\n- Build CLI',
      assumptions: [],
      riskLevel: 'low',
    })
    const approval = manager.approve(revised.id)
    expect(approval.message).toContain('PLAN_APPROVED')
    expect(manager.payload().mode).toBe(ControlMode.ASK_BEFORE_EDIT)
    expect(manager.payload().pending).toBeNull()
  })

  it('plan approval restores auto mode', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-auto-'))
    manager.setMode(ControlMode.AUTO)
    manager.setMode(ControlMode.PLAN)
    expect(manager.payload().previous_mode).toBe(ControlMode.AUTO)

    const interaction = manager.createPlan({
      title: '自动模式计划',
      summary: '批准后回到 auto',
      planMarkdown: '# Plan\n\n- Run it',
      assumptions: [],
      riskLevel: 'low',
    })
    manager.approve(interaction.id)
    expect(manager.payload().mode).toBe(ControlMode.AUTO)
    expect(manager.payload().previous_mode).toBeNull()
  })

  it('plan approval restores accept_edits mode', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-accept-edits-'))
    manager.setMode(ControlMode.ACCEPT_EDITS)
    manager.setMode(ControlMode.PLAN)
    expect(manager.payload().previous_mode).toBe(ControlMode.ACCEPT_EDITS)

    const interaction = manager.createPlan({
      title: '编辑模式计划',
      summary: '批准后回到 accept_edits',
      planMarkdown: '# Plan\n\n- Run it',
      assumptions: [],
      riskLevel: 'low',
    })
    manager.approve(interaction.id)
    expect(manager.payload().mode).toBe(ControlMode.ACCEPT_EDITS)
    expect(manager.payload().previous_mode).toBeNull()
  })

  it('cancel returns history message and clears pending', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-cancel-'))
    const interaction = manager.createAsk({ questions: [makeQuestion()] })
    const event = manager.cancel(interaction.id)
    expect(event.event).toBe('interaction_cancelled')
    expect(String(event.message)).toContain('INTERACTION_CANCELLED')
    expect(manager.payload().pending).toBeNull()
  })

  it('plan policy filters write tools', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-filter-'))
    const registry = makeRegistry(manager)
    manager.setMode(ControlMode.PLAN)
    const names = manager.toolDefinitions(registry).map((item) => item.name)
    expect(names).toContain('read_file')
    expect(names).toContain('ask_user')
    expect(names).toContain('propose_plan')
    expect(names).toContain('scheduler')
    expect(names).not.toContain('write_file')
    expect(manager.isToolAllowed('write_file', registry)).toBe(false)
  })

  it('exposes request_plan_mode outside plan mode and hides it inside plan mode', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-rpm-expose-'))
    const registry = makeRegistry(manager)

    const normalNames = manager.toolDefinitions(registry).map((item) => item.name)
    expect(normalNames).toContain('request_plan_mode')
    expect(normalNames).not.toContain('propose_plan')

    manager.setMode(ControlMode.PLAN)
    const planNames = manager.toolDefinitions(registry).map((item) => item.name)
    expect(planNames).toContain('propose_plan')
    expect(planNames).not.toContain('request_plan_mode')
  })

  it('request_plan_mode pauses the turn and switches to plan mode only when the user approves', async () => {
    const manager = new ControlManager(tmp('emperor-ctrl-rpm-approve-'))
    const tool = new RequestPlanModeTool(manager)

    const raw = await tool.execute({ reason: '需要重构鉴权架构' }, { root: '/tmp', arguments: {}, parentCallId: 'call_rpm' })
    const interaction = parsePauseResult(String(raw))
    expect(interaction).not.toBeNull()

    const resume = manager.answer(String(interaction!.id), { enter_plan_mode: '同意进入计划模式' })
    expect(manager.mode).toBe(ControlMode.PLAN)
    expect(resume.resume).toBe(true)
    expect(String(resume.message)).toContain('计划模式')
  })

  it('request_plan_mode leaves the mode unchanged when the user declines', async () => {
    const manager = new ControlManager(tmp('emperor-ctrl-rpm-decline-'))
    const tool = new RequestPlanModeTool(manager)

    const raw = await tool.execute({ reason: '大规模改动' }, { root: '/tmp', arguments: {}, parentCallId: 'call_rpm2' })
    const interaction = parsePauseResult(String(raw))

    manager.answer(String(interaction!.id), { enter_plan_mode: '暂不进入' })
    expect(manager.mode).toBe(ControlMode.ASK_BEFORE_EDIT)
  })

  it('clarification: requires ask for ambiguous high-impact work', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar1-'))
    const assessment = manager.assessClarification([
      { role: 'user', content: '阅读项目找到问题作出修改，不要打补丁，要工程化实现' },
    ])
    expect(assessment.required).toBe(true)
    expect(assessment.questions.length).toBeGreaterThan(0)
  })

  it('clarification: requires ask for project-level prompt workflow', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar2-'))
    const assessment = manager.assessClarification([
      { role: 'user', content: '从头到尾评估项目，优化 agent 的各种提示词和思考工作流程' },
    ])
    expect(assessment.required).toBe(true)
    expect(assessment.categories).toContain('scope')
  })

  it('clarification: skips small optimization', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar3-'))
    const assessment = manager.assessClarification([
      { role: 'user', content: '优化这个函数的变量命名，直接做' },
    ])
    expect(assessment.required).toBe(false)
  })

  it('clarification: skips decision-complete plan', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar4-'))
    const assessment = manager.assessClarification([
      { role: 'user', content: '# Summary\n\nPLEASE IMPLEMENT THIS PLAN:\n\n## Key Changes\n- 做 A\n\n## Test Plan\n- pytest' },
    ])
    expect(assessment.required).toBe(false)
  })
})

// ── test_plan_decision_policy.py ──

describe('PlanDecisionPolicy (test_plan_decision_policy.py)', () => {
  const policy = new PlanDecisionPolicy()

  it('requires plan for high-impact requests', () => {
    const decision = policy.assess('重构认证架构，涉及权限模型、数据库迁移和部署流程，验收标准还不明确', {
      mode: ControlMode.ASK_BEFORE_EDIT,
      hasPending: false,
    })
    expect(decision.behavior).toBe('required')
    expect(decision.signals).toContain('architecture')
    expect(decision.signals).toContain('migration')
    expect(decision.signals).toContain('deployment')
    expect(decision.triggers).toEqual(decision.signals)
    expect(decision.recommendedReadonlyScopes.length).toBeGreaterThan(0)
    expect(decision.recommendedReadonlyScopes.some((s) => s.includes('auth') || s.includes('认证'))).toBe(true)
    expect(decision.suggestedQuestions.length).toBeGreaterThan(0)
  })

  it('recommends plan for feature-scale work', () => {
    const decision = policy.assess('给设置页增加暗色模式开关，需要改 UI、状态管理和测试', {
      mode: ControlMode.ASK_BEFORE_EDIT,
      hasPending: false,
    })
    expect(decision.behavior).toBe('recommended')
    expect(decision.signals).toContain('feature')
    expect(decision.signals).toContain('multi_step')
    expect(decision.triggers).toEqual(decision.signals)
    expect(decision.recommendedReadonlyScopes.length).toBeGreaterThan(0)
  })

  it('serializes runtime contract', () => {
    const decision = policy.assess('Add a realtime dashboard feature with UI state management and tests', {
      mode: ControlMode.ASK_BEFORE_EDIT,
      hasPending: false,
    })
    expect(decision.toRuntimeContract()).toEqual({
      decision: 'recommended',
      reason: 'Multi-step implementation would benefit from a plan.',
      triggers: ['feature', 'multi_step'],
      suggested_questions: ['What scope, success criteria, or tradeoffs should be clarified before implementation?'],
      recommended_readonly_scopes: [
        'Search existing implementation patterns and related tests.',
        'Read the most relevant files before proposing edits.',
      ],
    })
  })

  it('proceeds for small or already-planned work', () => {
    expect(policy.assess('修复 README 里的一个错别字', { mode: ControlMode.ASK_BEFORE_EDIT, hasPending: false }).behavior).toBe('proceed')
    expect(policy.assess('PLEASE IMPLEMENT THIS PLAN:\n\n1. 修改 agent/foo.py\n2. 运行 pytest', { mode: ControlMode.ASK_BEFORE_EDIT, hasPending: false }).behavior).toBe('proceed')
  })

  it('proceeds when plan mode or pending interaction exists', () => {
    expect(policy.assess('重构权限系统', { mode: ControlMode.PLAN, hasPending: false }).behavior).toBe('proceed')
    expect(policy.assess('重构权限系统', { mode: ControlMode.ASK_BEFORE_EDIT, hasPending: true }).behavior).toBe('proceed')
  })
})

// ── PE-13: test_permission_pipeline_v2.py::test_high_risk_in_approved_plan_still_requires_approval ──

describe('PermissionManager PE-13 (test_permission_pipeline_v2.py)', () => {
  it('high-risk command in approved plan still requires approval; low-risk uses token path', () => {
    const manager = new ControlManager(tmp('emperor-pe13-'))
    // 注入一个 token 消费者：始终返回 token（模拟已批准计划）
    manager.permissionManager['controlManager'].consumePlanPermissionToken = () => ({
      planId: 'plan_x',
      stepId: 'step_1',
      toolName: 'run_command',
      argumentHash: '',
      expiresAt: 0,
      usesRemaining: 1,
      reason: '',
    })

    const decision = manager.assessPermission('run_command', { command: 'git push origin main' }, null)
    expect(decision.requiresApproval).toBe(true)

    const low = manager.assessPermission('run_command', { command: 'echo hi from plan' }, null)
    expect(low.allowed).toBe(true)
    expect(low.rule).toBe('plan.permission_token')
  })
})

// ── test_plan_quality_gate.py (ProposePlanTool integration) ──

describe('ProposePlanTool quality gate (test_plan_quality_gate.py)', () => {
  it('rejects weak plan without pending card', () => {
    const manager = new ControlManager(tmp('emperor-qg-weak-'))
    manager.setMode('plan')
    const tool = new ProposePlanTool(manager)
    const result = tool.execute({
      title: 'Improve code',
      summary: 'Make things better',
      plan_markdown: '# Plan\n\n- Fix issue',
      steps: [
        { id: 'step_1', title: 'fix issue', risk: 'medium' },
        { id: 'step_2', title: 'improve code', description: 'Change implementation', risk: 'medium' },
      ],
      assumptions: [],
      risk_level: 'medium',
    }) as string
    expect(result.startsWith('Error: plan quality gate failed')).toBe(true)
    expect(result).toContain('step_1 has no target files, discovery reference, or concrete scope')
    expect(result).toContain('step_1 title is too generic')
    expect(result).toContain('step_2 has no verification command or manual verification rule')
    expect(manager.payload().pending).toBeNull()
    expect(manager.planStore.list().every((p) => p.status !== PlanStatus.WAITING_APPROVAL)).toBe(true)
  })

  it('rejects high-risk step without risk + rollback notes', () => {
    const manager = new ControlManager(tmp('emperor-qg-risk-'))
    manager.setMode('plan')
    const result = new ProposePlanTool(manager).execute({
      title: 'Auth migration',
      summary: 'Migrate authentication storage',
      plan_markdown: '# Plan\n\n- Migrate auth storage',
      steps: [
        {
          id: 'step_1',
          title: 'Migrate auth token storage',
          description: 'Move auth tokens to the new encrypted storage path.',
          files: ['agent/auth/storage.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_auth_storage.py -q'],
          acceptance: ['existing sessions can still be read'],
          risk: 'high',
        },
      ],
      assumptions: [],
      risk_level: 'high',
    }) as string
    expect(result.startsWith('Error: plan quality gate failed')).toBe(true)
    expect(result).toContain('step_1 is high risk but has no risk note')
    expect(result).toContain('step_1 is high risk but has no rollback path')
    expect(manager.payload().pending).toBeNull()
  })

  it('accepts a concrete verifiable plan and creates a waiting card', () => {
    const manager = new ControlManager(tmp('emperor-qg-ok-'))
    manager.setMode('plan')
    const result = new ProposePlanTool(manager).execute({
      title: 'Plan quality gate',
      summary: 'Reject weak plans before approval',
      plan_markdown: '# Plan\n\n- Add gate tests\n- Implement gate\n\n## 验证\n- Run focused pytest',
      steps: [
        {
          id: 'step_1',
          title: 'Add plan quality gate tests',
          description: 'Cover weak plans and accepted concrete plans.',
          files: ['tests/unit/test_plan_quality_gate.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_plan_quality_gate.py -q'],
          acceptance: ['weak plans return a repairable tool error'],
          risk: 'low',
        },
        {
          id: 'step_2',
          title: 'Enforce plan quality before PlanCard creation',
          description: 'Wire the gate through ProposePlanTool without changing approved execution state.',
          files: ['agent/control/tools.py', 'agent/plans/quality.py'],
          commands: ['.venv/bin/python -m pytest tests/unit/test_plan_runtime.py -q'],
          acceptance: ['accepted plans still create a pending PlanCard'],
          risk: 'high',
          risk_note: 'The gate can over-block model-generated plans if rules are too strict.',
          rollback: 'Disable enforce_quality on ProposePlanTool while keeping low-level create_plan available.',
        },
      ],
      assumptions: ['internal create_plan helper remains available for tests'],
      risk_level: 'high',
    }) as string
    const interaction = parsePauseResult(result)
    expect(interaction).not.toBeNull()
    expect((manager.payload().pending as Record<string, unknown>).id).toBe(interaction!.id)
    const saved = manager.planStore.get(String((interaction!.meta as Record<string, unknown>).plan_id))
    expect(saved).not.toBeNull()
    expect(saved!.status).toBe(PlanStatus.WAITING_APPROVAL)
    expect(saved!.steps[1]!.riskNote.startsWith('The gate can over-block')).toBe(true)
    expect(saved!.steps[1]!.rollback.startsWith('Disable enforce_quality')).toBe(true)
  })
})

// ── Claude Code-style TodoWrite/TaskUpdate semantics: todo progress is not a plan evidence gate ──

describe('Plan verification matrix integration (test_plan_verification_matrix.py)', () => {
  function managerWithActiveStep(commands: string[], extraStep: Record<string, unknown> = {}): { manager: ControlManager; planId: string } {
    const manager = new ControlManager(tmp('emperor-vmatrix-'))
    manager.setTodoStore(new TodoStore())
    manager.setMode('plan')
    new ProposePlanTool(manager).execute({
      title: 'Verification matrix',
      summary: 'Require all verification requirements before completion.',
      plan_markdown: '# Plan\n\n- Run matrix',
      steps: [
        {
          id: 'step_1',
          title: 'Run matrix',
          description: 'Execute required verification.',
          files: ['agent/runner.py'],
          commands,
          acceptance: ['verification requirements are satisfied'],
          ...extraStep,
        },
      ],
      assumptions: [],
      risk_level: 'low',
    })
    const pending = manager.payload().pending as Record<string, unknown>
    manager.approve(String(pending.id))
    const plan = manager.planStore.latest()
    expect(plan).not.toBeNull()
    return { manager, planId: plan!.id }
  }

  it('failed command evidence is recorded without forcing the active step to failed', () => {
    const command = '.venv/bin/python -m pytest tests/unit/test_runner_state.py -q'
    const { manager, planId } = managerWithActiveStep([command])

    const updated = manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command, passed: false, summary: 'test failed' },
    })

    expect(updated!.steps[0]!.status).toBe('active')
    expect(updated!.steps[0]!.evidence.at(-1)).toMatchObject({ command, passed: false })
  })

  it('matches explicit verification commands as evidence targets', () => {
    const command = 'npm --prefix desktop run test'
    const { manager } = managerWithActiveStep([], {
      verification: [{ id: 'v1', kind: 'command', required: true, command, description: 'desktop tests' }],
    })

    expect(manager.planVerificationTarget(command)).toMatchObject({
      step_id: 'step_1',
      command,
      requirement_id: 'v1',
    })
  })

})

describe('Plan risk signals', () => {
  it('recognizes current TypeScript core, IPC, and renderer runtime paths', () => {
    const record = makePlanRecord({
      id: 'plan_ts_paths',
      title: 'TypeScript path risk signals',
      summary: 'Detect current runtime paths.',
      status: PlanStatus.APPROVED,
      createdAt: 0,
      updatedAt: 0,
    })

    expect(independentVerificationRiskSignals(record, [
      'packages/core/src/agent/runner.ts',
      'packages/core/src/api/core-api.ts',
      'desktop/src/main/ipc.ts',
      'desktop/src/renderer/src/runtime/reducer.ts',
    ])).toEqual(expect.arrayContaining(['backend', 'api', 'runtime']))
  })
})

// ── test_plan_execution_state.py::test_todo_store_syncs_from_plan_steps ──

describe('TodoStore.syncFromPlanSteps (test_plan_execution_state.py)', () => {
  it('syncs todos from plan steps', () => {
    const store = new TodoStore()
    const steps = [
      { id: 'step_1', title: 'Edit code', status: 'active' },
      { id: 'step_2', title: 'Run tests', status: 'pending' },
    ]
    const result = store.syncFromPlanSteps(steps)
    expect(result).toContain('todos updated')
    expect(store.todos).toEqual([
      { id: 1, plan_step_id: 'step_1', content: 'Edit code', status: 'in_progress' },
      { id: 2, plan_step_id: 'step_2', content: 'Run tests', status: 'pending' },
    ])
  })
})

describe('Plan completion via todo sync (2026-07-05 B1)', () => {
  function approvedManager(): { manager: ControlManager; todoStore: TodoStore; planId: string } {
    const manager = new ControlManager(tmp('emperor-b1-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    manager.setMode('plan')
    new ProposePlanTool(manager).execute({
      title: 'B1 completion',
      summary: 'Two-step plan for todo-sync completion.',
      plan_markdown: '# Plan',
      steps: [
        { id: 'step_1', title: 'Build it', description: 'write the file', files: ['a.html'], commands: [], acceptance: ['built'] },
        { id: 'step_2', title: 'Verify it', description: 'check output', files: [], commands: [], acceptance: ['checked'] },
      ],
      assumptions: [],
      risk_level: 'low',
    })
    const pending = manager.payload().pending as Record<string, unknown>
    manager.approve(String(pending.id))
    const plan = manager.planStore.latest()
    expect(plan).not.toBeNull()
    return { manager, todoStore, planId: plan!.id }
  }

  it('projects model-style camelCase todo completion into plan steps and completes the plan', () => {
    const { manager, todoStore, planId } = approvedManager()
    // 模型输出 camelCase planStepId；TodoStore.update 负责归一为 plan_step_id
    todoStore.update([
      { id: 1, content: 'Build it', status: 'completed', planStepId: 'step_1' },
      { id: 2, content: 'Verify it', status: 'completed', planStepId: 'step_2' },
    ])
    const updated = manager.syncPlanFromTodos(todoStore.todos, { evidence: { source: 'update_todos', tool_call_id: 'call_1' } })

    expect(updated).not.toBeNull()
    expect(updated!.id).toBe(planId)
    expect(updated!.status).toBe(PlanStatus.COMPLETED)
    expect(updated!.completedAt).not.toBeNull()
    expect(updated!.steps.map((step) => step.status)).toEqual(['done', 'done'])
    expect(updated!.steps[0]!.evidence.at(-1)).toMatchObject({ source: 'update_todos', todo_status: 'completed' })
  })

  it('keeps the plan executing while todos are still in flight', () => {
    const { manager, todoStore } = approvedManager()
    todoStore.update([
      { id: 1, content: 'Build it', status: 'completed', planStepId: 'step_1' },
      { id: 2, content: 'Verify it', status: 'in_progress', planStepId: 'step_2' },
    ])
    const updated = manager.syncPlanFromTodos(todoStore.todos, { evidence: { source: 'update_todos' } })
    expect(updated!.status).toBe(PlanStatus.EXECUTING)
    expect(updated!.steps.map((step) => step.status)).toEqual(['done', 'active'])
  })

  it('supersedes stale executing plans when a new plan is approved', () => {
    const { manager, planId: firstPlanId } = approvedManager()
    manager.setMode('plan')
    new ProposePlanTool(manager).execute({
      title: 'B1 successor',
      summary: 'Second plan should supersede the zombie.',
      plan_markdown: '# Plan 2',
      steps: [{ id: 'step_1', title: 'Redo', description: 'redo', files: [], commands: [], acceptance: ['ok'] }],
      assumptions: [],
      risk_level: 'low',
    })
    const pending = manager.payload().pending as Record<string, unknown>
    manager.approve(String(pending.id))

    const first = manager.planStore.get(firstPlanId)
    expect(first!.status).toBe(PlanStatus.CANCELLED)
    expect(String(first!.metadata.superseded_by || '')).not.toBe('')
    const successor = manager.planStore.latest()
    expect(successor!.status).not.toBe(PlanStatus.CANCELLED)
  })
})
