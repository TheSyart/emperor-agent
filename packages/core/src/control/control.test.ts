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
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ControlManager } from './manager'
import { ControlMode } from './models'
import { PlanDecisionPolicy } from './plan-policy'
import {
  AskUserTool,
  CompletePlanStepTool,
  ProposePlanTool,
  RequestPlanModeTool,
  parsePauseResult,
} from './tools'
import { ReadFileTool, WriteFileTool } from '../tools/filesystem'
import { Tool } from '../tools/base'
import { toolParamsSchema, S } from '../tools/schema'
import { TodoStore, UpdateTodos } from '../tools/builtin'
import { ToolRegistry } from '../tools/registry'
import {
  makePlanRecord,
  makeStep,
  PlanStatus,
  PlanStepStatus,
} from '../plans/models'
import { independentVerificationRiskSignals } from './plan-helpers'
import { requirementsForStep } from '../plans/verification'
import { TaskManager } from '../tasks/manager'
import { GoalContractValidator, newGoalRecord } from '../goals/validation'
import type {
  GoalPlanVerificationFact,
  GoalPlanVerificationSource,
} from '../goals/evidence'
import type { GoalRecord } from '../goals/models'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class SchedulerStub extends Tool {
  override name = 'scheduler'
  override description = 'scheduler stub'
  override parameters = toolParamsSchema({ action: S('action') }, ['action'])
  override readOnly = false
  execute(): string {
    return 'ok'
  }
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
  registry.register(new CompletePlanStepTool(manager))
  registry.register(new RequestPlanModeTool(manager))
  return registry
}

function seedPlanDiscovery(
  manager: ControlManager,
  files: string[] = [],
): string {
  const plan = manager.recordPlanDiscovery({
    source: files.length ? 'read_file' : 'glob',
    summary: files.length
      ? `Inspected ${files.join(', ')}.`
      : 'Inspected the current project scope.',
    files,
    evidenceRefs: files.length
      ? files.map((file) => `path:${file}`)
      : ['scope:.'],
  })
  const discovery = plan?.draft.discoveries.at(-1)
  const id = String(discovery?.id ?? '')
  if (!id) throw new Error('test discovery was not recorded')
  return id
}

function lockedGoal(
  id: string,
  scope: {
    sessionId: string
    mode: 'chat' | 'build'
    projectId: string | null
    workspaceRoot: string
  },
): GoalRecord {
  const draft = newGoalRecord({
    id,
    outcome: 'Execute the approved Plan safely.',
    scope,
    now: '2026-07-15T14:00:00.000Z',
  })
  return GoalContractValidator.lock(
    draft,
    {
      inScope: ['Task 4'],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Plan executes safely.',
          required: true,
          verification: { kind: 'command', requirement: 'npm test' },
        },
      ],
      escalationConditions: [],
    },
    '2026-07-15T14:00:01.000Z',
  )
}

// ── test_control.py (ControlManager-level) ──

describe('ControlManager (test_control.py)', () => {
  it('control store recovers from corrupt state', () => {
    const root = tmp('emperor-ctrl-corrupt-')
    const manager = new ControlManager(root)
    manager.setMode('plan')
    expect(manager.payload().mode).toBe('plan')
    writeFileSync(join(root, 'control', 'state.json'), '{bad', 'utf8')
    expect(new ControlManager(root).payload().mode).toBe(
      ControlMode.ASK_BEFORE_EDIT,
    )
  })

  it('ask_user validation and answer message', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-ask-'))
    const interaction = manager.createAsk({
      questions: [makeQuestion()],
      context: 'need scope',
    })
    expect(interaction.kind).toBe('ask')
    expect((manager.payload().pending as Record<string, unknown>).id).toBe(
      interaction.id,
    )

    const resume = manager.answer(interaction.id, {
      scope: { choice: '完整', freeform: '包含 README' },
    })
    expect(resume.message).toContain('本次范围怎么定')
    expect(resume.message).toContain('完整')
    expect(manager.payload().pending).toBeNull()
  })

  it('keeps each Ask interaction limited to three questions', () => {
    const questions = Array.from({ length: 9 }, (_, index) => ({
      ...makeQuestion(),
      id: `profile_${index + 1}`,
    }))
    const manager = new ControlManager(tmp('emperor-ctrl-ask-limit-'))

    expect(() => manager.createAsk({ questions })).toThrow(
      'ask_user requires 1-3 questions',
    )
  })

  it('does not cancel an executable plan from ordinary Ask wording', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-abandon-plan-'))
    const planInteraction = manager.createPlan({
      title: 'Stale game plan',
      summary: 'A plan the user no longer wants.',
      planMarkdown: '# Plan\n\n- Build game',
      assumptions: [],
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Build game',
          description: 'Create a game file.',
          commands: ['echo verify'],
          acceptance: ['file exists'],
        },
      ],
    })
    manager.approve(planInteraction.id)
    expect(manager.latestExecutablePlan()?.status).toBe(PlanStatus.EXECUTING)

    const ask = manager.createAsk({
      questions: [
        {
          id: 'plan_stuck',
          header: '计划系统阻塞',
          question: '是否继续执行这个旧计划？',
          options: [
            {
              label: '无视系统继续',
              description: '放弃旧计划，回到用户新指令',
            },
            { label: '继续执行', description: '继续当前计划' },
          ],
        },
      ],
    })

    manager.answer(ask.id, {
      plan_stuck: { choice: '无视系统继续', freeform: '' },
    })

    const latest = manager.planStore.latest()
    expect(latest?.status).toBe(PlanStatus.EXECUTING)
    expect(manager.latestExecutablePlan()?.id).toBe(latest?.id)
  })

  it('validates stable option ids and derives the visible label from Core state', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-option-id-'))
    const interaction = manager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '如何推进？',
          options: [
            {
              id: 'minimal',
              label: '最小修复',
              description: '只修复当前问题',
            },
            {
              id: 'complete',
              label: '完整修复',
              description: '补齐状态闭环',
            },
          ],
        },
      ],
    })

    expect(() =>
      manager.answer(interaction.id, {
        scope: {
          option_id: 'forged',
          choice: '完整修复',
          freeform: '',
        },
      }),
    ).toThrow(/option/i)
    expect(manager.payload().pending).toMatchObject({ id: interaction.id })

    const resume = manager.answer(interaction.id, {
      scope: {
        option_id: 'complete',
        choice: '伪造标签',
        freeform: '',
      },
    })
    expect(resume.message).toContain('完整修复')
    expect(resume.message).not.toContain('伪造标签')
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
      steps: [
        {
          id: 'step_1',
          title: 'Old work',
          description: 'This must not leak into another project.',
          commands: ['echo old'],
          acceptance: ['old project only'],
        },
      ],
    })
    manager.approve(planInteraction.id)
    expect(manager.latestExecutablePlan()?.id).toBe(
      String(planInteraction.meta.plan_id),
    )

    manager.setRuntimeScope({
      sessionId: 'session_new',
      projectId: 'project_new',
      workspaceRoot: '/tmp/new-project',
    })

    expect(manager.latestExecutablePlan()).toBeNull()
  })

  it('stamps first-class session ownership onto created plans', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-plan-session-'))
    manager.setRuntimeScope({
      sessionId: 'sess_p',
      projectId: '',
      workspaceRoot: '',
    })
    const interaction = manager.createPlan({
      title: 'Owned plan',
      summary: 'Session-scoped plan.',
      planMarkdown: '# Plan\n\n- work',
      assumptions: [],
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'work',
          description: 'do work',
          commands: ['echo hi'],
          acceptance: ['done'],
        },
      ],
    })
    const planId = String(interaction.meta.plan_id)
    expect(manager.planStore.get(planId)?.sessionId).toBe('sess_p')
  })

  it('keeps foreground Plan scope on the Plan without creating step Tasks', () => {
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
      steps: [
        {
          id: 'step_1',
          title: 'Scoped work',
          description: 'Create a scoped task.',
          commands: ['echo ok'],
          acceptance: ['task metadata includes scope'],
        },
      ],
    })

    manager.approve(planInteraction.id)

    const plan = manager.planStore.latest()
    expect(plan?.metadata.scope).toEqual({
      session_id: 'session_1',
      project_id: 'project_1',
      workspace_root: '/tmp/project_1',
    })
    expect(taskManager.store.list()).toEqual([])
  })

  it('Core injects the active Goal binding and preserves dependency input across revision', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-goal-plan-'))
    const goal = lockedGoal('goal-plan-binding', {
      sessionId: 'session-goal-plan-binding',
      mode: 'build',
      projectId: 'project-goal-plan-binding',
      workspaceRoot: '/workspace/goal-plan-binding',
    })
    manager.setRuntimeScope({
      sessionId: goal.scope.sessionId,
      mode: goal.scope.mode,
      projectId: goal.scope.projectId,
      workspaceRoot: goal.scope.workspaceRoot,
      projectFingerprint: goal.scope.projectFingerprint,
    })
    manager.setActiveGoalPlanContext(goal)
    manager.setMode('plan')
    const first = manager.createPlan({
      title: 'Goal path',
      summary: 'Bind only the Core-owned active Goal.',
      planMarkdown: '# Plan\n\n- A\n- B',
      meta: { goal_id: 'goal-forged-by-caller' },
      steps: [
        {
          id: 'step_a',
          title: 'A',
          files: ['a.ts'],
          acceptance: ['A done'],
        },
        {
          id: 'step_b',
          title: 'B',
          files: ['b.ts'],
          acceptance: ['B done'],
          depends_on: ['step_a'],
        },
      ],
    })
    const firstPlanId = String(first.meta.plan_id)
    expect(manager.planStore.get(firstPlanId)).toMatchObject({
      goalId: goal.id,
      supersedesPlanId: null,
      steps: [
        { id: 'step_a', dependsOn: [] },
        { id: 'step_b', dependsOn: ['step_a'] },
      ],
    })

    manager.comment(first.id, 'Keep the dependency chain.')
    const revised = manager.createPlan({
      title: 'Goal path revised',
      summary: 'Keep the same Goal-bound waiting Plan.',
      planMarkdown: '# Plan\n\n- A\n- B',
      steps: [
        {
          id: 'step_a',
          title: 'A',
          files: ['a.ts'],
          acceptance: ['A done'],
        },
        {
          id: 'step_b',
          title: 'B',
          files: ['b.ts'],
          acceptance: ['B done'],
          depends_on: ['step_a'],
        },
      ],
    })
    expect(revised.meta.plan_id).toBe(firstPlanId)
    expect(manager.planStore.get(firstPlanId)?.goalId).toBe(goal.id)

    manager.setActiveGoalPlanContext(null)
    manager.comment(revised.id, 'Create an ordinary Plan next.')
    const ordinary = manager.createPlan({
      title: 'Ordinary plan',
      summary: 'No Goal binding outside active Goal context.',
      planMarkdown: '# Plan\n\n- Work',
      steps: [
        {
          id: 'step_1',
          title: 'Work',
          files: ['work.ts'],
          acceptance: ['done'],
        },
      ],
    })
    expect(
      manager.planStore.get(String(ordinary.meta.plan_id))?.goalId,
    ).toBeNull()
  })

  it('matches portable Windows workspace paths at the active Goal entrypoint', () => {
    const manager = new ControlManager(tmp('emperor-goal-windows-scope-'))
    const base = lockedGoal('goal_windows_manager', {
      sessionId: 'session-windows-manager',
      mode: 'build',
      projectId: 'project-windows-manager',
      workspaceRoot: '/placeholder',
    })
    const goal = {
      ...base,
      scope: { ...base.scope, workspaceRoot: 'C:/Users/Alice/Emperor' },
    }
    manager.setRuntimeScope({
      ...goal.scope,
      workspaceRoot: 'c:\\users\\alice\\emperor',
    })
    manager.setActiveGoalPlanContext(goal)

    expect(manager.activeGoalPlanContext()?.id).toBe(goal.id)
  })

  it('rejects approval when the pending Goal Plan is not the current approval generation', () => {
    const manager = new ControlManager(
      tmp('emperor-ctrl-goal-plan-generation-'),
    )
    const goal = lockedGoal('goal-plan-generation', {
      sessionId: 'session-goal-plan-generation',
      mode: 'build',
      projectId: 'project-goal-plan-generation',
      workspaceRoot: '/workspace/goal-plan-generation',
    })
    manager.setRuntimeScope({
      sessionId: goal.scope.sessionId,
      mode: goal.scope.mode,
      projectId: goal.scope.projectId,
      workspaceRoot: goal.scope.workspaceRoot,
      projectFingerprint: goal.scope.projectFingerprint,
    })
    manager.setActiveGoalPlanContext(goal)
    manager.setMode('plan')
    const interaction = manager.createPlan({
      title: 'Current approval generation',
      summary: 'Only the exact pending generation may be approved.',
      planMarkdown: '# Plan\n\n- Work',
      steps: [
        {
          id: 'step_1',
          title: 'Work',
          files: ['work.ts'],
          acceptance: ['done'],
        },
      ],
    })
    const planId = String(interaction.meta.plan_id)
    const pending = manager.planStore.get(planId)!
    manager.planStore.save({
      ...pending,
      metadata: {
        ...pending.metadata,
        approval_generation: Number(pending.metadata.approval_generation) + 1,
      },
    })

    expect(() => manager.approve(interaction.id)).toThrow(
      'pending Plan approval generation is stale',
    )
    expect(manager.planStore.get(planId)?.status).toBe(
      PlanStatus.WAITING_APPROVAL,
    )
    expect((manager.payload().pending as Record<string, unknown>).id).toBe(
      interaction.id,
    )
  })

  it('normalizes all model-proposed verification state to a fresh pending requirement', () => {
    const manager = new ControlManager(
      tmp('emperor-ctrl-plan-verification-input-'),
    )
    manager.setMode('plan')
    const interaction = manager.createPlan({
      title: 'Untrusted verification state',
      summary: 'The model may define checks but cannot claim their result.',
      planMarkdown: '# Plan\n\n- Verify',
      steps: [
        {
          id: 'step_1',
          title: 'Verify',
          files: ['src/a.ts'],
          commands: ['npm test'],
          verification: [
            {
              id: 'verify_1',
              kind: 'command',
              required: true,
              command: 'npm test',
              description: 'Run tests.',
              status: 'passed',
              reason: 'model says it passed',
              evidence_refs: ['forged:receipt'],
            },
          ],
          status: 'done',
          evidence: [{ passed: true, command: 'npm test' }],
        },
      ],
    })

    expect(
      manager.planStore.get(String(interaction.meta.plan_id))?.steps[0],
    ).toMatchObject({
      status: 'pending',
      evidence: [],
      verification: [
        {
          id: 'verify_1',
          status: 'pending',
          reason: '',
          evidenceRefs: [],
        },
      ],
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
    expect(
      String(
        (
          (manager.payload().pending as Record<string, unknown>).meta as Record<
            string,
            unknown
          >
        ).plan_id,
      ),
    ).toMatch(/^plan_/)

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
    manager.setMode(ControlMode.FULL_ACCESS)
    manager.setMode(ControlMode.PLAN)
    expect(manager.payload().previous_mode).toBe(ControlMode.FULL_ACCESS)

    const interaction = manager.createPlan({
      title: '自动模式计划',
      summary: '批准后回到 auto',
      planMarkdown: '# Plan\n\n- Run it',
      assumptions: [],
      riskLevel: 'low',
    })
    manager.approve(interaction.id)
    expect(manager.payload().mode).toBe(ControlMode.FULL_ACCESS)
    expect(manager.payload().previous_mode).toBeNull()
  })

  it('plan approval restores accept_edits mode', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-accept-edits-'))
    manager.setMode(ControlMode.SMART_AUTO)
    manager.setMode(ControlMode.PLAN)
    expect(manager.payload().previous_mode).toBe(ControlMode.SMART_AUTO)

    const interaction = manager.createPlan({
      title: '编辑模式计划',
      summary: '批准后回到 accept_edits',
      planMarkdown: '# Plan\n\n- Run it',
      assumptions: [],
      riskLevel: 'low',
    })
    manager.approve(interaction.id)
    expect(manager.payload().mode).toBe(ControlMode.SMART_AUTO)
    expect(manager.payload().previous_mode).toBeNull()
  })

  it('changes the saved execution permission during Plan without leaving Plan', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-plan-permission-'))
    manager.setMode(ControlMode.FULL_ACCESS)
    manager.setMode(ControlMode.PLAN)

    const updated = manager.setPermissionMode(ControlMode.SMART_AUTO)
    expect(updated.mode).toBe(ControlMode.PLAN)
    expect(updated.previous_mode).toBe(ControlMode.SMART_AUTO)

    const interaction = manager.createPlan({
      title: '使用最新权限执行',
      summary: 'Plan 与执行权限独立保存',
      planMarkdown: '# Plan\n\n- Apply approved edits',
      assumptions: [],
      riskLevel: 'low',
    })
    manager.approve(interaction.id)

    expect(manager.payload().mode).toBe(ControlMode.SMART_AUTO)
    expect(manager.payload().previous_mode).toBeNull()
  })

  it('rejects Plan as a permission selection', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-permission-only-'))

    expect(() => manager.setPermissionMode(ControlMode.PLAN)).toThrow(
      'permission mode must be ask_before_edit, smart_auto or full_access',
    )
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
    registry.register(new UpdateTodos(new TodoStore()))
    manager.setMode(ControlMode.PLAN)
    const names = manager.toolDefinitions(registry).map((item) => item.name)
    expect(names).toContain('read_file')
    expect(names).toContain('ask_user')
    expect(names).toContain('propose_plan')
    expect(names).toContain('scheduler')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('update_todos')
    expect(manager.isToolAllowed('write_file', registry)).toBe(false)
  })

  it('renders the active Plan phase and exploration receipts into the control prompt', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-plan-prompt-'))
    manager.setMode(ControlMode.PLAN)
    const discoveryId = seedPlanDiscovery(manager, ['src/index.ts'])

    const prompt = manager.systemPrompt()

    expect(prompt).toContain('phase: exploring')
    expect(prompt).toContain(discoveryId)
    expect(prompt).toContain('src/index.ts')
    expect(prompt).toContain('门禁满足后只能通过 `propose_plan` 进入 PlanCard')
  })

  it('exposes request_plan_mode outside plan mode and hides it inside plan mode', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-rpm-expose-'))
    const registry = makeRegistry(manager)

    const normalNames = manager
      .toolDefinitions(registry)
      .map((item) => item.name)
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

    const raw = await tool.execute(
      { reason: '需要重构鉴权架构' },
      {
        root: '/tmp',
        arguments: {},
        parentCallId: 'call_rpm',
        sessionId: 'session_request_plan_owner',
      },
    )
    const interaction = parsePauseResult(String(raw))
    expect(interaction).not.toBeNull()
    expect(
      (interaction!.meta as Record<string, unknown>).control_session_id,
    ).toBe('session_request_plan_owner')

    const resume = manager.answer(String(interaction!.id), {
      enter_plan_mode: '同意进入计划模式',
    })
    expect(manager.mode).toBe(ControlMode.PLAN)
    expect(resume.resume).toBe(true)
    expect(String(resume.message)).toContain('计划模式')
  })

  it('request_plan_mode leaves the mode unchanged when the user declines', async () => {
    const manager = new ControlManager(tmp('emperor-ctrl-rpm-decline-'))
    const tool = new RequestPlanModeTool(manager)

    const raw = await tool.execute(
      { reason: '大规模改动' },
      { root: '/tmp', arguments: {}, parentCallId: 'call_rpm2' },
    )
    const interaction = parsePauseResult(String(raw))

    manager.answer(String(interaction!.id), { enter_plan_mode: '暂不进入' })
    expect(manager.mode).toBe(ControlMode.ASK_BEFORE_EDIT)
  })

  it('clarification: requires ask for ambiguous high-impact work', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar1-'))
    const assessment = manager.assessClarification([
      {
        role: 'user',
        content: '阅读项目找到问题作出修改，不要打补丁，要工程化实现',
      },
    ])
    expect(assessment.required).toBe(true)
    expect(assessment.questions.length).toBeGreaterThan(0)
  })

  it('clarification: requires ask for project-level prompt workflow', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar2-'))
    const assessment = manager.assessClarification([
      {
        role: 'user',
        content: '从头到尾评估项目，优化 agent 的各种提示词和思考工作流程',
      },
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

  it.each(['删除项目内文件', '全部删除'])(
    'clarification: leaves destructive permission decisions to PermissionManager: %s',
    (content) => {
      const manager = new ControlManager(tmp('emperor-ctrl-clar-delete-'))
      const assessment = manager.assessClarification([
        { role: 'user', content },
      ])

      expect(assessment).toEqual({
        required: false,
        reason: '',
        categories: [],
        questions: [],
      })
    },
  )

  it('clarification: asks only the matched UI question without injecting scope', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar-ui-only-'))
    const assessment = manager.assessClarification([
      { role: 'user', content: '这个前端界面的视觉取舍还没确定' },
    ])

    expect(assessment.required).toBe(true)
    expect(assessment.categories).toEqual(['ui'])
    expect(assessment.questions.map((question) => question.id)).toEqual([
      'ui_priority',
    ])
  })

  it('clarification: skips decision-complete plan', () => {
    const manager = new ControlManager(tmp('emperor-ctrl-clar4-'))
    const assessment = manager.assessClarification([
      {
        role: 'user',
        content:
          '# Summary\n\nPLEASE IMPLEMENT THIS PLAN:\n\n## Key Changes\n- 做 A\n\n## Test Plan\n- pytest',
      },
    ])
    expect(assessment.required).toBe(false)
  })

  it.each(['ask_before_edit', 'smart_auto'] as const)(
    'cancels an obsolete legacy Ask Guard on restart before %s creates a permission Ask',
    async (mode) => {
      const root = tmp(`emperor-ctrl-legacy-ask-guard-${mode}-`)
      const legacy = new ControlManager(root)
      legacy.createAsk({
        questions: [
          {
            id: 'scope',
            header: '范围',
            question: '这次任务的实施边界优先按哪种方式推进？',
            options: [{ label: '完整工程化' }, { label: '最小修复' }],
          },
          {
            id: 'risk_boundary',
            header: '风险',
            question: '涉及删除时应该如何控制风险？',
            options: [{ label: '先确认再执行' }, { label: '按安全默认' }],
          },
        ],
        context: 'Ask Guard: risk',
        meta: { control_session_id: 'deleted_legacy_session' },
      })

      const restarted = new ControlManager(root)
      restarted.setMode(mode)
      expect(restarted.payload().pending).toBeNull()

      const workspace = join(root, 'workspace')
      const batch = await restarted.assessPermissionBatch(
        [
          {
            id: 'delete_1',
            name: 'delete_file',
            arguments: { path: join(workspace, 'one.html') },
          },
        ],
        null,
        {
          sessionId: `session_${mode}`,
          workspaceRoot: workspace,
          cwd: workspace,
        },
      )
      expect(batch.requiresApproval).toBe(true)
      expect(() =>
        restarted.permissionBatchApprovalResult(batch, {
          sessionId: `session_${mode}`,
          workspaceRoot: workspace,
          cwd: workspace,
        }),
      ).not.toThrow()
      expect(restarted.payload().pending?.meta).toMatchObject({
        interaction_type: 'permission',
        control_session_id: `session_${mode}`,
      })
    },
  )
})

// ── test_plan_decision_policy.py ──

describe('PlanDecisionPolicy (test_plan_decision_policy.py)', () => {
  const policy = new PlanDecisionPolicy()

  it('requires plan for high-impact requests', () => {
    const decision = policy.assess(
      '重构认证架构，涉及权限模型、数据库迁移和部署流程，验收标准还不明确',
      {
        mode: ControlMode.ASK_BEFORE_EDIT,
        hasPending: false,
      },
    )
    expect(decision.behavior).toBe('required')
    expect(decision.signals).toContain('architecture')
    expect(decision.signals).toContain('migration')
    expect(decision.signals).toContain('deployment')
    expect(decision.triggers).toEqual(decision.signals)
    expect(decision.recommendedReadonlyScopes.length).toBeGreaterThan(0)
    expect(
      decision.recommendedReadonlyScopes.some(
        (s) => s.includes('auth') || s.includes('认证'),
      ),
    ).toBe(true)
    expect(decision.suggestedQuestions.length).toBeGreaterThan(0)
  })

  it('recommends plan for feature-scale work', () => {
    const decision = policy.assess(
      '给设置页增加暗色模式开关，需要改 UI、状态管理和测试',
      {
        mode: ControlMode.ASK_BEFORE_EDIT,
        hasPending: false,
      },
    )
    expect(decision.behavior).toBe('recommended')
    expect(decision.signals).toContain('feature')
    expect(decision.signals).toContain('multi_step')
    expect(decision.triggers).toEqual(decision.signals)
    expect(decision.recommendedReadonlyScopes.length).toBeGreaterThan(0)
  })

  it.each([
    '全部删除',
    '删除项目内文件',
    'git push origin main',
    '部署当前构建',
  ])(
    'does not turn a concrete side effect into Plan approval: %s',
    (request) => {
      const decision = policy.assess(request, {
        mode: ControlMode.ASK_BEFORE_EDIT,
        hasPending: false,
      })

      expect(decision.behavior).toBe('proceed')
    },
  )

  it('serializes runtime contract', () => {
    const decision = policy.assess(
      'Add a realtime dashboard feature with UI state management and tests',
      {
        mode: ControlMode.ASK_BEFORE_EDIT,
        hasPending: false,
      },
    )
    expect(decision.toRuntimeContract()).toEqual({
      decision: 'recommended',
      reason: 'Multi-step implementation would benefit from a plan.',
      triggers: ['feature', 'multi_step'],
      suggested_questions: [
        'What scope, success criteria, or tradeoffs should be clarified before implementation?',
      ],
      recommended_readonly_scopes: [
        'Search existing implementation patterns and related tests.',
        'Read the most relevant files before proposing edits.',
      ],
    })
  })

  it('proceeds for small or already-planned work', () => {
    expect(
      policy.assess('修复 README 里的一个错别字', {
        mode: ControlMode.ASK_BEFORE_EDIT,
        hasPending: false,
      }).behavior,
    ).toBe('proceed')
    expect(
      policy.assess(
        'PLEASE IMPLEMENT THIS PLAN:\n\n1. 修改 agent/foo.py\n2. 运行 pytest',
        { mode: ControlMode.ASK_BEFORE_EDIT, hasPending: false },
      ).behavior,
    ).toBe('proceed')
  })

  it('proceeds when plan mode or pending interaction exists', () => {
    expect(
      policy.assess('重构权限系统', {
        mode: ControlMode.PLAN,
        hasPending: false,
      }).behavior,
    ).toBe('proceed')
    expect(
      policy.assess('重构权限系统', {
        mode: ControlMode.ASK_BEFORE_EDIT,
        hasPending: true,
      }).behavior,
    ).toBe('proceed')
  })
})

// ── PE-13: test_permission_pipeline_v2.py::test_high_risk_in_approved_plan_still_requires_approval ──

describe('PermissionManager PE-13 (test_permission_pipeline_v2.py)', () => {
  it('high-risk command in approved plan still requires approval; a plan token may approve one ordinary shell command', async () => {
    const manager = new ControlManager(tmp('emperor-pe13-'))
    // 注入一个 token 消费者：始终返回 token（模拟已批准计划）
    manager.permissionManager['controlManager'].consumePlanPermissionToken =
      () => ({
        planId: 'plan_x',
        stepId: 'step_1',
        toolName: 'run_command',
        argumentHash: '',
        expiresAt: 0,
        usesRemaining: 1,
        reason: '',
      })

    const decision = await manager.assessPermission(
      'run_command',
      { command: 'git push origin main' },
      null,
    )
    expect(decision.requiresApproval).toBe(true)

    const low = await manager.assessPermission(
      'run_command',
      { command: 'echo hi from plan' },
      null,
    )
    expect(low.allowed).toBe(true)
    expect(low.rule).toBe('plan.permission_token')
  })

  it('publishes only a safe permission batch view with stable option ids', async () => {
    const root = tmp('emperor-permission-owner-')
    const manager = new ControlManager(root)
    const decision = await manager.assessPermission(
      'run_command',
      { command: 'git push origin main' },
      null,
    )

    manager.permissionApprovalResult(decision, {
      parentCallId: 'call_permission',
      sessionId: 'session_permission_owner',
    })

    const pending = manager.payload().pending as Record<string, unknown>
    const meta = pending.meta as Record<string, unknown>
    expect(meta.control_session_id).toBe('session_permission_owner')
    expect(meta.interaction_type).toBe('permission')
    const permission = meta.permission as Record<string, unknown>
    expect(permission).toMatchObject({
      version: 2,
      operation_count: 1,
      operations: [
        {
          tool_name: 'run_command',
          risk: expect.any(String),
          reason: expect.any(String),
          summary: expect.any(String),
        },
      ],
    })
    expect(String(permission.request_id)).toMatch(/^permission_/)
    expect(permission).not.toHaveProperty('fingerprint')
    expect(permission).not.toHaveProperty('session_id')
    expect(permission).not.toHaveProperty('diagnostics')
    expect(String(pending.context)).not.toContain('Permission Guard')
    expect(String(pending.context)).not.toContain('trace')
    expect(String(pending.context)).not.toContain('arguments')
    expect((pending.questions as unknown[])[0]).toMatchObject({
      options: [
        { id: 'allow_once', label: '允许本次' },
        { id: 'deny', label: '拒绝' },
        {
          id: 'allow_and_full_access',
          label: '允许并切换到完全访问',
        },
      ],
    })
  })

  it('publishes distinct workspace-relative paths for an exact destructive batch', async () => {
    const root = tmp('emperor-permission-path-summary-')
    const manager = new ControlManager(root)
    const calls = [
      'strikeforce.html',
      'A4 Paper Burn.html',
      'terminal.html',
    ].map((path, index) => ({
      id: `call_${index + 1}`,
      name: 'delete_file',
      arguments: { path: join(root, path) },
    }))
    const batch = await manager.assessPermissionBatch(calls, null, {
      sessionId: 'session_permission_path_summary',
      workspaceRoot: root,
      cwd: root,
    })

    manager.permissionBatchApprovalResult(batch, {
      sessionId: 'session_permission_path_summary',
      workspaceRoot: root,
      cwd: root,
    })

    const pending = manager.payload().pending!
    const permission = pending.meta.permission as Record<string, unknown>
    const operations = permission.operations as Array<Record<string, unknown>>
    expect(operations.map((operation) => operation.summary)).toEqual([
      'delete_file strikeforce.html',
      'delete_file A4 Paper Burn.html',
      'delete_file terminal.html',
    ])
    expect(JSON.stringify(permission)).not.toContain(root)
  })

  it('keeps long, multi-path, and bidi-controlled permission targets visibly distinct', async () => {
    const root = tmp('emperor-permission-adversarial-summary-')
    const longPrefix = `nested/${'a'.repeat(260)}`
    const manager = new ControlManager(root)
    const longBatch = await manager.assessPermissionBatch(
      ['-one.txt', '-two.txt'].map((suffix, index) => ({
        id: `long_${index + 1}`,
        name: 'delete_file',
        arguments: { path: join(root, `${longPrefix}${suffix}`) },
      })),
      null,
      {
        sessionId: 'session_permission_long_summary',
        workspaceRoot: root,
        cwd: root,
      },
    )
    manager.permissionBatchApprovalResult(longBatch, {
      sessionId: 'session_permission_long_summary',
      workspaceRoot: root,
      cwd: root,
    })
    const longPermission = manager.payload().pending!.meta.permission as Record<
      string,
      unknown
    >
    const longSummaries = (
      longPermission.operations as Array<Record<string, unknown>>
    ).map((operation) => String(operation.summary))
    expect(new Set(longSummaries).size).toBe(2)
    expect(
      longSummaries.every((summary) => /#[0-9a-f]{10}$/.test(summary)),
    ).toBe(true)
    manager.cancel(manager.payload().pending!.id)

    const renameBatch = await manager.assessPermissionBatch(
      [
        {
          id: 'rename_long_paths',
          name: 'rename_file',
          arguments: {
            source: join(root, `${longPrefix}-source.txt`),
            destination: join(root, `${longPrefix}-destination.txt`),
          },
        },
      ],
      null,
      {
        sessionId: 'session_permission_long_summary',
        workspaceRoot: root,
        cwd: root,
      },
    )
    manager.permissionBatchApprovalResult(renameBatch, {
      sessionId: 'session_permission_long_summary',
      workspaceRoot: root,
      cwd: root,
    })
    const renamePermission = manager.payload().pending!.meta
      .permission as Record<string, unknown>
    const renameSummary = String(
      (renamePermission.operations as Array<Record<string, unknown>>)[0]!
        .summary,
    )
    expect(renameSummary).toContain('source=')
    expect(renameSummary).toContain('destination=')
    expect(renameSummary.match(/#[0-9a-f]{10}/g)).toHaveLength(2)
    manager.cancel(manager.payload().pending!.id)

    const bidiName = `safe\u202Egnp.txt`
    const bidiBatch = await manager.assessPermissionBatch(
      [
        {
          id: 'bidi_path',
          name: 'delete_file',
          arguments: { path: join(root, bidiName) },
        },
      ],
      null,
      {
        sessionId: 'session_permission_long_summary',
        workspaceRoot: root,
        cwd: root,
      },
    )
    manager.permissionBatchApprovalResult(bidiBatch, {
      sessionId: 'session_permission_long_summary',
      workspaceRoot: root,
      cwd: root,
    })
    const bidiPermission = manager.payload().pending!.meta.permission as Record<
      string,
      unknown
    >
    const bidiSummary = String(
      (bidiPermission.operations as Array<Record<string, unknown>>)[0]!.summary,
    )
    expect(bidiSummary).not.toContain('\u202E')
    expect(bidiSummary).toMatch(/#[0-9a-f]{10}$/)
    manager.cancel(manager.payload().pending!.id)

    const edgeBatch = await manager.assessPermissionBatch(
      ['edge.txt', 'edge.txt ', '\tedge.txt', 'edge.txt\u2028'].map(
        (path, index) => ({
          id: `edge_${index + 1}`,
          name: 'delete_file',
          arguments: { path: join(root, path) },
        }),
      ),
      null,
      {
        sessionId: 'session_permission_long_summary',
        workspaceRoot: root,
        cwd: root,
      },
    )
    manager.permissionBatchApprovalResult(edgeBatch, {
      sessionId: 'session_permission_long_summary',
      workspaceRoot: root,
      cwd: root,
    })
    const edgePermission = manager.payload().pending!.meta.permission as Record<
      string,
      unknown
    >
    const edgeSummaries = (
      edgePermission.operations as Array<Record<string, unknown>>
    ).map((operation) => String(operation.summary))
    expect(new Set(edgeSummaries).size).toBe(4)
    expect(
      edgeSummaries.slice(1).every((summary) => /#[0-9a-f]{10}$/.test(summary)),
    ).toBe(true)
    expect(edgeSummaries.join('\n')).not.toMatch(/[\t\u2028]/u)
    manager.cancel(manager.payload().pending!.id)

    const externalBatch = await manager.assessPermissionBatch(
      ['/private/one/shared.txt', '/private/two/shared.txt'].map(
        (path, index) => ({
          id: `external_${index + 1}`,
          name: 'delete_file',
          arguments: { path },
        }),
      ),
      null,
      { sessionId: 'session_permission_external_summary' },
    )
    manager.permissionBatchApprovalResult(externalBatch, {
      sessionId: 'session_permission_external_summary',
    })
    const externalPermission = manager.payload().pending!.meta
      .permission as Record<string, unknown>
    const externalSummaries = (
      externalPermission.operations as Array<Record<string, unknown>>
    ).map((operation) => String(operation.summary))
    expect(new Set(externalSummaries).size).toBe(2)
    expect(
      externalSummaries.every((summary) =>
        /^delete_file \[external\]\/shared\.txt #[0-9a-f]{10}$/.test(summary),
      ),
    ).toBe(true)
    expect(externalSummaries.join('\n')).not.toContain('/private/')
  })

  it('approves the current operation and switches to full access from the permission Ask', async () => {
    const manager = new ControlManager(tmp('emperor-permission-full-access-'))
    const args = { command: 'git push origin main' }
    const decision = await manager.assessPermission('run_command', args, null)
    manager.permissionApprovalResult(decision, {
      parentCallId: 'call_permission_full_access',
      sessionId: 'session_permission_full_access',
    })
    const pending = manager.payload().pending!

    const resume = manager.answer(pending.id, {
      permission: {
        option_id: 'allow_and_full_access',
        choice: '允许并切换到完全访问',
      },
    })

    expect(manager.payload().mode).toBe('full_access')
    expect(resume.message).toContain('[CONTROL:PERMISSION_ANSWERED]')
    expect(resume.message).toContain('authorization_id: permission_')
    await expect(
      manager.assessPermission('run_command', args, null, {
        sessionId: 'session_permission_full_access',
        authorizationId: String(
          (pending.meta.permission as Record<string, unknown>).request_id,
        ),
      }),
    ).resolves.toMatchObject({
      allowed: true,
      requiresApproval: false,
      rule: 'mode.full_access',
    })
  })

  it('fails closed for forged or negated permission choices', async () => {
    for (const choice of ['不允许', '不要完全访问', 'do not allow', 'allow']) {
      const manager = new ControlManager(tmp('emperor-permission-forged-'))
      const args = { command: 'git push origin main' }
      const decision = await manager.assessPermission('run_command', args, null)
      manager.permissionApprovalResult(decision, {
        sessionId: 'session_forged',
      })
      const pending = manager.payload().pending!
      const requestId = String(
        (pending.meta.permission as Record<string, unknown>).request_id,
      )
      manager.answer(pending.id, {
        permission: { option_id: choice, choice },
      })

      await expect(
        manager.assessPermission('run_command', args, null, {
          sessionId: 'session_forged',
          authorizationId: requestId,
        }),
      ).resolves.toMatchObject({
        allowed: false,
        requiresApproval: false,
        rule: 'user.denied_once',
      })
      expect(manager.payload().mode).toBe('ask_before_edit')
    }
  })

  it('binds an allow-once grant to the originating session', async () => {
    const manager = new ControlManager(tmp('emperor-permission-session-grant-'))
    const args = { command: 'git push origin main' }
    const decision = await manager.assessPermission('run_command', args, null)
    manager.permissionApprovalResult(decision, { sessionId: 'session_a' })
    const pending = manager.payload().pending!
    const requestId = String(
      (pending.meta.permission as Record<string, unknown>).request_id,
    )
    manager.answer(pending.id, {
      permission: { option_id: 'allow_once', choice: '允许本次' },
    })

    await expect(
      manager.assessPermission('run_command', args, null, {
        sessionId: 'session_b',
        authorizationId: requestId,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      requiresApproval: true,
    })
    await expect(
      manager.assessPermission('run_command', args, null, {
        sessionId: 'session_a',
        authorizationId: requestId,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      requiresApproval: false,
      rule: 'user.approved_once',
    })
  })

  it('approves an exact permission batch once and rejects an expanded batch', async () => {
    const root = tmp('emperor-permission-batch-')
    const manager = new ControlManager(root)
    const calls = ['a.txt', 'b.txt', 'c.txt'].map((path, index) => ({
      id: `call_${index + 1}`,
      name: 'delete_file',
      arguments: { path },
    }))
    const batch = await manager.assessPermissionBatch(calls, null, {
      sessionId: 'session_batch',
      workspaceRoot: root,
      cwd: root,
    })
    expect(batch.requiresApproval).toBe(true)

    manager.permissionBatchApprovalResult(batch, {
      sessionId: 'session_batch',
    })
    const pending = manager.payload().pending!
    const requestId = String(
      (pending.meta.permission as Record<string, unknown>).request_id,
    )
    expect(
      (pending.meta.permission as Record<string, unknown>).operation_count,
    ).toBe(3)
    manager.answer(pending.id, {
      permission: { option_id: 'allow_once', choice: '允许本次' },
    })

    const restarted = new ControlManager(root)
    await expect(
      restarted.assessPermissionBatch(calls, null, {
        sessionId: 'session_batch',
        workspaceRoot: root,
        cwd: root,
        authorizationId: requestId,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      requiresApproval: false,
      authorizationId: requestId,
    })

    await expect(
      restarted.assessPermissionBatch(
        [
          ...calls,
          { id: 'call_4', name: 'delete_file', arguments: { path: 'd.txt' } },
        ],
        null,
        {
          sessionId: 'session_batch',
          workspaceRoot: root,
          cwd: root,
          authorizationId: requestId,
        },
      ),
    ).resolves.toMatchObject({ allowed: false, requiresApproval: true })
  })

  it('rejects expanded, reordered, or changed batches before an approved grant is consumed', async () => {
    const root = tmp('emperor-permission-unconsumed-batch-')
    const manager = new ControlManager(root)
    const calls = ['a.txt', 'b.txt', 'c.txt'].map((path, index) => ({
      id: `call_${index + 1}`,
      name: 'delete_file',
      arguments: { path },
    }))
    const batch = await manager.assessPermissionBatch(calls, null, {
      sessionId: 'session_unconsumed_batch',
      workspaceRoot: root,
      cwd: root,
    })
    manager.permissionBatchApprovalResult(batch, {
      sessionId: 'session_unconsumed_batch',
    })
    const pending = manager.payload().pending!
    const requestId = String(
      (pending.meta.permission as Record<string, unknown>).request_id,
    )
    manager.answer(pending.id, {
      permission: { option_id: 'allow_once', choice: '允许本次' },
    })

    const assess = (candidate: typeof calls) =>
      manager.assessPermissionBatch(candidate, null, {
        sessionId: 'session_unconsumed_batch',
        workspaceRoot: root,
        cwd: root,
        authorizationId: requestId,
      })
    await expect(
      assess([
        ...calls,
        { id: 'call_4', name: 'delete_file', arguments: { path: 'd.txt' } },
      ]),
    ).resolves.toMatchObject({ allowed: false, requiresApproval: true })
    await expect(
      assess([calls[1]!, calls[0]!, calls[2]!]),
    ).resolves.toMatchObject({ allowed: false, requiresApproval: true })
    await expect(
      assess([
        calls[0]!,
        calls[1]!,
        { ...calls[2]!, arguments: { path: 'changed.txt' } },
      ]),
    ).resolves.toMatchObject({ allowed: false, requiresApproval: true })
    await expect(assess(calls)).resolves.toMatchObject({
      allowed: true,
      requiresApproval: false,
      authorizationId: requestId,
    })
  })

  it('never lets an approved request override a later explicit deny rule', async () => {
    const root = tmp('emperor-permission-deny-precedence-')
    const args = { command: 'git push origin main' }
    const manager = new ControlManager(root)
    const decision = await manager.assessPermission('run_command', args, null, {
      sessionId: 'session_deny_precedence',
    })
    manager.permissionApprovalResult(decision, {
      sessionId: 'session_deny_precedence',
    })
    const pending = manager.payload().pending!
    const requestId = String(
      (pending.meta.permission as Record<string, unknown>).request_id,
    )
    manager.answer(pending.id, {
      permission: { option_id: 'allow_once', choice: '允许本次' },
    })

    const tightened = new ControlManager(root, {
      permissionRules: [
        {
          id: 'deny-push-after-approval',
          action: 'deny',
          tool: 'run_command',
          commandPrefix: 'git push',
          reason: 'push is managed-denied',
        },
      ],
    })
    await expect(
      tightened.assessPermission('run_command', args, null, {
        sessionId: 'session_deny_precedence',
        authorizationId: requestId,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      requiresApproval: false,
      rule: 'user_rule.deny-push-after-approval',
    })
  })

  it('fails closed when a model boundary exceeds the permission batch limit', async () => {
    const manager = new ControlManager(tmp('emperor-permission-batch-limit-'))
    const calls = Array.from({ length: 65 }, (_, index) => ({
      id: `call_${index + 1}`,
      name: 'delete_file',
      arguments: { path: `${index + 1}.txt` },
    }))

    await expect(
      manager.assessPermissionBatch(calls, null, {
        sessionId: 'session_batch_limit',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      requiresApproval: false,
      rule: 'permission.batch_limit',
    })
    expect(manager.payload().pending).toBeNull()
  })

  it('cancels an unrecoverable pending permission after private store corruption', async () => {
    const root = tmp('emperor-permission-corrupt-recovery-')
    const manager = new ControlManager(root)
    const decision = await manager.assessPermission(
      'run_command',
      { command: 'git push origin main' },
      null,
      { sessionId: 'session_corrupt_permission' },
    )
    manager.permissionApprovalResult(decision, {
      sessionId: 'session_corrupt_permission',
    })
    expect(manager.payload().pending).not.toBeNull()
    writeFileSync(
      join(root, 'control', 'permission-requests.json'),
      '{broken',
      'utf8',
    )

    const restarted = new ControlManager(root)
    expect(restarted.payload().pending).toBeNull()
    expect(restarted.payload().last_interaction).toMatchObject({
      kind: 'ask',
      status: 'cancelled',
      meta: { interaction_type: 'permission' },
    })
  })
})

// ── test_plan_quality_gate.py (ProposePlanTool integration) ──

describe('ProposePlanTool quality gate (test_plan_quality_gate.py)', () => {
  it('requires structured steps in the provider schema', () => {
    const manager = new ControlManager(tmp('emperor-propose-schema-'))
    const tool = new ProposePlanTool(manager)

    expect(tool.parameters.required).toContain('steps')
  })

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
        {
          id: 'step_2',
          title: 'improve code',
          description: 'Change implementation',
          risk: 'medium',
        },
      ],
      assumptions: [],
      risk_level: 'medium',
    }) as string
    expect(result.startsWith('Error: plan quality gate failed')).toBe(true)
    expect(result).toContain(
      'step_1 has no target files, discovery reference, or concrete scope',
    )
    expect(result).toContain('step_1 title is too generic')
    expect(result).toContain(
      'step_2 has no verification command or manual verification rule',
    )
    expect(manager.payload().pending).toBeNull()
    expect(
      manager.planStore
        .list()
        .every((p) => p.status !== PlanStatus.WAITING_APPROVAL),
    ).toBe(true)
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
          commands: [
            '.venv/bin/python -m pytest tests/unit/test_auth_storage.py -q',
          ],
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
    const discoveryId = seedPlanDiscovery(manager, [
      'tests/unit/test_plan_quality_gate.py',
      'agent/control/tools.py',
      'agent/plans/quality.py',
    ])
    const result = new ProposePlanTool(manager).execute(
      {
        title: 'Plan quality gate',
        summary: 'Reject weak plans before approval',
        plan_markdown:
          '# Plan\n\n- Add gate tests\n- Implement gate\n\n## 验证\n- Run focused pytest',
        steps: [
          {
            id: 'step_1',
            title: 'Add plan quality gate tests',
            description: 'Cover weak plans and accepted concrete plans.',
            files: ['tests/unit/test_plan_quality_gate.py'],
            discovery_refs: [discoveryId],
            commands: [
              '.venv/bin/python -m pytest tests/unit/test_plan_quality_gate.py -q',
            ],
            acceptance: ['weak plans return a repairable tool error'],
            risk: 'low',
          },
          {
            id: 'step_2',
            title: 'Enforce plan quality before PlanCard creation',
            description:
              'Wire the gate through ProposePlanTool without changing approved execution state.',
            files: ['agent/control/tools.py', 'agent/plans/quality.py'],
            discovery_refs: [discoveryId],
            commands: [
              '.venv/bin/python -m pytest tests/unit/test_plan_runtime.py -q',
            ],
            acceptance: ['accepted plans still create a pending PlanCard'],
            risk: 'high',
            risk_note:
              'The gate can over-block model-generated plans if rules are too strict.',
            rollback:
              'Disable enforce_quality on ProposePlanTool while keeping low-level create_plan available.',
          },
        ],
        assumptions: [
          'internal create_plan helper remains available for tests',
        ],
        risk_level: 'high',
      },
      {
        root: '/tmp',
        arguments: {},
        sessionId: 'session_proposed_plan_owner',
      },
    ) as string
    const interaction = parsePauseResult(result)
    expect(interaction).not.toBeNull()
    expect(
      (interaction!.meta as Record<string, unknown>).control_session_id,
    ).toBe('session_proposed_plan_owner')
    expect((manager.payload().pending as Record<string, unknown>).id).toBe(
      interaction!.id,
    )
    const saved = manager.planStore.get(
      String((interaction!.meta as Record<string, unknown>).plan_id),
    )
    expect(saved).not.toBeNull()
    expect(saved!.status).toBe(PlanStatus.WAITING_APPROVAL)
    expect(saved!.metadata.plan_review_receipt).toMatchObject({
      version: 1,
      discovery_ids: [discoveryId],
      unresolved_questions: 0,
    })
    expect(
      saved!.steps[1]!.riskNote.startsWith('The gate can over-block'),
    ).toBe(true)
    expect(
      saved!.steps[1]!.rollback.startsWith('Disable enforce_quality'),
    ).toBe(true)
  })
})

// ── Claude Code-style TodoWrite/TaskUpdate semantics: todo progress is not a plan evidence gate ──

describe('Plan verification matrix integration (test_plan_verification_matrix.py)', () => {
  function managerWithActiveStep(
    commands: string[],
    extraStep: Record<string, unknown> = {},
  ): { manager: ControlManager; planId: string } {
    const manager = new ControlManager(tmp('emperor-vmatrix-'))
    manager.setRuntimeScope({
      sessionId: 'session-goal-plan',
      projectId: 'project-goal-plan',
      workspaceRoot: '/workspace/goal-plan',
    })
    manager.setTodoStore(new TodoStore())
    manager.setMode('plan')
    const discoveryId = seedPlanDiscovery(manager, ['agent/runner.py'])
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
          discovery_refs: [discoveryId],
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
    const command =
      '.venv/bin/python -m pytest tests/unit/test_runner_state.py -q'
    const { manager, planId } = managerWithActiveStep([command])

    const updated = manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command, passed: false, summary: 'test failed' },
    })

    expect(updated!.steps[0]!.status).toBe('active')
    expect(updated!.steps[0]!.evidence.at(-1)).toMatchObject({
      command,
      passed: false,
    })
  })

  it('appends late verification evidence to the current completed Plan without reopening it', () => {
    const command = 'npm test'
    const { manager, planId } = managerWithActiveStep([command])
    const active = manager.planStore.get(planId)!
    const completedAt = active.updatedAt + 1
    manager.planStore.save({
      ...active,
      status: PlanStatus.COMPLETED,
      completedAt,
      updatedAt: completedAt,
    })

    const updated = manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: {
        command,
        passed: true,
        exit_code: 0,
        summary: 'late test result',
      },
    })

    expect(updated).toMatchObject({
      id: planId,
      status: PlanStatus.COMPLETED,
      completedAt,
    })
    expect(updated!.steps[0]!.evidence.at(-1)).toMatchObject({
      summary: 'late test result',
    })
  })

  it.each([
    ['cancelled lifecycle', PlanStatus.CANCELLED, {}],
    ['superseded metadata', PlanStatus.EXECUTING, { superseded_by: 'plan-b' }],
    ['cancelled metadata', PlanStatus.EXECUTING, { cancelled_by: 'user' }],
    ['rejected metadata', PlanStatus.EXECUTING, { rejected_by: 'reviewer' }],
    ['deleted metadata', PlanStatus.EXECUTING, { deleted_at: 123 }],
  ] as const)(
    'does not mutate verification evidence for an invalidated source Plan: %s',
    (_label, status, invalidation) => {
      const { manager, planId } = managerWithActiveStep(['npm test'])
      const current = manager.planStore.get(planId)!
      const invalid = manager.planStore.save({
        ...current,
        status,
        metadata: { ...current.metadata, ...invalidation },
      })

      expect(
        manager.recordPlanVerificationResult({
          planId,
          stepId: 'step_1',
          result: { command: 'npm test', passed: true, exit_code: 0 },
        }),
      ).toBeNull()
      expect(manager.planStore.get(planId)).toEqual(invalid)
    },
  )

  it('matches explicit verification commands as evidence targets', () => {
    const command = 'npm --prefix desktop run test'
    const { manager } = managerWithActiveStep([], {
      verification: [
        {
          id: 'v1',
          kind: 'command',
          required: true,
          command,
          description: 'desktop tests',
        },
      ],
    })

    expect(manager.planVerificationTarget(command)).toMatchObject({
      step_id: 'step_1',
      command,
      requirement_id: 'v1',
    })
    expect(
      manager.planVerificationTarget('npm   --prefix desktop run test'),
    ).toBeNull()
  })

  it('does not fold whitespace inside quoted Plan command arguments', () => {
    const command = 'npm test -- --grep "a  b"'
    const { manager } = managerWithActiveStep([], {
      verification: [
        {
          id: 'v-quoted',
          kind: 'command',
          required: true,
          command,
          description: 'quoted filter',
        },
      ],
    })

    expect(manager.planVerificationTarget(command)).not.toBeNull()
    expect(
      manager.planVerificationTarget('npm test -- --grep "a b"'),
    ).toBeNull()
  })

  it('resolves Goal Plan facts only for the current execution-trusted Plan in the same Goal scope', () => {
    const command = 'npm test'
    const { manager, planId } = managerWithActiveStep([command])
    const target = manager.planVerificationTarget(command)!
    manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: {
        requirement_id: target.requirement_id,
        tool_call_id: 'call-goal-plan',
        command,
        passed: true,
        exit_code: 0,
        summary: 'tests passed',
      },
    })
    const source: GoalPlanVerificationSource = {
      planId,
      stepId: 'step_1',
      requirementId: target.requirement_id!,
      toolCallId: 'call-goal-plan',
      sourceObservationId: 'obs-goal-plan',
      approvedInputHash: target.approved_input_hash!,
    }
    const goal = planGoal('goal-current-plan')
    const resolve = manager.resolveGoalPlanVerificationFact.bind(manager) as (
      goalId: string,
      goal: GoalRecord,
      source: GoalPlanVerificationSource,
    ) => GoalPlanVerificationFact | null

    // A legacy Plan with only a similar scope is not Goal provenance.
    expect(resolve(goal.id, goal, source)).toBeNull()
    const legacy = manager.planStore.get(planId)!
    const boundGoal = {
      ...goal,
      runtime: { ...goal.runtime, currentPlanId: planId },
    }
    manager.planStore.save({
      ...legacy,
      goalId: goal.id,
      metadata: {
        ...legacy.metadata,
        scope: {
          ...(legacy.metadata.scope as Record<string, unknown>),
          mode: goal.scope.mode,
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })

    expect(resolve(goal.id, boundGoal, source)).toMatchObject({
      goalId: goal.id,
      planId,
      passed: true,
    })
    const current = manager.planStore.get(planId)!
    const completed = manager.planStore.save({
      ...current,
      status: PlanStatus.COMPLETED,
      completedAt: current.updatedAt,
    })
    expect(resolve(goal.id, boundGoal, source)).toMatchObject({
      goalId: goal.id,
      planId,
      passed: true,
    })
    expect(
      resolve(
        goal.id,
        {
          ...boundGoal,
          createdAt: new Date((completed.approvedAt! + 1) * 1000).toISOString(),
        },
        source,
      ),
    ).toBeNull()
    expect(
      resolve(
        goal.id,
        {
          ...boundGoal,
          scope: { ...goal.scope, sessionId: 'different-session' },
        },
        source,
      ),
    ).toBeNull()
    expect(
      resolve(
        goal.id,
        {
          ...boundGoal,
          runtime: { ...goal.runtime, currentPlanId: 'different-plan' },
        },
        source,
      ),
    ).toBeNull()
  })

  it('invalidates a Goal Plan fact after cancellation or replacement and never revives deleted history', () => {
    const command = 'npm test'
    const { manager, planId } = managerWithActiveStep([command])
    const target = manager.planVerificationTarget(command)!
    manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: {
        requirement_id: target.requirement_id,
        tool_call_id: 'call-stale-plan',
        command,
        passed: true,
        exit_code: 0,
        summary: 'tests passed',
      },
    })
    const source: GoalPlanVerificationSource = {
      planId,
      stepId: 'step_1',
      requirementId: target.requirement_id!,
      toolCallId: 'call-stale-plan',
      sourceObservationId: 'obs-stale-plan',
      approvedInputHash: target.approved_input_hash!,
    }
    const goal = planGoal('goal-stale-plan')
    const resolve = manager.resolveGoalPlanVerificationFact.bind(manager) as (
      goalId: string,
      goal: GoalRecord,
      source: GoalPlanVerificationSource,
    ) => GoalPlanVerificationFact | null

    expect(resolve(goal.id, goal, source)).toBeNull()
    const legacy = manager.planStore.get(planId)!
    const boundGoal = {
      ...goal,
      runtime: { ...goal.runtime, currentPlanId: planId },
    }
    manager.planStore.save({
      ...legacy,
      goalId: goal.id,
      metadata: {
        ...legacy.metadata,
        scope: {
          ...(legacy.metadata.scope as Record<string, unknown>),
          mode: goal.scope.mode,
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })

    expect(resolve(goal.id, boundGoal, source)).not.toBeNull()
    expect(resolve('different-goal', boundGoal, source)).toBeNull()

    const record = manager.planStore.get(planId)!
    manager.planStore.save(
      makePlanRecord({
        id: 'plan-successor',
        title: 'Successor',
        summary: 'New current Plan for the same Goal scope.',
        status: PlanStatus.APPROVED,
        createdAt: record.createdAt + 1,
        updatedAt: record.updatedAt + 1,
        approvedAt: record.approvedAt! + 1,
        sessionId: record.sessionId,
        goalId: goal.id,
        metadata: { ...record.metadata },
      }),
    )
    expect(resolve(goal.id, boundGoal, source)).toBeNull()

    manager.planStore.save({
      ...record,
      status: PlanStatus.CANCELLED,
      updatedAt: record.updatedAt + 2,
      metadata: { ...record.metadata, superseded_by: 'plan-successor' },
    })
    expect(resolve(goal.id, boundGoal, source)).toBeNull()

    manager.planStore.deleteBySession('session-goal-plan')
    expect(manager.planStore.get(planId)).toBeNull()
    expect(resolve(goal.id, boundGoal, source)).toBeNull()
  })

  it('selects current Plan by immutable approval generation instead of mutable updatedAt', () => {
    const { manager, planId } = managerWithActiveStep(['npm test'])
    const older = manager.planStore.get(planId)!
    const newer = makePlanRecord({
      id: 'plan-newer-generation',
      title: 'Newer generation',
      summary: 'Approved after the old completed Plan.',
      status: PlanStatus.EXECUTING,
      createdAt: older.createdAt + 10,
      updatedAt: older.updatedAt + 10,
      approvedAt: older.approvedAt! + 10,
      sessionId: older.sessionId,
      metadata: { ...older.metadata, permission_tokens: [] },
    })
    manager.planStore.save({
      ...older,
      status: PlanStatus.COMPLETED,
      completedAt: older.updatedAt + 100,
      updatedAt: older.updatedAt + 100,
    })
    manager.planStore.save(newer)

    expect(manager.latestReviewablePlan()?.id).toBe(newer.id)
    expect(manager.latestExecutablePlan()?.id).toBe(newer.id)
  })

  it('does not fall back to an older Plan or consume its token when the latest approval generation is invalid', () => {
    const { manager, planId } = managerWithActiveStep(['npm test'])
    const older = manager.planStore.get(planId)!
    const originalTokens = older.metadata.permission_tokens
    manager.planStore.save(
      makePlanRecord({
        id: 'plan-cancelled-successor',
        title: 'Cancelled successor',
        summary: 'Latest generation is invalid.',
        status: PlanStatus.CANCELLED,
        createdAt: older.createdAt + 10,
        updatedAt: older.updatedAt + 10,
        approvedAt: older.approvedAt! + 10,
        sessionId: older.sessionId,
        metadata: {
          ...older.metadata,
          permission_tokens: [],
          cancelled_by: 'user',
        },
      }),
    )

    expect(
      manager.consumePlanPermissionToken({
        toolName: 'run_command',
        arguments: { command: 'npm test' },
      }),
    ).toBeNull()
    expect(manager.planStore.get(planId)!.metadata.permission_tokens).toEqual(
      originalTokens,
    )
    expect(manager.latestExecutablePlan()).toBeNull()
    expect(manager.latestReviewablePlan()).toBeNull()
  })

  function planGoal(id: string): GoalRecord {
    return GoalContractValidator.lock(
      newGoalRecord({
        id,
        outcome: 'Verify the current scoped Plan',
        scope: {
          sessionId: 'session-goal-plan',
          mode: 'build',
          projectId: 'project-goal-plan',
          workspaceRoot: '/workspace/goal-plan',
        },
        now: '2025-01-01T00:00:00.000Z',
      }),
      {
        inScope: ['core'],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Tests pass',
            required: true,
            verification: { kind: 'command', requirement: 'npm test' },
          },
        ],
        escalationConditions: [],
      },
      '2025-01-01T00:00:01.000Z',
    )
  }
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

    expect(
      independentVerificationRiskSignals(record, [
        'packages/core/src/agent/runner.ts',
        'packages/core/src/api/core-api.ts',
        'desktop/src/main/ipc.ts',
        'desktop/src/renderer/src/runtime/reducer.ts',
      ]),
    ).toEqual(expect.arrayContaining(['backend', 'api', 'runtime']))
  })
})

describe('independent Plan verification terminal flow', () => {
  function completedReviewablePlan(): {
    manager: ControlManager
    planId: string
  } {
    const manager = new ControlManager(tmp('emperor-independent-review-'))
    manager.setRuntimeScope({
      sessionId: 'session-independent-review',
      mode: 'build',
      projectId: 'project-independent-review',
      workspaceRoot: '/workspace/independent-review',
      projectFingerprint: 'fingerprint-independent-review',
    })
    const plan = manager.planStore.save(
      makePlanRecord({
        id: 'plan_independent_review',
        title: 'Independent review',
        summary: 'The implementation is complete and needs one review.',
        status: PlanStatus.COMPLETED,
        createdAt: 1,
        updatedAt: 2,
        approvedAt: 1,
        sessionId: 'session-independent-review',
        steps: [
          makeStep({
            id: 'step_1',
            title: 'Implement',
            status: PlanStepStatus.DONE,
            files: [
              'index.html',
              'packages/core/src/agent/runner.ts',
              'desktop/src/main/ipc.ts',
            ],
            evidence: [
              {
                source: 'edit_file',
                tool_call_id: 'call_edit',
                path: 'index.html',
              },
            ],
          }),
        ],
        metadata: {
          approval_generation: 1,
          scope: {
            session_id: 'session-independent-review',
            mode: 'build',
            project_id: 'project-independent-review',
            workspace_root: '/workspace/independent-review',
            project_fingerprint: 'fingerprint-independent-review',
          },
        },
      }),
    )
    expect(
      manager.planIndependentVerificationFollowup({
        dispatchAvailable: true,
      }),
    ).toMatchObject({ status: 'required', plan_id: plan.id })
    return { manager, planId: plan.id }
  }

  it('automatically records one trusted reviewer PASS and ends the followup', () => {
    const { manager, planId } = completedReviewablePlan()
    const output = [
      '复核完成。',
      '```verdict',
      JSON.stringify({
        passed: true,
        summary: 'HTML structure and declared checks passed.',
        commands: ["grep -c '</html>' index.html"],
        command_evidence: [
          {
            command: "grep -c '</html>' index.html",
            exit_code: 0,
          },
        ],
      }),
      '```',
    ].join('\n')

    const saved = manager.recordIndependentVerificationToolResult({
      toolCallId: 'call_reviewer_once',
      agentType: 'verification_reviewer',
      output,
    })
    const duplicate = manager.recordIndependentVerificationToolResult({
      toolCallId: 'call_reviewer_once',
      agentType: 'verification_reviewer',
      output,
    })

    expect(saved).toMatchObject({ id: planId })
    expect(duplicate).toMatchObject({ id: planId })
    const record = manager.planStore.get(planId)!
    expect(
      record.verification.filter(
        (item) => item.source === 'independent_verification',
      ),
    ).toEqual([
      expect.objectContaining({
        passed: true,
        issued_by: 'core',
        tool_call_id: 'call_reviewer_once',
        receipt_id: expect.stringMatching(/^independent_review_/),
        commands: ["grep -c '</html>' index.html"],
      }),
    ])
    expect(
      manager.planIndependentVerificationFollowup({
        dispatchAvailable: true,
      }),
    ).toBeNull()
  })

  it('does not trust an ordinary subagent result as independent verification', () => {
    const { manager, planId } = completedReviewablePlan()

    expect(
      manager.recordIndependentVerificationToolResult({
        toolCallId: 'call_wrong_agent',
        agentType: 'code_reviewer',
        output:
          '```verdict\n{"passed":true,"commands":["npm test"],"command_evidence":[{"command":"npm test","exit_code":0}]}\n```',
      }),
    ).toBeNull()
    expect(manager.planStore.get(planId)!.verification).toHaveLength(0)
  })
})

describe('Plan execution authority and legacy WorkItem migration', () => {
  it('keeps a one-step Plan authoritative without creating a redundant Todo', () => {
    const manager = new ControlManager(tmp('emperor-plan-no-single-todo-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    manager.setMode(ControlMode.PLAN)
    const interaction = manager.createPlan({
      title: 'Create one page',
      summary: 'Create a single self-contained HTML page.',
      planMarkdown: '# Plan\n\n1. Create the page',
      steps: [
        {
          id: 'step_1',
          title: 'Create index.html',
          description: 'Create the requested page.',
          files: ['index.html'],
          commands: [],
          acceptance: ['the requested page is created'],
        },
      ],
    })

    manager.approve(interaction.id)

    expect(todoStore.todos).toEqual([])
    const active = manager.latestExecutablePlan()
    expect(active?.steps[0]?.status).toBe(PlanStepStatus.ACTIVE)

    const completed = (
      manager as unknown as {
        completePlanStep(input: {
          stepId: string
          summary: string
          toolCallId: string
        }): ReturnType<ControlManager['latestExecutablePlan']>
      }
    ).completePlanStep({
      stepId: 'step_1',
      summary: 'Created index.html and satisfied the implementation scope.',
      toolCallId: 'call_complete_step',
    })

    expect(completed?.status).toBe(PlanStatus.COMPLETED)
    expect(completed?.steps[0]?.status).toBe(PlanStepStatus.DONE)
    expect(completed?.metadata.implementation_claims).toMatchObject({
      step_1: expect.objectContaining({
        source: 'plan_step_completion',
        tool_call_id: 'call_complete_step',
      }),
    })
  })

  it('does not manufacture Todos for two short Plan steps', () => {
    const manager = new ControlManager(tmp('emperor-plan-no-two-todos-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    manager.setMode(ControlMode.PLAN)
    const interaction = manager.createPlan({
      title: 'Small two-step fix',
      summary: 'Edit one file and run its focused check.',
      planMarkdown: '# Plan\n\n1. Edit\n2. Check',
      steps: [
        {
          id: 'step_1',
          title: 'Edit index.html',
          files: ['index.html'],
          acceptance: ['content updated'],
        },
        {
          id: 'step_2',
          title: 'Check structure',
          depends_on: ['step_1'],
          files: ['index.html'],
          acceptance: ['structure is valid'],
        },
      ],
    })

    manager.approve(interaction.id)

    expect(todoStore.todos).toEqual([])
    expect(manager.latestExecutablePlan()?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'step_1',
          status: PlanStepStatus.ACTIVE,
        }),
        expect.objectContaining({
          id: 'step_2',
          status: PlanStepStatus.PENDING,
        }),
      ]),
    )
    const registry = makeRegistry(manager)
    registry.register(new UpdateTodos(todoStore))
    expect(
      manager.toolDefinitions(registry).map((definition) => definition.name),
    ).not.toContain('update_todos')
  })

  it('lets the model report PlanStep completion without manufacturing a Todo', () => {
    const manager = new ControlManager(tmp('emperor-plan-step-tool-'))
    manager.setTodoStore(new TodoStore())
    manager.setMode(ControlMode.PLAN)
    const interaction = manager.createPlan({
      title: 'Create one page',
      summary: 'Create a single self-contained HTML page.',
      planMarkdown: '# Plan\n\n1. Create the page',
      steps: [
        {
          id: 'step_1',
          title: 'Create index.html',
          description: 'Create the requested page.',
          files: ['index.html'],
          acceptance: ['the requested page is created'],
        },
      ],
    })
    manager.approve(interaction.id)
    const tool = new CompletePlanStepTool(manager)
    const result = tool.execute(
      {
        step_id: 'step_1',
        summary: 'Created index.html and satisfied the implementation scope.',
      },
      {
        root: '/tmp',
        arguments: {},
        turnId: 'turn_complete_step',
        parentCallId: 'call_complete_step',
      },
    )

    expect(String(result)).toContain('Plan step completed')
    expect(manager.planStore.list().at(-1)?.status).toBe(PlanStatus.COMPLETED)
  })

  it('does not stop a completed implementation for a model-suggested browser check', () => {
    const manager = new ControlManager(tmp('emperor-plan-optional-manual-'))
    manager.setTodoStore(new TodoStore())
    manager.setRuntimeScope({
      sessionId: 'session_optional_manual',
      mode: 'build',
    })
    manager.setMode(ControlMode.PLAN)
    const interaction = manager.createPlan({
      title: 'Create one page',
      summary: 'Create and visually inspect a single HTML page.',
      planMarkdown: '# Plan\n\n1. Create the page',
      steps: [
        {
          id: 'step_1',
          title: 'Create index.html',
          description: 'Create the requested page.',
          files: ['index.html'],
          acceptance: ['the requested page is created'],
          verification: [
            {
              id: 'browser_check',
              kind: 'manual',
              required: true,
              description: 'Open index.html in a browser and inspect it.',
            },
          ],
        },
      ],
    })
    manager.approve(interaction.id)

    manager.completePlanStep({
      stepId: 'step_1',
      summary: 'Created the requested page.',
      toolCallId: 'call_optional_manual',
    })

    const saved = manager.planStore.list().at(-1)!
    expect(saved.status).toBe(PlanStatus.COMPLETED)
    expect(requirementsForStep(saved.steps[0]!)[0]).toMatchObject({
      id: 'browser_check',
      required: false,
      humanRequired: false,
    })
    expect(
      manager.requestPlanExecutionDecision({
        turnId: 'turn_optional_manual',
        executionId: 'execution_optional_manual',
      }),
    ).toBeNull()
  })

  function approvedManager(): {
    manager: ControlManager
    todoStore: TodoStore
    taskManager: TaskManager
    planId: string
  } {
    const root = tmp('emperor-b1-')
    const manager = new ControlManager(root)
    manager.setRuntimeScope({
      sessionId: 'session-b1',
      mode: 'build',
      projectId: 'project-b1',
      workspaceRoot: '/workspace/b1',
      projectFingerprint: 'fingerprint-b1',
    })
    const todoStore = new TodoStore()
    const taskManager = new TaskManager(root)
    manager.setTodoStore(todoStore)
    manager.setTaskManager(taskManager)
    manager.setMode('plan')
    const discoveryId = seedPlanDiscovery(manager, ['a.html'])
    new ProposePlanTool(manager).execute({
      title: 'B1 completion',
      summary: 'Two-step plan for todo-sync completion.',
      plan_markdown: '# Plan',
      steps: [
        {
          id: 'step_1',
          title: 'Build it',
          description: 'write the file',
          files: ['a.html'],
          discovery_refs: [discoveryId],
          commands: [],
          acceptance: ['built'],
        },
        {
          id: 'step_2',
          title: 'Verify it',
          description: 'check output',
          files: [],
          discovery_refs: [discoveryId],
          commands: [],
          acceptance: ['checked'],
        },
      ],
      assumptions: [],
      risk_level: 'low',
    })
    const pending = manager.payload().pending as Record<string, unknown>
    manager.approve(String(pending.id))
    const plan = manager.planStore.latest()
    expect(plan).not.toBeNull()
    return { manager, todoStore, taskManager, planId: plan!.id }
  }

  function seedLegacyPlanTodos(
    manager: ControlManager,
    todoStore: TodoStore,
  ): void {
    const plan = manager.latestExecutablePlan()
    if (!plan) throw new Error('expected an executable Plan')
    const statusMap: Record<string, string> = {
      pending: 'pending',
      active: 'in_progress',
      done: 'completed',
      failed: 'pending',
      blocked: 'pending',
      skipped: 'completed',
    }
    todoStore.update(
      plan.steps.map((step) => ({
        id: `plan:${step.id}`,
        plan_id: plan.id,
        plan_step_id: step.id,
        approval_generation: Number(plan.metadata.approval_generation ?? 0),
        content: step.title,
        status: statusMap[step.status] ?? 'pending',
      })),
    )
  }

  function manualVerificationManager(): {
    root: string
    manager: ControlManager
    todoStore: TodoStore
    taskManager: TaskManager
    planId: string
  } {
    const root = tmp('emperor-plan-manual-verification-')
    const manager = new ControlManager(root)
    manager.setRuntimeScope({
      sessionId: 'session-manual-verification',
      mode: 'build',
      projectId: 'project-manual-verification',
      workspaceRoot: '/workspace/manual-verification',
      projectFingerprint: 'fingerprint-manual-verification',
    })
    const todoStore = new TodoStore()
    const taskManager = new TaskManager(root)
    manager.setTodoStore(todoStore)
    manager.setTaskManager(taskManager)
    manager.setMode('plan')
    const interaction = manager.createPlan({
      title: 'Manual browser verification',
      summary: 'Implement an HTML page and let the user verify it.',
      planMarkdown: '# Plan\n\n1. Implement\n2. Verify manually',
      steps: [
        {
          id: 'step_1',
          title: 'Implement page',
          description: 'Create the page.',
          files: ['index.html'],
          commands: [],
          acceptance: ['page is implemented'],
          verification: [
            {
              id: 'manual_browser',
              kind: 'manual',
              required: true,
              human_required: true,
              description: 'Open the page in a browser and inspect it.',
            },
          ],
        },
      ],
    })
    manager.approve(interaction.id)
    const plan = manager.planStore.latest()!
    manager.completePlanStep({
      stepId: 'step_1',
      summary: 'Implemented the page and reached the verification phase.',
      toolCallId: 'complete_step_claim',
    })
    return { root, manager, todoStore, taskManager, planId: plan.id }
  }

  it('pauses and resumes the active foreground Plan without creating Task or Todo mirrors', () => {
    const { manager, todoStore, taskManager, planId } = approvedManager()
    const running = manager.planStore.get(planId)!

    expect(running.status).toBe(PlanStatus.EXECUTING)
    expect(running.steps[0]!.status).toBe(PlanStepStatus.ACTIVE)
    expect(taskManager.store.list()).toEqual([])
    expect(todoStore.todos).toEqual([])

    const paused = manager.pausePlanExecution({
      reason: 'no_progress',
      turnId: 'turn_pause',
      pausedAt: 1234,
      evaluationCount: 2,
      totalIterations: 28,
      nextActions: ['Run the remaining verification'],
    })!

    expect(paused.status).toBe(PlanStatus.EXECUTING)
    expect(paused.steps[0]!.status).toBe(PlanStepStatus.ACTIVE)
    expect(paused.metadata.execution_pause).toEqual({
      version: 1,
      reason: 'no_progress',
      turn_id: 'turn_pause',
      paused_at: 1234,
      evaluation_count: 2,
      total_iterations: 28,
      next_actions: ['Run the remaining verification'],
    })
    expect(taskManager.store.list()).toEqual([])
    expect(todoStore.todos).toEqual([])

    const resumed = manager.resumePlanExecution({ turnId: 'turn_resume' })!

    expect(resumed.metadata.execution_pause).toBeUndefined()
    expect(resumed.metadata.last_execution_resume).toMatchObject({
      turn_id: 'turn_resume',
    })
    expect(taskManager.store.list()).toEqual([])
    expect(todoStore.todos).toEqual([])
  })

  it('persists the owning execution identity for an explicit Plan continuation', () => {
    const { manager } = approvedManager()
    const paused = manager.pausePlanExecution({
      reason: 'no_progress',
      turnId: 'turn_before_explicit_continue',
      executionId: 'execution_original_task',
      pausedAt: 1234,
      evaluationCount: 0,
      totalIterations: 12,
      nextActions: ['继续验证'],
    })!

    expect(paused.metadata.execution_pause).toMatchObject({
      turn_id: 'turn_before_explicit_continue',
      execution_id: 'execution_original_task',
    })
    expect(manager.pausedPlanExecutionId()).toBe('execution_original_task')
  })

  it('does not synthesize a Task when the authoritative pause save fails', () => {
    const { manager, taskManager, planId } = approvedManager()
    vi.spyOn(manager.planStore, 'save').mockImplementationOnce(() => {
      throw new Error('injected authoritative Plan save failure')
    })

    expect(() =>
      manager.pausePlanExecution({
        reason: 'no_progress',
        turnId: 'turn_save_failed',
        pausedAt: 1234,
        evaluationCount: 1,
        totalIterations: 20,
        nextActions: ['Retry later'],
      }),
    ).toThrow('injected authoritative Plan save failure')

    expect(
      manager.planStore.get(planId)?.metadata.execution_pause,
    ).toBeUndefined()
    expect(taskManager.store.list()).toEqual([])
  })

  it('replays a durable pause without recreating foreground Task or Todo mirrors', () => {
    const { manager, todoStore, taskManager, planId } = approvedManager()

    expect(
      manager.pausePlanExecution({
        reason: 'no_progress',
        turnId: 'turn_task_interrupted',
        pausedAt: 1234,
        evaluationCount: 1,
        totalIterations: 20,
        nextActions: ['Retry later'],
      }),
    ).toBeTruthy()

    expect(manager.planStore.get(planId)?.metadata.execution_pause).toBeTruthy()
    expect(taskManager.store.list()).toEqual([])
    expect(todoStore.todos).toEqual([])

    manager.setTaskManager(null)
    manager.setTaskManager(taskManager)
    manager.migrateLegacyPlanTodoMirrors()

    expect(taskManager.store.list()).toEqual([])
    expect(todoStore.todos).toEqual([])
  })

  it('keeps two-step Plan progress in PlanRecord instead of bound Todos', () => {
    const { manager, todoStore, taskManager } = approvedManager()
    expect(manager.planStore.latest()?.status).toBe(PlanStatus.EXECUTING)
    expect(todoStore.todos).toEqual([])
    expect(
      taskManager.store.list().filter((task) => task.kind === 'plan_step'),
    ).toEqual([])
  })

  it('never projects a three-step Plan into Todo and removes legacy mirrors', () => {
    const { manager, todoStore } = approvedManager()
    const current = manager.planStore.latest()!
    manager.planStore.save({
      ...current,
      steps: [
        ...current.steps,
        {
          ...current.steps[1]!,
          id: 'step_3',
          title: 'Document it',
          status: PlanStepStatus.PENDING,
        },
      ],
    })
    seedLegacyPlanTodos(manager, todoStore)

    manager.migrateLegacyPlanTodoMirrors()

    expect(todoStore.todos).toEqual([])
  })

  it('keeps update_todos independent from PlanStep authority', () => {
    const { manager, planId } = approvedManager()

    const normalized = manager.normalizePlanTodoUpdate([
      {
        id: 'plan:step_1',
        content: 'legacy Plan mirror',
        status: 'completed',
      },
      {
        id: 'scratch',
        content: 'Temporary investigation',
        status: 'in_progress',
      },
    ])

    expect(normalized).toEqual([
      expect.objectContaining({
        id: 'scratch',
        content: 'Temporary investigation',
        status: 'in_progress',
      }),
    ])
    expect(manager.planStore.get(planId)?.steps[0]?.status).toBe(
      PlanStepStatus.ACTIVE,
    )
  })

  it('rejects forged or stale explicit Plan Todo bindings before persistence', () => {
    const { manager, todoStore } = approvedManager()
    const before = todoStore.todos.map((todo) => ({ ...todo }))

    expect(() =>
      manager.normalizePlanTodoUpdate([
        {
          id: 'plan:step_1',
          content: 'Build it',
          status: 'completed',
          planId: 'forged-plan',
          planStepId: 'step_1',
          approvalGeneration: 99,
        },
      ]),
    ).toThrow(/bind|authority/i)
    expect(todoStore.todos).toEqual(before)
  })

  it('does not let a one-step Plan displace an independent Todo', () => {
    const manager = new ControlManager(tmp('emperor-plan-todo-active-slot-'))
    manager.setRuntimeScope({
      sessionId: 'session-plan-todo-active-slot',
      mode: 'build',
      projectId: 'project-plan-todo-active-slot',
      workspaceRoot: '/workspace/plan-todo-active-slot',
      projectFingerprint: 'fingerprint-plan-todo-active-slot',
    })
    const todoStore = new TodoStore()
    todoStore.update([
      {
        id: 'independent-active',
        content: 'Temporary investigation',
        status: 'in_progress',
      },
    ])
    manager.setTodoStore(todoStore)
    manager.setMode(ControlMode.PLAN)
    const discoveryId = seedPlanDiscovery(manager)
    new ProposePlanTool(manager).execute({
      title: 'Authoritative active step',
      summary: 'The Plan step owns the active Todo slot.',
      plan_markdown: '# Plan',
      steps: [
        {
          id: 'step_1',
          title: 'Implement the change',
          description: 'Implement it.',
          files: [],
          discovery_refs: [discoveryId],
          commands: [],
          acceptance: ['done'],
        },
      ],
      assumptions: [],
      risk_level: 'low',
    })
    const pending = manager.payload().pending as Record<string, unknown>

    manager.approve(String(pending.id))

    expect(todoStore.todos).toEqual([
      expect.objectContaining({
        id: 'independent-active',
        status: 'in_progress',
      }),
    ])
  })

  it('replaces every non-terminal Plan in the current scope when entering Plan mode', () => {
    const root = tmp('emperor-plan-mode-replacement-')
    const manager = new ControlManager(root)
    const taskManager = new TaskManager(root)
    const todoStore = new TodoStore()
    const scope = {
      sessionId: 'session-plan-replacement',
      mode: 'build' as const,
      projectId: 'project-plan-replacement',
      workspaceRoot: '/workspace/plan-replacement',
      projectFingerprint: 'fingerprint-plan-replacement',
    }
    manager.setRuntimeScope(scope)
    manager.setTaskManager(taskManager)
    manager.setTodoStore(todoStore)
    const oldTask = taskManager.startTask({
      kind: 'plan_step',
      title: 'Old work',
      source: 'plan_step',
      sessionId: scope.sessionId,
    })
    const oldPlan = manager.planStore.save(
      makePlanRecord({
        id: 'plan_old_executing',
        title: 'Old executable Plan',
        summary: 'Must be retired immediately.',
        status: PlanStatus.EXECUTING,
        createdAt: 1,
        updatedAt: 1,
        approvedAt: 1,
        sessionId: scope.sessionId,
        steps: [
          makeStep({
            id: 'step_1',
            title: 'Old work',
            status: PlanStepStatus.ACTIVE,
          }),
        ],
        metadata: {
          scope: {
            session_id: scope.sessionId,
            mode: scope.mode,
            project_id: scope.projectId,
            workspace_root: scope.workspaceRoot,
            project_fingerprint: scope.projectFingerprint,
          },
          permission_tokens: [{ token: 'revoke-me' }],
          plan_step_tasks: { step_1: oldTask.id },
        },
      }),
    )
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_old_draft',
        title: 'Old draft Plan',
        summary: 'Must also be retired.',
        status: PlanStatus.DRAFT,
        createdAt: 2,
        updatedAt: 2,
        sessionId: scope.sessionId,
        metadata: {
          scope: {
            session_id: scope.sessionId,
            mode: scope.mode,
            project_id: scope.projectId,
            workspace_root: scope.workspaceRoot,
            project_fingerprint: scope.projectFingerprint,
          },
        },
      }),
    )
    todoStore.update([
      {
        id: 1,
        content: 'Old Plan todo',
        status: 'in_progress',
        plan_id: oldPlan.id,
      },
      { id: 2, content: 'Independent todo', status: 'pending' },
    ])

    manager.setMode(ControlMode.PLAN)

    const replacement = manager.planStore
      .list()
      .find((plan) => plan.status === PlanStatus.DRAFT)!
    expect(replacement).toMatchObject({
      supersedesPlanId: 'plan_old_draft',
      sessionId: scope.sessionId,
    })
    expect(manager.planStore.get(oldPlan.id)).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: {
        permission_tokens: [],
        plan_step_tasks: {},
        superseded_by: replacement.id,
        superseded_reason: 'Plan mode entered with a replacement draft',
      },
    })
    expect(taskManager.store.get(oldTask.id)?.status).toBe('cancelled')
    expect(todoStore.todos).toEqual([
      { id: 2, content: 'Independent todo', status: 'pending' },
    ])
  })

  it('persists removal of superseded Plan todos through the TodoStore callback', () => {
    const manager = new ControlManager(tmp('emperor-plan-todo-persist-'))
    manager.setRuntimeScope({ sessionId: 'session-plan-todo-persist' })
    const persisted: Array<Array<Record<string, unknown>>> = []
    const todoStore = new TodoStore((todos) => persisted.push(todos))
    manager.setTodoStore(todoStore)
    const old = manager.planStore.save(
      makePlanRecord({
        id: 'plan_todo_persist_old',
        title: 'Old',
        summary: 'Old work',
        status: PlanStatus.EXECUTING,
        createdAt: 1,
        updatedAt: 1,
        approvedAt: 1,
        sessionId: 'session-plan-todo-persist',
        metadata: { scope: { session_id: 'session-plan-todo-persist' } },
      }),
    )
    todoStore.update([
      {
        id: 1,
        content: 'Bound old work',
        status: 'in_progress',
        plan_id: old.id,
      },
      { id: 2, content: 'Independent work', status: 'pending' },
    ])

    manager.setMode(ControlMode.PLAN)

    expect(persisted.at(-1)).toEqual([
      { id: 2, content: 'Independent work', status: 'pending' },
    ])
  })

  it('does not restore a superseded Plan when the replacement draft is cancelled', () => {
    const manager = new ControlManager(tmp('emperor-plan-mode-no-restore-'))
    const scope = {
      sessionId: 'session-plan-no-restore',
      mode: 'build' as const,
      projectId: 'project-plan-no-restore',
      workspaceRoot: '/workspace/plan-no-restore',
      projectFingerprint: 'fingerprint-plan-no-restore',
    }
    manager.setRuntimeScope(scope)
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_predecessor',
        title: 'Predecessor',
        summary: 'Never revive this Plan.',
        status: PlanStatus.APPROVED,
        createdAt: 1,
        updatedAt: 1,
        approvedAt: 1,
        sessionId: scope.sessionId,
        metadata: {
          scope: {
            session_id: scope.sessionId,
            mode: scope.mode,
            project_id: scope.projectId,
            workspace_root: scope.workspaceRoot,
            project_fingerprint: scope.projectFingerprint,
          },
        },
      }),
    )
    manager.setMode(ControlMode.PLAN)
    const replacement = manager.planStore
      .list()
      .find((plan) => plan.status === PlanStatus.DRAFT)!
    const interaction = manager.createPlan({
      title: 'Replacement',
      summary: 'This draft may be cancelled.',
      planMarkdown: '# Replacement',
      steps: [],
    })

    manager.cancel(interaction.id)

    expect(String(interaction.meta.plan_id)).toBe(replacement.id)
    expect(manager.planStore.get('plan_predecessor')?.status).toBe(
      PlanStatus.CANCELLED,
    )
    expect(manager.planStore.get(replacement.id)?.status).toBe(
      PlanStatus.CANCELLED,
    )
  })

  it('cancels a stale waiting interaction after a replacement batch committed before Control state', () => {
    const root = tmp('emperor-plan-replacement-recovery-')
    const manager = new ControlManager(root)
    const interaction = manager.createPlan({
      title: 'Interrupted predecessor',
      summary: 'Simulate a crash between Plan and Control stores.',
      planMarkdown: '# Interrupted predecessor',
      steps: [],
    })
    const planId = String(interaction.meta.plan_id)
    const waiting = manager.planStore.get(planId)!
    manager.planStore.save({
      ...waiting,
      status: PlanStatus.CANCELLED,
      metadata: {
        ...waiting.metadata,
        superseded_by: 'plan_replacement_after_crash',
      },
    })

    const restarted = new ControlManager(root)

    expect(restarted.payload().pending).toBeNull()
    expect(restarted.payload().last_interaction).toMatchObject({
      id: interaction.id,
      status: 'cancelled',
    })
  })

  it('retries durable PlanStep task revocation when TaskManager attaches after restart', () => {
    const root = tmp('emperor-plan-task-revocation-recovery-')
    const taskManager = new TaskManager(root)
    const task = taskManager.startTask({
      kind: 'plan_step',
      title: 'Interrupted old step',
      source: 'plan_step',
      sessionId: 'session-task-recovery',
    })
    const manager = new ControlManager(root)
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_cancelled_task_recovery',
        title: 'Cancelled Plan',
        summary: 'Its task cleanup was interrupted.',
        status: PlanStatus.CANCELLED,
        createdAt: 1,
        updatedAt: 1,
        sessionId: 'session-task-recovery',
        metadata: {
          plan_step_tasks_revoked: { step_1: task.id },
          plan_step_tasks_revocation_pending: [task.id],
        },
      }),
    )

    manager.setTaskManager(taskManager)

    expect(taskManager.store.get(task.id)?.status).toBe('cancelled')
    expect(
      manager.planStore.get('plan_cancelled_task_recovery')?.metadata
        .plan_step_tasks_revocation_pending,
    ).toBeUndefined()
  })

  it('treats an interrupted PlanStep task as terminal during revocation reconciliation', () => {
    const root = tmp('emperor-plan-task-interrupted-recovery-')
    const taskManager = new TaskManager(root)
    const task = taskManager.startTask({
      kind: 'plan_step',
      title: 'Interrupted old step',
      source: 'plan_step',
      sessionId: 'session-task-interrupted-recovery',
    })
    taskManager.updateTask(task.id, { status: 'interrupted' })
    const manager = new ControlManager(root)
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_cancelled_interrupted_task',
        title: 'Cancelled Plan',
        summary: 'Its interrupted task is already terminal.',
        status: PlanStatus.CANCELLED,
        createdAt: 1,
        updatedAt: 1,
        sessionId: 'session-task-interrupted-recovery',
        metadata: {
          plan_step_tasks_revoked: { step_1: task.id },
          plan_step_tasks_revocation_pending: [task.id],
        },
      }),
    )

    manager.setTaskManager(taskManager)

    expect(taskManager.store.get(task.id)?.status).toBe('interrupted')
    expect(
      manager.planStore.get('plan_cancelled_interrupted_task')?.metadata
        .plan_step_tasks_revocation_pending,
    ).toBeUndefined()
  })

  it('persists and retries stale Plan task revocation and removes its Todo bindings', () => {
    const root = tmp('emperor-plan-stale-revocation-')
    const manager = new ControlManager(root)
    const taskManager = new TaskManager(root)
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    const scope = {
      session_id: 'session-stale-revocation',
      mode: 'build',
      project_id: 'project-stale-revocation',
      workspace_root: '/workspace/stale-revocation',
      project_fingerprint: 'fingerprint-stale-revocation',
    }
    const oldTask = taskManager.startTask({
      kind: 'plan_step',
      title: 'Old running step',
      source: 'plan_step',
      sessionId: scope.session_id,
    })
    const successor = manager.planStore.save(
      makePlanRecord({
        id: 'plan_stale_successor',
        title: 'Successor',
        summary: 'Approved successor.',
        status: PlanStatus.APPROVED,
        createdAt: 2,
        updatedAt: 2,
        approvedAt: 2,
        sessionId: scope.session_id,
        metadata: { scope, approval_generation: 1 },
      }),
    )
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_stale_predecessor',
        title: 'Stale predecessor',
        summary: 'Must be cancelled durably.',
        status: PlanStatus.EXECUTING,
        createdAt: 1,
        updatedAt: 1,
        approvedAt: 1,
        sessionId: scope.session_id,
        metadata: {
          scope,
          approval_generation: 1,
          plan_step_tasks: { step_1: oldTask.id },
        },
      }),
    )
    todoStore.update([
      {
        id: 'old-bound-todo',
        content: 'Old running step',
        status: 'in_progress',
        plan_id: 'plan_stale_predecessor',
        plan_step_id: 'step_1',
        approval_generation: 1,
      },
      { id: 'independent', content: 'Keep me', status: 'pending' },
    ])
    let firstCancel = true
    manager.setTaskManager({
      store: taskManager.store,
      appendSidechain: (...args) => taskManager.appendSidechain(...args),
      updateTask: (...args) => taskManager.updateTask(...args),
      startTask: (...args) => taskManager.startTask(...args),
      cancelTask: (...args) => {
        if (firstCancel) {
          firstCancel = false
          throw new Error('simulated cancellation interruption')
        }
        return taskManager.cancelTask(...args)
      },
    })

    expect(() =>
      (
        manager as unknown as {
          execution: { supersedeStaleExecutingPlans(id: string): void }
        }
      ).execution.supersedeStaleExecutingPlans(successor.id),
    ).not.toThrow()

    expect(manager.planStore.get('plan_stale_predecessor')).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: {
        plan_step_tasks: {},
        plan_step_tasks_revocation_pending: [oldTask.id],
      },
    })
    expect(todoStore.todos).toEqual([
      { id: 'independent', content: 'Keep me', status: 'pending' },
    ])
    expect(taskManager.store.get(oldTask.id)?.status).toBe('running')

    manager.setTaskManager(taskManager)

    expect(taskManager.store.get(oldTask.id)?.status).toBe('cancelled')
    expect(
      manager.planStore.get('plan_stale_predecessor')?.metadata
        .plan_step_tasks_revocation_pending,
    ).toBeUndefined()
  })

  it('keeps the replacement draft id and increments approval generation for revisions', () => {
    const manager = new ControlManager(tmp('emperor-plan-mode-revision-id-'))
    manager.setRuntimeScope({
      sessionId: 'session-plan-revision-id',
      mode: 'build',
      projectId: 'project-plan-revision-id',
      workspaceRoot: '/workspace/plan-revision-id',
      projectFingerprint: 'fingerprint-plan-revision-id',
    })
    manager.setMode(ControlMode.PLAN)
    const draftId = manager.planStore
      .list()
      .find((plan) => plan.status === PlanStatus.DRAFT)!.id
    const first = manager.createPlan({
      title: 'First draft',
      summary: 'First version.',
      planMarkdown: '# First',
      steps: [],
    })
    manager.comment(first.id, 'Please revise the draft.')
    const second = manager.createPlan({
      title: 'Second draft',
      summary: 'Second version.',
      planMarkdown: '# Second',
      steps: [],
    })

    expect(first.meta.plan_id).toBe(draftId)
    expect(second.meta.plan_id).toBe(draftId)
    expect(manager.planStore.get(draftId)?.metadata.approval_generation).toBe(2)
  })

  it('fails closed for Plan replacement when setMode has no runtime scope', () => {
    const manager = new ControlManager(tmp('emperor-plan-mode-missing-scope-'))
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_foreign_session',
        title: 'Foreign Plan',
        summary: 'Must not be replaced without a scope.',
        status: PlanStatus.EXECUTING,
        createdAt: 1,
        updatedAt: 1,
        approvedAt: 1,
        sessionId: 'foreign-session',
        metadata: {
          scope: {
            session_id: 'foreign-session',
            mode: 'build',
            workspace_root: '/workspace/foreign',
            project_fingerprint: 'fingerprint-foreign',
          },
        },
      }),
    )

    manager.setMode(ControlMode.PLAN)

    expect(manager.planStore.get('plan_foreign_session')?.status).toBe(
      PlanStatus.EXECUTING,
    )
    expect(manager.planStore.list()).toHaveLength(1)
  })

  it('does not reuse a foreign scoped draft when an unbound manager proposes a plan', () => {
    const manager = new ControlManager(tmp('emperor-plan-foreign-draft-'))
    manager.planStore.save(
      makePlanRecord({
        id: 'plan_foreign_draft',
        title: 'Foreign draft',
        summary: 'Owned by another session.',
        status: PlanStatus.DRAFT,
        createdAt: 1,
        updatedAt: 1,
        sessionId: 'foreign-session',
        metadata: { scope: { session_id: 'foreign-session' } },
      }),
    )
    manager.setMode(ControlMode.PLAN)

    const interaction = manager.createPlan({
      title: 'Local unscoped proposal',
      summary: 'Must receive a distinct identity.',
      planMarkdown: '# Local plan',
      steps: [],
    })

    expect(interaction.meta.plan_id).not.toBe('plan_foreign_draft')
    expect(manager.planStore.get('plan_foreign_draft')).toMatchObject({
      title: 'Foreign draft',
      status: PlanStatus.DRAFT,
    })
  })

  it('records a Todo completion claim but completes only after required verification passes', () => {
    const manager = new ControlManager(tmp('emperor-plan-verified-claim-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    manager.setMode(ControlMode.PLAN)
    const discoveryId = seedPlanDiscovery(manager, ['src/example.ts'])
    new ProposePlanTool(manager).execute({
      title: 'Verified completion',
      summary: 'Implementation and verification are separate facts.',
      plan_markdown: '# Plan\n\n1. Implement and test',
      assumptions: [],
      risk_level: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Implement and test',
          description: 'Change the implementation and run its test.',
          files: ['src/example.ts'],
          discovery_refs: [discoveryId],
          commands: ['npm test'],
          acceptance: ['npm test passes'],
        },
      ],
    })
    const pending = manager.payload().pending as Record<string, unknown>
    const planId = String((pending.meta as Record<string, unknown>).plan_id)
    manager.approve(String(pending.id))

    const claimed = manager.completePlanStep({
      stepId: 'step_1',
      summary: 'Implementation is complete; run the required test.',
      toolCallId: 'complete_verified_step',
    })

    expect(claimed.status).toBe(PlanStatus.EXECUTING)
    expect(claimed.steps[0]!.status).toBe(PlanStepStatus.ACTIVE)
    expect(todoStore.todos).toEqual([])
    expect(claimed.metadata.implementation_claims).toMatchObject({
      step_1: expect.objectContaining({ source: 'plan_step_completion' }),
    })
    expect(claimed.metadata.plan_step_execution_phases).toMatchObject({
      step_1: 'verifying',
    })

    const failed = manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command: 'npm test', passed: false, summary: 'failed' },
    })!
    expect(failed.status).toBe(PlanStatus.EXECUTING)
    expect(failed.steps[0]!.status).toBe(PlanStepStatus.ACTIVE)
    expect(failed.metadata.plan_step_execution_phases).toMatchObject({
      step_1: 'repairing',
    })
    expect(
      manager.requestPlanExecutionDecision({
        turnId: 'turn_repair_failed_verification',
        executionId: 'execution_repair_failed_verification',
      }),
    ).toBeNull()

    manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command: 'npm test', passed: false, summary: 'failed' },
    })
    manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command: 'npm test', passed: false, summary: 'failed' },
    })
    expect(
      manager.requestPlanExecutionDecision({
        turnId: 'turn_repeated_verification_failure',
        executionId: 'execution_repeated_verification_failure',
      }),
    ).toMatchObject({
      kind: 'ask',
      status: 'waiting',
      meta: {
        interaction_type: 'plan_execution',
      },
    })
    manager.cancel(
      String((manager.payload().pending as Record<string, unknown>).id),
    )
    manager.resumePlanExecution({
      turnId: 'turn_resume_after_repeated_failure',
    })

    const passed = manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command: 'npm test', passed: true, summary: 'passed' },
    })!
    expect(passed.status).toBe(PlanStatus.COMPLETED)
    expect(passed.steps[0]!.status).toBe(PlanStepStatus.DONE)
    expect(passed.metadata.plan_step_execution_phases).toMatchObject({
      step_1: 'completed',
    })
    expect(todoStore.todos).toEqual([])
  })

  it('uses a signed stable action to waive manual verification and complete the Plan', () => {
    const { manager, todoStore, taskManager, planId } =
      manualVerificationManager()

    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_manual_waiver',
      executionId: 'execution_manual_waiver',
    })
    expect(decision).toMatchObject({
      kind: 'ask',
      status: 'waiting',
      meta: {
        interaction_type: 'plan_execution',
        execution_id: 'execution_manual_waiver',
      },
    })
    expect(decision!.questions[0]!.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'manual_verification_passed' }),
        expect.objectContaining({ id: 'waive_verification_and_complete' }),
        expect.objectContaining({ id: 'cancel_plan' }),
      ]),
    )
    expect(
      (manager.payload().pending as Record<string, unknown>).meta,
    ).not.toHaveProperty('plan_execution_action_request')

    const resume = manager.answer(decision!.id, {
      plan_execution_action: {
        option_id: 'waive_verification_and_complete',
        choice: '任意伪造标签',
        freeform: '',
      },
    })

    expect(resume).toMatchObject({
      resume: true,
      executionId: 'execution_manual_waiver',
      executionDisposition: 'complete',
      settlementId: expect.stringMatching(/^plan_settlement_/),
    })
    expect(JSON.stringify(resume)).not.toContain('coreSignature')
    const completed = manager.planStore.get(planId)!
    expect(completed.status).toBe(PlanStatus.COMPLETED)
    expect(completed.steps[0]!.status).toBe(PlanStepStatus.DONE)
    expect(completed.steps[0]!.verification).toEqual([
      expect.objectContaining({
        id: 'manual_browser',
        status: 'skipped',
        reason: expect.stringContaining('user'),
      }),
    ])
    expect(completed.steps[0]!.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'user_plan_verification_waiver',
          approved_by: 'user',
          issued_by: 'core',
        }),
      ]),
    )
    expect(todoStore.todos).toEqual([])
    expect(taskManager.store.list()).toEqual([])
  })

  it('cancels an active Plan only through the signed cancel action', () => {
    const { manager, todoStore, taskManager, planId } =
      manualVerificationManager()
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_cancel_plan',
      executionId: 'execution_cancel_plan',
    })!

    const resume = manager.answer(decision.id, {
      plan_execution_action: {
        option_id: 'cancel_plan',
        choice: '取消计划',
        freeform: '',
      },
    })

    expect(resume).toMatchObject({
      resume: false,
      executionDisposition: 'cancel',
    })
    expect(manager.planStore.get(planId)?.status).toBe(PlanStatus.CANCELLED)
    expect(manager.latestExecutablePlan()).toBeNull()
    expect(taskManager.store.list()).toEqual([])
    expect(todoStore.todos).toEqual([])
  })

  it('rejects a tampered signed Plan action request with zero lifecycle side effects', () => {
    const { manager, todoStore, taskManager, planId } =
      manualVerificationManager()
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_tampered_action',
      executionId: 'execution_tampered_action',
    })!
    const state = manager.store.load()
    const request = state.pending!.meta.plan_execution_action_request as Record<
      string,
      unknown
    >
    state.pending!.meta.plan_execution_action_request = {
      ...request,
      approvalGeneration: Number(request.approvalGeneration) + 1,
    }
    manager.store.save(state)

    expect(() =>
      manager.answer(decision.id, {
        plan_execution_action: {
          option_id: 'cancel_plan',
          choice: '取消计划',
          freeform: '',
        },
      }),
    ).toThrow(/invalid/)
    expect(manager.planStore.get(planId)?.status).toBe(PlanStatus.EXECUTING)
    expect(todoStore.todos).toEqual([])
    expect(taskManager.store.list()).toEqual([])
    expect(manager.payload().pending).toMatchObject({
      id: decision.id,
      status: 'waiting',
    })
  })

  it('records manual verification as user evidence without calling it automatic', () => {
    const { manager, planId } = manualVerificationManager()
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_manual_pass',
      executionId: 'execution_manual_pass',
    })!

    const resume = manager.answer(decision.id, {
      plan_execution_action: {
        option_id: 'manual_verification_passed',
        choice: '我已人工验证通过',
        freeform: '',
      },
    })

    expect(resume.executionDisposition).toBe('complete')
    const completed = manager.planStore.get(planId)!
    expect(completed.status).toBe(PlanStatus.COMPLETED)
    expect(completed.steps[0]!.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'user_manual_verification',
          issued_by: 'core',
          approved_by: 'user',
          passed: true,
        }),
      ]),
    )
    expect(completed.steps[0]!.evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'core_plan_step_verification',
        }),
      ]),
    )
  })

  it('manual confirmation resolves only manual requirements in a mixed verification step', () => {
    const root = tmp('emperor-plan-mixed-verification-')
    const manager = new ControlManager(root)
    const todoStore = new TodoStore()
    manager.setRuntimeScope({
      sessionId: 'session-mixed-verification',
      mode: 'build',
    })
    manager.setTodoStore(todoStore)
    const interaction = manager.createPlan({
      title: 'Mixed verification',
      summary: 'Manual confirmation must not replace command evidence.',
      planMarkdown: '# Plan',
      steps: [
        {
          id: 'step_1',
          title: 'Implement and verify',
          description: 'Implement and verify automatically and manually.',
          files: ['index.html'],
          acceptance: ['implementation is complete'],
          verification: [
            {
              id: 'command_test',
              kind: 'command',
              command: 'npm test',
              required: true,
            },
            {
              id: 'manual_browser',
              kind: 'manual',
              description: 'Inspect the page in a browser.',
              required: true,
              human_required: true,
            },
          ],
        },
      ],
    })
    manager.approve(interaction.id)
    const planId = String(interaction.meta.plan_id)
    manager.completePlanStep({
      stepId: 'step_1',
      summary: 'Implementation is complete; verification remains.',
      toolCallId: 'complete_mixed_step',
    })
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_mixed_manual',
      executionId: 'execution_mixed_manual',
    })!

    const resume = manager.answer(decision.id, {
      plan_execution_action: {
        option_id: 'manual_verification_passed',
        choice: '我已人工验证通过',
        freeform: '',
      },
    })

    expect(resume.executionDisposition).toBe('resume')
    const partiallyVerified = manager.planStore.get(planId)!
    expect(partiallyVerified.status).toBe(PlanStatus.EXECUTING)
    expect(requirementsForStep(partiallyVerified.steps[0]!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'manual_browser',
          status: 'passed',
        }),
        expect.objectContaining({
          id: 'command_test',
          status: 'pending',
        }),
      ]),
    )
    expect(
      partiallyVerified.steps[0]!.evidence.filter(
        (item) => item.source === 'user_manual_verification',
      ),
    ).toEqual([expect.objectContaining({ requirement_id: 'manual_browser' })])
  })

  it('replays a prepared verification settlement after a crash', () => {
    const { root, manager, planId } = manualVerificationManager()
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_settlement_recovery',
      executionId: 'execution_settlement_recovery',
    })!
    const save = vi
      .spyOn(manager.planStore, 'save')
      .mockImplementationOnce(() => {
        throw new Error('injected crash after settlement prepare')
      })

    expect(() =>
      manager.answer(decision.id, {
        plan_execution_action: {
          option_id: 'waive_verification_and_complete',
          choice: '跳过验证并完成',
          freeform: '',
        },
      }),
    ).toThrow('injected crash after settlement prepare')
    save.mockRestore()

    const restarted = new ControlManager(root)
    expect(restarted.planStore.get(planId)?.status).toBe(PlanStatus.COMPLETED)
    expect(restarted.payload().pending).toBeNull()
    expect(restarted.payload().last_interaction).toMatchObject({
      id: decision.id,
      status: 'answered',
    })
  })

  it('replays a settlement when the process crashes after Plan apply but before pending clear', () => {
    const { root, manager, planId } = manualVerificationManager()
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_settlement_pending_clear',
      executionId: 'execution_settlement_pending_clear',
    })!
    const save = vi.spyOn(manager.store, 'save').mockImplementationOnce(() => {
      throw new Error('injected crash before pending clear')
    })

    expect(() =>
      manager.answer(decision.id, {
        plan_execution_action: {
          option_id: 'waive_verification_and_complete',
          choice: '跳过验证并完成',
          freeform: '',
        },
      }),
    ).toThrow('injected crash before pending clear')
    save.mockRestore()

    expect(manager.planStore.get(planId)?.status).toBe(PlanStatus.COMPLETED)
    expect(manager.payload().pending).toMatchObject({ id: decision.id })

    const restarted = new ControlManager(root)
    expect(restarted.planStore.get(planId)?.status).toBe(PlanStatus.COMPLETED)
    expect(restarted.payload().pending).toBeNull()
    expect(restarted.payload().last_interaction).toMatchObject({
      id: decision.id,
      status: 'answered',
    })
  })

  it('pauses the foreground Plan without creating a Task when a verification decision is dismissed', () => {
    const { manager, taskManager, planId } = manualVerificationManager()
    const decision = manager.requestPlanExecutionDecision({
      turnId: 'turn_dismiss_verification',
      executionId: 'execution_dismiss_verification',
    })!

    const event = manager.cancel(decision.id)

    expect(event).toMatchObject({
      event: 'plan_execution_settled',
      action: 'pause',
      disposition: 'pause',
    })
    const paused = manager.planStore.get(planId)!
    expect(paused.status).toBe(PlanStatus.EXECUTING)
    expect(paused.metadata.execution_pause).toMatchObject({
      reason: 'user_input_required',
      turn_id: 'turn_dismiss_verification',
    })
    expect(taskManager.store.list()).toEqual([])

    const resumed = manager.resumePlanExecution({
      turnId: 'turn_resume_verification',
    })!
    expect(resumed.metadata.execution_pause).toBeUndefined()
    expect(resumed.metadata.plan_step_execution_phases).toMatchObject({
      step_1: 'verifying',
    })
    expect(taskManager.store.list()).toEqual([])
  })

  it('removes stale legacy Todo bindings without mutating Plan authority', () => {
    const { manager, todoStore, planId } = approvedManager()
    seedLegacyPlanTodos(manager, todoStore)
    manager.migrateLegacyPlanTodoMirrors()

    expect(manager.planStore.get(planId)!.steps[0]!.status).toBe(
      PlanStepStatus.ACTIVE,
    )
    expect(todoStore.todos).toEqual([])
  })

  it('rejects explicit Plan bindings at update_todos normalization', () => {
    const { manager } = approvedManager()
    expect(() =>
      manager.normalizePlanTodoUpdate([
        {
          id: 'forged',
          content: 'Cannot complete a Plan step',
          status: 'completed',
          plan_id: 'plan-forged',
          plan_step_id: 'step_1',
          approval_generation: 1,
        },
      ]),
    ).toThrow(/cannot bind to PlanStep authority/)
  })

  it('supersedes stale executing plans when a new plan is approved', () => {
    const { manager, planId: firstPlanId } = approvedManager()
    manager.setMode('plan')
    const discoveryId = seedPlanDiscovery(manager)
    new ProposePlanTool(manager).execute({
      title: 'B1 successor',
      summary: 'Second plan should supersede the zombie.',
      plan_markdown: '# Plan 2',
      steps: [
        {
          id: 'step_1',
          title: 'Redo',
          description: 'redo',
          files: [],
          discovery_refs: [discoveryId],
          commands: [],
          acceptance: ['ok'],
        },
      ],
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

  it('supersedes only the same Goal and full runtime scope, revoking tasks and tokens', () => {
    const root = tmp('emperor-goal-supersede-scope-')
    const manager = new ControlManager(root)
    const taskManager = new TaskManager(root)
    const goal = lockedGoal('goal_supersede', {
      sessionId: 'session_supersede',
      mode: 'build',
      projectId: 'project_supersede',
      workspaceRoot: '/workspace/supersede',
    })
    manager.setRuntimeScope(goal.scope)
    manager.setActiveGoalPlanContext(goal)
    manager.setTodoStore(new TodoStore())
    manager.setTaskManager(taskManager)
    const scope = {
      session_id: goal.scope.sessionId,
      mode: goal.scope.mode,
      project_id: goal.scope.projectId,
      workspace_root: goal.scope.workspaceRoot,
      project_fingerprint: goal.scope.projectFingerprint,
    }
    const oldTask = taskManager.startTask({
      kind: 'plan_step',
      title: 'Old step',
      source: 'plan_step',
      sessionId: goal.scope.sessionId,
    })
    const base = {
      title: 'Old executable',
      summary: 'Must be isolated by Goal and full scope.',
      status: PlanStatus.EXECUTING,
      createdAt: 1,
      updatedAt: 1,
      approvedAt: 1,
      sessionId: goal.scope.sessionId,
      steps: [
        makeStep({
          id: 'step_1',
          title: 'Old step',
          status: PlanStepStatus.ACTIVE,
        }),
      ],
    }
    manager.planStore.save(
      makePlanRecord({
        ...base,
        id: 'plan_old_same_goal',
        goalId: goal.id,
        metadata: {
          scope,
          approval_generation: 1,
          permission_tokens: [{ secret: 'must-be-revoked' }],
          plan_step_tasks: { step_1: oldTask.id },
        },
      }),
    )
    manager.planStore.save(
      makePlanRecord({
        ...base,
        id: 'plan_foreign_scope',
        goalId: goal.id,
        sessionId: 'foreign-session',
        metadata: {
          scope: { ...scope, session_id: 'foreign-session' },
          approval_generation: 1,
        },
      }),
    )
    manager.planStore.save(
      makePlanRecord({
        ...base,
        id: 'plan_foreign_goal',
        goalId: 'goal_foreign',
        metadata: { scope, approval_generation: 1 },
      }),
    )

    manager.setMode('plan')
    const discoveryId = seedPlanDiscovery(manager)
    new ProposePlanTool(manager).execute({
      title: 'Scoped successor',
      summary: 'Only the exact Goal predecessor is superseded.',
      plan_markdown: '# Plan',
      steps: [
        {
          id: 'step_1',
          title: 'New step',
          description: 'new work',
          files: [],
          discovery_refs: [discoveryId],
          commands: [],
          acceptance: ['done'],
        },
      ],
      assumptions: [],
      risk_level: 'low',
    })
    const pending = manager.payload().pending as Record<string, unknown>
    manager.approve(String(pending.id))
    const successorId = String(
      pending.meta && (pending.meta as Record<string, unknown>).plan_id,
    )

    expect(manager.planStore.get('plan_old_same_goal')).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: {
        permission_tokens: [],
        plan_step_tasks: {},
        superseded_by: successorId,
      },
    })
    expect(taskManager.store.get(oldTask.id)?.status).toBe('cancelled')
    expect(manager.planStore.get('plan_foreign_scope')?.status).toBe(
      PlanStatus.EXECUTING,
    )
    expect(manager.planStore.get('plan_foreign_goal')?.status).toBe(
      PlanStatus.EXECUTING,
    )
  })
})
