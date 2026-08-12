import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillManager } from '../skills/manager'
import type { ToolExecutionContext } from './base'
import { ManageSkillTool } from './manage-skill'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-manage-skill-capability-'))
  const manager = new SkillManager({
    runtimeRoot: root,
    stateRoot: join(root, 'state'),
  })
  return { root, manager, tool: new ManageSkillTool(manager) }
}

describe('manage_skill managed path capability', () => {
  it('rejects direct execution when the trusted runtime capability is absent', () => {
    const { root, tool } = fixture()
    const args = {
      action: 'create',
      name: 'release-audit',
      description: 'Audit release evidence.',
    }

    expect(
      tool.execute(args, {
        root,
        workspaceRoot: root,
        arguments: args,
      }),
    ).toContain('authorization_missing')
  })

  it('binds authorization to tool, action, arguments and the host-owned root', () => {
    const { root, tool } = fixture()
    const args = {
      action: 'create',
      name: 'release-audit',
      description: 'Audit release evidence.',
    }
    const capability = tool.issueManagedPathCapability(args)
    const context: ToolExecutionContext = {
      root,
      workspaceRoot: root,
      arguments: args,
      managedPathCapability: capability,
    }

    expect(tool.execute(args, context)).toContain('"valid": true')
    expect(
      tool.execute(
        { ...args, name: 'forged-name' },
        { ...context, arguments: { ...args, name: 'forged-name' } },
      ),
    ).toContain('authorization_missing')
    expect(JSON.stringify(capability)).not.toContain(root)
  })

  it('leaves name and symlink containment enforcement to the managed store', () => {
    const { root, tool } = fixture()
    const args = {
      action: 'create',
      name: '../escape',
      description: 'Must not leave the managed root.',
    }

    expect(
      tool.execute(args, {
        root,
        workspaceRoot: root,
        arguments: args,
        managedPathCapability: tool.issueManagedPathCapability(args),
      }),
    ).toContain('Skill name must use lowercase letters')
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })
})
