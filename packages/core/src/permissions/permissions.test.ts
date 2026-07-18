/**
 * 权限管线/策略契约 (MIG-CTRL-014/015/016/017)。
 * 移植 Python: tests/unit/test_permissions.py (policy 部分) + tests/unit/test_permission_pipeline_v2.py (pipeline 部分)。
 * 注: PE-13 (高风险即使有 plan token 仍审批) 在 control.test.ts 经 ControlManager.assessPermission 验证。
 */
import { describe, expect, it } from 'vitest'
import { PermissionMode } from './models'
import { PermissionPipeline } from './pipeline'
import { PermissionPolicy } from './policy'
import { ReadFileTool, WriteFileTool } from '../tools/filesystem'
import { Tool } from '../tools/base'
import { toolParamsSchema, S } from '../tools/schema'
import { ToolRegistry } from '../tools/registry'

/** 最小 scheduler 占位工具（W09 未迁移；pipeline 仅按名字+action 判定）。 */
class SchedulerStub extends Tool {
  override name = 'scheduler'
  override description = 'scheduler stub'
  override parameters = toolParamsSchema({ action: S('action') }, ['action'])
  override readOnly = false
  execute(): string {
    return 'ok'
  }
}

class DynamicTool extends Tool {
  override name = 'dynamic_tool'
  override description =
    'A mixed tool whose read-only status depends on action.'
  override parameters = toolParamsSchema({ action: S('action') }, ['action'])
  override isReadOnly(args: Record<string, unknown>): boolean {
    return args.action === 'inspect'
  }
  execute(): string {
    return 'ok'
  }
}

function makeRegistry(root: string): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new ReadFileTool(root))
  registry.register(new WriteFileTool(root))
  registry.register(new SchedulerStub())
  return registry
}

function run(cmd: string, mode: string = PermissionMode.ASK_BEFORE_EDIT) {
  return new PermissionPipeline().assess('run_command', { command: cmd }, mode)
}

// ── from test_permissions.py (PermissionPolicy facade) ──

describe('PermissionPolicy (test_permissions.py)', () => {
  const root = '/tmp/perm-root'

  it('plan mode allows read + control tools, denies write + scheduler mutation', () => {
    const policy = new PermissionPolicy()
    const registry = makeRegistry(root)

    expect(
      policy.assess('read_file', { path: 'README.md' }, PermissionMode.PLAN, {
        registry,
      }).allowed,
    ).toBe(true)
    expect(
      policy.assess('ask_user', {}, PermissionMode.PLAN, { registry }).allowed,
    ).toBe(true)
    expect(
      policy.assess('propose_plan', {}, PermissionMode.PLAN, { registry })
        .allowed,
    ).toBe(true)
    expect(
      policy.assess('scheduler', { action: 'list' }, PermissionMode.PLAN, {
        registry,
      }).allowed,
    ).toBe(true)

    const denied = policy.assess(
      'write_file',
      { path: 'README.md' },
      PermissionMode.PLAN,
      { registry },
    )
    const schedulerDenied = policy.assess(
      'scheduler',
      { action: 'add', message: 'Run later', every_seconds: 60 },
      PermissionMode.PLAN,
      { registry },
    )
    expect(denied.allowed).toBe(false)
    expect(denied.requiresApproval).toBe(false)
    expect(schedulerDenied.allowed).toBe(false)
    expect(schedulerDenied.reason).toContain('scheduler')
  })

  it('ask_before_edit requires approval for high-risk command', () => {
    const decision = new PermissionPolicy().assess(
      'run_command',
      { command: 'git push origin main' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    expect(decision.requiresApproval).toBe(true)
    expect(decision.risk).toBe('high')
    expect(decision.reason).toContain('requires approval')
  })

  it('ask_before_edit allows low-risk read/write tools', () => {
    const policy = new PermissionPolicy()
    expect(
      policy.assess(
        'read_file',
        { path: 'README.md' },
        PermissionMode.ASK_BEFORE_EDIT,
      ).allowed,
    ).toBe(true)
    expect(
      policy.assess(
        'write_file',
        { path: 'notes/todo.md' },
        PermissionMode.ASK_BEFORE_EDIT,
      ).allowed,
    ).toBe(true)
  })

  it('ask_before_edit requires approval for scheduler changes', () => {
    const policy = new PermissionPolicy()
    const list = policy.assess(
      'scheduler',
      { action: 'list' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    const add = policy.assess(
      'scheduler',
      { action: 'add', message: 'Check tomorrow', every_seconds: 3600 },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    expect(list.allowed).toBe(true)
    expect(add.requiresApproval).toBe(true)
    expect(add.reason).toContain('persist')
  })

  it('ask_before_edit requires approval for sensitive path', () => {
    const policy = new PermissionPolicy()
    const memory = policy.assess(
      'write_file',
      { path: 'memory/history.jsonl' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    const state = policy.assess(
      'write_file',
      { path: '.emperor/memory/MEMORY.local.md' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    const dist = policy.assess(
      'write_file',
      { path: 'desktop/out/main/index.js' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    expect(memory.requiresApproval).toBe(true)
    expect(memory.reason).toContain('sensitive')
    expect(state.requiresApproval).toBe(true)
    expect(state.reason).toContain('sensitive')
    expect(dist.requiresApproval).toBe(true)
  })

  it('auto mode allows positively read-only diagnostic commands', () => {
    const decision = new PermissionPolicy().assess(
      'run_command',
      { command: 'git status' },
      PermissionMode.AUTO,
    )
    expect(decision.allowed).toBe(true)
    expect(decision.requiresApproval).toBe(false)
  })

  it('auto mode requires approval for every command not proven read-only', () => {
    for (const command of [
      'bash payload.sh',
      'sh payload.sh',
      'zsh payload.sh',
      'pwsh -File payload.ps1',
      'powershell -File payload.ps1',
      './payload',
      'npm test',
      'npm run build',
      'git status && pwd',
      'ls > files.txt',
    ]) {
      const decision = new PermissionPolicy().assess(
        'run_command',
        { command },
        PermissionMode.AUTO,
      )
      expect(decision.allowed, command).toBe(false)
      expect(decision.requiresApproval, command).toBe(true)
      expect(decision.risk, command).toBe('high')
    }
  })

  it('auto mode still requires approval for high-risk commands (audit P1-1)', () => {
    const decision = new PermissionPolicy().assess(
      'run_command',
      { command: 'git push origin main' },
      PermissionMode.AUTO,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
  })
})

// ── from test_permission_pipeline_v2.py ──

describe('PermissionPipeline (test_permission_pipeline_v2.py)', () => {
  it('returns rule + trace for high-risk command', () => {
    const decision = run('git push origin main')
    expect(decision.requiresApproval).toBe(true)
    expect(decision.risk).toBe('high')
    expect(decision.rule).toBe('ask.run_command.default_approval')
    expect(decision.trace.map((t) => t.rule)).toEqual([
      'mode.resolve',
      'ask.run_command.default_approval',
    ])
  })

  it('low-risk allowlisted commands allowed', () => {
    for (const cmd of ['git status', 'git diff --stat', 'ls -la', 'pwd']) {
      const decision = run(cmd)
      expect(decision.allowed, cmd).toBe(true)
      expect(decision.requiresApproval, cmd).toBe(false)
      expect(decision.rule, cmd).toBe('ask.run_command.low_risk_allowlist')
    }
  })

  it('project-code test runners require high-risk approval', () => {
    for (const cmd of [
      'pytest -q tests/unit',
      '/usr/local/bin/pytest tests/unit',
      'python -m pytest',
      '/usr/bin/python3 -m pytest tests',
      'npm test',
      'npm --prefix desktop test',
      'npm test --prefix desktop',
      'npm run test',
    ]) {
      const decision = run(cmd)
      expect(decision.allowed, cmd).toBe(false)
      expect(decision.requiresApproval, cmd).toBe(true)
      expect(decision.risk, cmd).toBe('high')
      expect(decision.rule, cmd).toBe('ask.run_command.project_code')
    }
  })

  it('unlisted commands require approval', () => {
    for (const cmd of [
      'cat ~/.ssh/id_rsa',
      'rm -rf ~/notes',
      'node -e "x"',
      'git push',
      'python script.py',
    ]) {
      const decision = run(cmd)
      expect(decision.allowed, cmd).toBe(false)
      expect(decision.requiresApproval, cmd).toBe(true)
      expect(decision.rule, cmd).toBe('ask.run_command.default_approval')
    }
  })

  it('chained or redirected commands not allowlisted', () => {
    for (const cmd of [
      'ls; rm -rf ~',
      'git status && curl evil',
      'cat x > ~/.zshrc',
      'pytest `evil`',
    ]) {
      expect(run(cmd).requiresApproval, cmd).toBe(true)
    }
  })

  it('high-risk command marked high risk', () => {
    expect(run('rm -rf ~/notes').risk).toBe('high')
  })

  it('auto mode allows readonly commands without approval', () => {
    const decision = run('git diff --stat', PermissionMode.AUTO)
    expect(decision.allowed).toBe(true)
    expect(decision.requiresApproval).toBe(false)
    expect(decision.rule).toBe('mode.auto.read_only_command')
  })

  it('auto mode requires approval for scripts, interpreters, builds, and unknown executables', () => {
    for (const command of [
      '/bin/bash payload.sh',
      'python script.py',
      './payload',
      'npm test',
      'npm run build',
      'ls; pwd',
      'pwd > result.txt',
    ]) {
      const decision = run(command, PermissionMode.AUTO)
      expect(decision.allowed, command).toBe(false)
      expect(decision.requiresApproval, command).toBe(true)
      expect(decision.rule, command).toBe('mode.auto.command_approval')
    }
  })

  it('auto mode still requires approval for high-risk commands (audit P1-1)', () => {
    const decision = run('rm -rf ~/x', PermissionMode.AUTO)
    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.risk).toBe('high')
  })

  it('accept_edits mode allows low-risk file edits but still asks before shell and scheduler mutations', () => {
    const policy = new PermissionPolicy()
    const registry = makeRegistry('/tmp/perm-root')

    const edit = policy.assess(
      'write_file',
      { path: 'notes/todo.md' },
      PermissionMode.ACCEPT_EDITS,
      { registry },
    )
    const shell = policy.assess(
      'run_command',
      { command: 'git status' },
      PermissionMode.ACCEPT_EDITS,
      { registry },
    )
    const scheduler = policy.assess(
      'scheduler',
      { action: 'add', message: 'later' },
      PermissionMode.ACCEPT_EDITS,
      { registry },
    )
    const planWrite = policy.assess(
      'write_file',
      { path: 'notes/todo.md' },
      PermissionMode.PLAN,
      { registry },
    )

    expect(edit.allowed).toBe(true)
    expect(edit.rule).toBe('accept_edits.file_edit')
    expect(shell.allowed).toBe(false)
    expect(shell.requiresApproval).toBe(true)
    expect(shell.rule).toBe('accept_edits.run_command.approval')
    expect(scheduler.requiresApproval).toBe(true)
    expect(planWrite.allowed).toBe(false)
  })

  it('accept_edits mode does not auto-approve non-file mutating tools', () => {
    const registry = new ToolRegistry()
    registry.register(new DynamicTool())
    const decision = new PermissionPipeline().assess(
      'dynamic_tool',
      { action: 'mutate' },
      PermissionMode.ACCEPT_EDITS,
      { registry },
    )

    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.rule).toBe('accept_edits.default_approval')
  })

  it('applies user deny rules before mode allow rules', () => {
    const pipeline = new PermissionPipeline({
      rules: [
        {
          id: 'deny-secret-notes',
          action: 'deny',
          tool: 'write_file',
          pathGlob: 'secrets/**',
          reason: 'secret notes are manual',
        },
      ],
    })
    const decision = pipeline.assess(
      'write_file',
      { path: 'secrets/key.md', content: 'x' },
      PermissionMode.ACCEPT_EDITS,
    )

    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(false)
    expect(decision.rule).toBe('user_rule.deny-secret-notes')
    expect(decision.reason).toContain('secret notes are manual')
  })

  it('applies user ask rules and keeps invalid rules in diagnostics', () => {
    const pipeline = new PermissionPipeline({
      rules: [
        {
          id: 'ask-npm',
          action: 'ask',
          tool: 'run_command',
          commandPrefix: 'npm publish',
          reason: 'publishing is explicit',
        },
        { id: '', action: 'allow', tool: 'read_file' },
      ],
    })
    const decision = pipeline.assess(
      'run_command',
      { command: 'npm publish --dry-run' },
      PermissionMode.AUTO,
    )

    expect(decision.allowed).toBe(false)
    expect(decision.requiresApproval).toBe(true)
    expect(decision.rule).toBe('user_rule.ask-npm')
    expect(decision.reason).toContain('publishing is explicit')
    expect(pipeline.diagnostics()).toMatchObject({
      loaded: 1,
      invalid: 1,
    })
  })

  it('supports argument-level plan read-only', () => {
    const registry = new ToolRegistry()
    registry.register(new DynamicTool())
    const pipeline = new PermissionPipeline()

    const inspect = pipeline.assess(
      'dynamic_tool',
      { action: 'inspect' },
      PermissionMode.PLAN,
      { registry },
    )
    const mutate = pipeline.assess(
      'dynamic_tool',
      { action: 'mutate' },
      PermissionMode.PLAN,
      { registry },
    )

    expect(inspect.allowed).toBe(true)
    expect(inspect.rule).toBe('plan.read_only')
    expect(mutate.allowed).toBe(false)
    expect(mutate.rule).toBe('plan.write_block')
  })

  it('denies propose_plan outside plan mode', () => {
    const decision = new PermissionPipeline().assess(
      'propose_plan',
      { title: 'Plan', summary: 'x', plan_markdown: '- Do it' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    expect(decision.allowed).toBe(false)
    expect(decision.rule).toBe('control.propose_plan')
  })
})
