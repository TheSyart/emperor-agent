/**
 * 权限管线/策略契约 (MIG-CTRL-014/015/016/017)。
 * 移植 Python: tests/unit/test_permissions.py (policy 部分) + tests/unit/test_permission_pipeline_v2.py (pipeline 部分)。
 * 注: PE-13 (高风险即使有 plan token 仍审批) 在 control.test.ts 经 ControlManager.assessPermission 验证。
 */
import { describe, expect, it } from 'vitest'
import { PermissionMode } from './models'
import { PermissionPipeline } from './pipeline'
import { PermissionPolicy } from './policy'
import {
  ApplyPatchTool,
  DeleteFileTool,
  ReadFileTool,
  RenameFileTool,
  WriteFileTool,
} from '../tools/filesystem'
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
  registry.register(new ApplyPatchTool(root))
  registry.register(new DeleteFileTool(root))
  registry.register(new RenameFileTool(root))
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

  it('allows exact patches but requires approval for delete and rename mutations', () => {
    const registry = makeRegistry(root)
    const policy = new PermissionPolicy()
    expect(
      policy.assess(
        'apply_patch',
        { path: 'src/a.ts', old_text: 'a', new_text: 'b' },
        PermissionMode.ACCEPT_EDITS,
        { registry },
      ),
    ).toMatchObject({ allowed: true, requiresApproval: false })
    expect(
      policy.assess(
        'delete_file',
        { path: 'src/a.ts' },
        PermissionMode.ASK_BEFORE_EDIT,
        { registry },
      ),
    ).toMatchObject({ allowed: false, requiresApproval: true })
    expect(
      policy.assess(
        'rename_file',
        { source: 'src/a.ts', destination: 'src/b.ts' },
        PermissionMode.ACCEPT_EDITS,
        { registry },
      ),
    ).toMatchObject({ allowed: false, requiresApproval: true })
  })

  it('matches rename permission rules against both source and destination', () => {
    const registry = makeRegistry(root)
    const decision = new PermissionPipeline({
      rules: [
        {
          id: 'deny-dotenv-rename',
          action: 'deny',
          tool: 'rename_file',
          pathGlob: '.env',
        },
      ],
    }).assess(
      'rename_file',
      { source: 'safe.txt', destination: '.env' },
      PermissionMode.AUTO,
      { registry },
    )

    expect(decision).toMatchObject({
      allowed: false,
      rule: 'user_rule.deny-dotenv-rename',
    })
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

  it('resolves every matching rule with deny > ask > allow independent of input order', () => {
    const pipeline = new PermissionPipeline({
      rules: [
        {
          id: 'allow-git',
          action: 'allow',
          tool: 'run_command',
          commandPrefix: 'git',
        },
        {
          id: 'deny-push',
          action: 'deny',
          tool: 'run_command',
          commandPrefix: 'git push',
          reason: 'push is managed manually',
        },
        {
          id: 'ask-push',
          action: 'ask',
          tool: 'run_command',
          commandPrefix: 'git push',
        },
      ],
    })

    const decision = pipeline.assess(
      'run_command',
      { command: 'git push origin main' },
      PermissionMode.ASK_BEFORE_EDIT,
    )

    expect(decision).toMatchObject({
      allowed: false,
      requiresApproval: false,
      rule: 'user_rule.deny-push',
      explanation: {
        version: 1,
        selected: {
          id: 'deny-push',
          action: 'deny',
          source: { kind: 'local_config', trust: 'user' },
        },
        candidates: [
          expect.objectContaining({ id: 'deny-push', matched: true }),
          expect.objectContaining({ id: 'ask-push', matched: true }),
          expect.objectContaining({ id: 'allow-git', matched: true }),
        ],
      },
    })
  })

  it('does not let a lower-trust allow relax a higher-trust ask candidate', () => {
    const pipeline = new PermissionPipeline({
      layers: [
        {
          source: {
            kind: 'managed_policy',
            id: 'enterprise',
            trust: 'managed',
          },
          rules: [
            {
              id: 'managed-ask-publish',
              action: 'ask',
              tool: 'run_command',
              commandPrefix: 'npm publish',
            },
          ],
        },
        {
          source: {
            kind: 'project',
            id: 'repo',
            trust: 'project',
          },
          rules: [
            {
              id: 'project-allow-publish',
              action: 'allow',
              tool: 'run_command',
              commandPrefix: 'npm publish',
            },
          ],
        },
      ],
    })

    const decision = pipeline.assess(
      'run_command',
      { command: 'npm publish' },
      PermissionMode.ASK_BEFORE_EDIT,
    )

    expect(decision.requiresApproval).toBe(true)
    expect(decision.rule).toBe('user_rule.managed-ask-publish')
    expect(decision.explanation?.candidates).toEqual([
      expect.objectContaining({
        id: 'managed-ask-publish',
        precedence: 'ask:managed:2:0',
      }),
      expect.objectContaining({
        id: 'project-allow-publish',
        precedence: 'allow:project:2:1',
      }),
    ])
  })

  it('accepts only tightening rules from an untrusted project layer', () => {
    const pipeline = new PermissionPipeline({
      layers: [
        {
          source: {
            kind: 'project',
            id: 'untrusted-repo',
            trust: 'untrusted',
          },
          rules: [
            {
              id: 'project-allow-write',
              action: 'allow',
              tool: 'write_file',
              pathGlob: 'src/**',
            },
            {
              id: 'project-deny-secrets',
              action: 'deny',
              tool: 'write_file',
              pathGlob: 'src/secrets/**',
            },
          ],
        },
      ],
    })

    const ordinary = pipeline.assess(
      'write_file',
      { path: 'src/index.ts', content: 'ok' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    const secret = pipeline.assess(
      'write_file',
      { path: 'src/secrets/key.ts', content: 'no' },
      PermissionMode.ACCEPT_EDITS,
    )

    expect(ordinary.rule).not.toBe('user_rule.project-allow-write')
    expect(secret).toMatchObject({
      allowed: false,
      rule: 'user_rule.project-deny-secrets',
      explanation: {
        selected: {
          source: { kind: 'project', trust: 'untrusted' },
        },
      },
    })
  })

  it('keeps Plan denial and automatic shell approval as system constraints', () => {
    const pipeline = new PermissionPipeline({
      rules: [
        {
          id: 'allow-every-command',
          action: 'allow',
          tool: 'run_command',
          commandPrefix: '',
          access: 'execute',
        },
        {
          id: 'allow-write',
          action: 'allow',
          tool: 'write_file',
          pathGlob: '**',
        },
      ],
    })

    const auto = pipeline.assess(
      'run_command',
      { command: 'node script.js' },
      PermissionMode.AUTO,
    )
    const plan = pipeline.assess(
      'write_file',
      { path: 'src/x.ts', content: 'x' },
      PermissionMode.PLAN,
    )

    expect(auto).toMatchObject({
      allowed: false,
      requiresApproval: true,
      rule: 'mode.auto.command_approval',
      explanation: {
        selected: {
          source: { kind: 'core_policy', trust: 'system' },
        },
      },
    })
    expect(plan).toMatchObject({
      allowed: false,
      requiresApproval: false,
      rule: 'plan.write_block',
      explanation: {
        selected: {
          source: { kind: 'core_policy', trust: 'system' },
        },
      },
    })
  })

  it('attaches a stable redacted shell AST explanation to run_command decisions', () => {
    const first = run('git status | tee private-status.txt')
    const second = run('git status | tee private-status.txt')

    expect(second.explanation).toEqual(first.explanation)
    expect(second.explanation?.shell).toMatchObject({
      parser: 'emperor-shell-ast-v1',
      status: 'parsed',
      features: ['pipeline'],
      commandCount: 2,
      readonly: false,
    })
    expect(JSON.stringify(second.explanation)).not.toContain(
      'private-status.txt',
    )
  })

  it('fails closed when the shell classifier capability crashes', () => {
    const pipeline = new PermissionPipeline({
      shellAnalyzer: () => {
        throw new Error('parser service unavailable')
      },
    })

    const decision = pipeline.assess(
      'run_command',
      { command: 'git status' },
      PermissionMode.AUTO,
    )

    expect(decision).toMatchObject({
      allowed: false,
      requiresApproval: true,
      rule: 'mode.auto.command_approval',
      explanation: {
        shell: {
          status: 'invalid',
          reasonCodes: ['parser_failure'],
          readonly: false,
        },
      },
    })
    expect(JSON.stringify(decision.explanation)).not.toContain(
      'parser service unavailable',
    )
  })

  it('keeps permission rule source trust out of rule-controlled config data', () => {
    const spoofedRule = {
      id: 'spoof-system',
      action: 'deny' as const,
      tool: 'write_file',
      access: 'write',
      source: { kind: 'managed_policy', id: 'spoof', trust: 'system' },
      trust: 'system',
    }
    const pipeline = new PermissionPipeline({ rules: [spoofedRule] })

    const decision = pipeline.assess(
      'write_file',
      { path: 'README.md', content: 'x' },
      PermissionMode.ACCEPT_EDITS,
    )

    expect(decision.explanation?.selected).toMatchObject({
      id: 'spoof-system',
      source: {
        kind: 'local_config',
        id: 'emperor.local.json',
        trust: 'user',
      },
    })
  })

  it('matches command rules on AST word boundaries and normalized quoted argv', () => {
    const allowPipeline = new PermissionPipeline({
      rules: [
        {
          id: 'allow-status',
          action: 'allow',
          tool: 'run_command',
          commandPrefix: 'git status',
        },
      ],
    })
    const denyPipeline = new PermissionPipeline({
      rules: [
        {
          id: 'deny-push',
          action: 'deny',
          tool: 'run_command',
          commandPrefix: 'git push',
        },
      ],
    })

    const falsePrefix = allowPipeline.assess(
      'run_command',
      { command: 'git status-evil' },
      PermissionMode.ASK_BEFORE_EDIT,
    )
    const quotedDeny = denyPipeline.assess(
      'run_command',
      { command: `g'i't pu'sh' origin main` },
      PermissionMode.ASK_BEFORE_EDIT,
    )

    expect(falsePrefix.allowed).toBe(false)
    expect(falsePrefix.rule).not.toBe('user_rule.allow-status')
    expect(quotedDeny).toMatchObject({
      allowed: false,
      requiresApproval: false,
      rule: 'user_rule.deny-push',
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
