import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_MEMORY_END,
  PROJECT_MEMORY_START,
  ProjectStateStore,
} from './state-store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('ProjectStateStore', () => {
  it('keeps private project memory under state root and leaves workspace AGENTS.md untouched', () => {
    const stateRoot = tmp('emperor-project-state-')
    const workspace = tmp('emperor-project-workspace-')
    const workspaceAgents = join(workspace, 'AGENTS.md')
    const legacyText = [
      '# Workspace Instructions',
      '',
      'Do not mutate this file.',
      '',
      PROJECT_MEMORY_START,
      '- legacy private memory',
      PROJECT_MEMORY_END,
      '',
    ].join('\n')
    writeFileSync(workspaceAgents, legacyText, 'utf8')
    const store = new ProjectStateStore(join(stateRoot, 'projects'))

    const ensured = store.ensureProject({
      project_id: 'project_1',
      project_path: workspace,
      project_name: 'workspace',
      summary: '',
      created_at: '2026-07-02T09:00:00+0800',
      updated_at: '2026-07-02T09:00:00+0800',
      version: 1,
    })

    expect(ensured.memory_path).toBe(join(stateRoot, 'projects', 'project_1', 'AGENTS.local.md'))
    expect(ensured.prompt_overlay_path).toBe(join(stateRoot, 'projects', 'project_1', 'prompt-overlay.md'))
    expect(ensured.legacy_agents_path).toBe(workspaceAgents)
    expect(ensured.legacy_imported_at).toBeTruthy()
    expect(readFileSync(workspaceAgents, 'utf8')).toBe(legacyText)
    expect(store.readManagedMemory('project_1')).toContain('legacy private memory')

    store.writeManagedMemory('project_1', '## Project\n\n- state only')

    expect(store.readManagedMemory('project_1')).toContain('state only')
    expect(readFileSync(workspaceAgents, 'utf8')).toBe(legacyText)
    expect(existsSync(ensured.prompt_overlay_path)).toBe(true)
    expect(readFileSync(ensured.project_json_path, 'utf8')).toContain('"memory_path"')
  })

  it('reads allowed project-local collaboration files without writing private state into the workspace', () => {
    const stateRoot = tmp('emperor-project-state-')
    const workspace = tmp('emperor-project-workspace-')
    writeFileSync(join(workspace, 'AGENTS.md'), '# Project Rules\n\n- Use pnpm for this repository.\n', 'utf8')
    mkdirSync(join(workspace, '.emperor', 'rules'), { recursive: true })
    writeFileSync(join(workspace, '.emperor', 'settings.json'), JSON.stringify({ style: 'quiet' }), 'utf8')
    writeFileSync(join(workspace, '.emperor', 'settings.local.json'), JSON.stringify({ local: true }), 'utf8')
    writeFileSync(join(workspace, '.emperor', 'rules', 'build.md'), '# Build Rule\n\nRun make check before handoff.\n', 'utf8')

    const store = new ProjectStateStore(join(stateRoot, 'projects'))
    store.ensureProject({
      project_id: 'project_1',
      project_path: workspace,
      project_name: 'workspace',
      summary: '',
      created_at: '2026-07-02T09:00:00+0800',
      updated_at: '2026-07-02T09:00:00+0800',
      version: 1,
    })

    const context = store.readWorkspaceCollaborationContext('project_1')

    expect(context).toContain('# Workspace AGENTS.md')
    expect(context).toContain('Use pnpm for this repository')
    expect(context).toContain('# Workspace .emperor/settings.json')
    expect(context).toContain('"style": "quiet"')
    expect(context).toContain('# Workspace .emperor/rules/build.md')
    expect(context).toContain('Run make check before handoff')
    expect(existsSync(join(workspace, '.emperor', 'sessions'))).toBe(false)
    expect(existsSync(join(workspace, '.emperor', 'memory'))).toBe(false)
  })
})
