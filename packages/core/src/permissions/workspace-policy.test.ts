import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspacePolicy, workspacePolicyForTool } from './workspace-policy'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('WorkspacePolicy', () => {
  it('allows paths inside the effective workspace and denies lexical escapes', () => {
    const workspace = tmp('emperor-workspace-policy-')
    const policy = new WorkspacePolicy({ workspaceRoot: workspace })

    const allowed = policy.resolvePath('README.md', 'read')
    const denied = policy.resolvePath('../secret.txt', 'read')

    expect(allowed.allowed).toBe(true)
    expect(allowed.resolvedPath).toBe(join(workspace, 'README.md'))
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('outside workspace')
    expect(denied.allowedRoots[0]?.path).toBe(workspace)
  })

  it('denies private state roots even when they sit under the runtime workspace', () => {
    const runtimeRoot = tmp('emperor-workspace-policy-runtime-')
    const stateRoot = join(runtimeRoot, '.emperor')
    mkdirSync(join(stateRoot, 'memory'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'memory', 'MEMORY.local.md'),
      'private',
      'utf8',
    )
    const policy = new WorkspacePolicy({
      workspaceRoot: runtimeRoot,
      stateRoot,
    })

    const denied = policy.resolvePath(
      join(stateRoot, 'memory', 'MEMORY.local.md'),
      'read',
    )

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('denied root')
    expect(denied.denyRoots[0]?.path).toBe(stateRoot)
  })

  it('denies symlink escapes through an existing ancestor', () => {
    const workspace = tmp('emperor-workspace-policy-symlink-')
    const outside = tmp('emperor-workspace-policy-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    symlinkSync(outside, join(workspace, 'out'))
    const policy = new WorkspacePolicy({ workspaceRoot: workspace })

    const denied = policy.resolvePath('out/secret.txt', 'read')

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('outside workspace')
  })

  it('limits a trusted user Skill scope to one named Skill subtree', () => {
    const workspace = tmp('emperor-workspace-policy-project-')
    const emperorHome = tmp('emperor-workspace-policy-home-')
    const userSkillsRoot = join(emperorHome, 'skills')
    const skillRoot = join(userSkillsRoot, 'agent-reach')
    mkdirSync(skillRoot, { recursive: true })
    const policy = workspacePolicyForTool(
      {
        root: emperorHome,
        workspaceRoot: workspace,
        fileExecutionScopes: [
          {
            kind: 'user_skill',
            root: skillRoot,
            skillName: 'agent-reach',
            access: 'write',
          },
        ],
      },
      workspace,
    )

    expect(
      policy.resolvePath(join(skillRoot, 'SKILL.md'), 'write').allowed,
    ).toBe(true)
    expect(
      policy.resolvePath(join(userSkillsRoot, 'other', 'SKILL.md'), 'write')
        .allowed,
    ).toBe(false)
    expect(
      policy.resolvePath(join(emperorHome, 'settings.json'), 'write').allowed,
    ).toBe(false)
  })
})
