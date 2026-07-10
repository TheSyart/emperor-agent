import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreDiagnosticsService } from './diagnostics-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreDiagnosticsService (MIG-IPC-007 / MIG-APP-002)', () => {
  it('summarizes diagnostics without mutating missing or corrupt config files', async () => {
    const root = tmp('emperor-diagnostics-service-')
    writeFileSync(join(root, 'emperor.local.json'), '{bad json', 'utf8')
    writeFileSync(
      join(root, 'emperor.local.json.corrupt-1'),
      '{old bad json',
      'utf8',
    )
    mkdirSync(join(root, 'desktop', 'out', 'renderer'), { recursive: true })
    writeFileSync(
      join(root, 'desktop', 'out', 'renderer', 'index.html'),
      '<html></html>',
      'utf8',
    )
    const service = new CoreDiagnosticsService(root, {
      schedulerDiagnostics: () => ({
        jobsFile: join(root, 'scheduler', 'jobs.json'),
      }),
      runtimeStats: () => ({ events: 2, archiveFiles: 1 }),
      externalPayload: () => ({ running: true, store: { exists: true } }),
      activeTasks: () => [{ id: 'turn:1', status: 'running' }],
      desktopPetPayload: async () => ({ enabled: false, running: false }),
    })

    const payload = await service.payload()

    expect(existsSync(join(root, 'model_config.json'))).toBe(false)
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(true)
    expect(payload.modelConfig).toMatchObject({
      path: join(root, 'model_config.json'),
      exists: false,
      status: 'missing',
      error: '',
    })
    expect(payload.localConfig).toMatchObject({
      path: join(root, 'emperor.local.json'),
      exists: true,
      status: 'corrupt',
    })
    expect((payload.localConfig as any).corruptBackups).toEqual([
      expect.objectContaining({
        path: join(root, 'emperor.local.json.corrupt-1'),
      }),
    ])
    expect(payload.scheduler).toMatchObject({
      jobsFile: join(root, 'scheduler', 'jobs.json'),
    })
    expect(payload.runtime).toMatchObject({ events: 2, archiveFiles: 1 })
    expect(payload.external).toMatchObject({ running: true })
    expect(payload.activeTasks).toHaveLength(1)
    expect(payload.desktopPet).toMatchObject({ enabled: false, running: false })
    expect(payload.dependencies).toMatchObject({
      nodeRuntime: true,
      desktopRenderer: true,
      desktopPetModules: false,
    })
  })

  it('reports the effective workspace fence separately from runtime paths', async () => {
    const root = tmp('emperor-diagnostics-workspace-policy-')
    const workspace = join(root, 'project')
    const stateRoot = join(root, '.emperor')
    const service = new CoreDiagnosticsService(root, {
      runtimePaths: {
        runtimeRoot: root,
        stateRoot,
        stateRootSource: 'explicit',
        templatesDir: join(root, 'templates'),
        skillsDir: join(root, 'skills'),
        assetsDir: join(root, 'assets'),
        memoryRoot: join(stateRoot, 'memory'),
        sessionsRoot: join(stateRoot, 'sessions'),
        projectsRoot: join(stateRoot, 'projects'),
        attachmentsRoot: join(stateRoot, 'memory', 'attachments'),
        mediaRoot: join(stateRoot, 'memory', 'media'),
        teamRoot: join(stateRoot, 'team'),
        tokensFile: join(stateRoot, 'tokens', 'tokens.jsonl'),
        schedulerRoot: join(stateRoot, 'scheduler'),
        tasksRoot: join(stateRoot, 'tasks'),
        controlRoot: join(stateRoot, 'control'),
        externalRoot: join(stateRoot, 'external'),
      },
      workspacePolicy: () => ({
        workspaceRoot: workspace,
        stateRoot,
        allowRoots: [{ path: workspace, label: 'workspace' }],
        denyRoots: [{ path: stateRoot, label: 'state' }],
        readOnlyRoots: [],
        outsideWorkspace: 'deny',
      }),
    })

    const payload = await service.payload()

    expect(payload.paths).toMatchObject({ runtimeRoot: root, stateRoot })
    expect(payload.paths).toMatchObject({
      attachmentsRoot: join(stateRoot, 'memory', 'attachments'),
      mediaRoot: join(stateRoot, 'memory', 'media'),
      mcpConfigPath: join(stateRoot, 'mcp_config.json'),
      runtimeManifestPath: join(root, 'runtime-manifest.json'),
      legacyRuntimeSkillsReceiptPath: join(
        stateRoot,
        'migrations',
        'legacy-runtime-skills.json',
      ),
    })
    expect(payload.workspacePolicy).toMatchObject({
      workspaceRoot: workspace,
      stateRoot,
      outsideWorkspace: 'deny',
      allowRoots: [{ path: workspace, label: 'workspace' }],
      denyRoots: [{ path: stateRoot, label: 'state' }],
    })
  })

  it('exposes the legacy state migration report when supplied, and a safe empty default otherwise', async () => {
    const root = tmp('emperor-diagnostics-legacy-migration-')

    const withoutMigration = await new CoreDiagnosticsService(
      root,
      {},
    ).payload()
    expect(withoutMigration.legacyStateMigration).toEqual({
      legacyStateRoots: [],
      copied: 0,
      skipped: 0,
    })

    const withMigration = await new CoreDiagnosticsService(root, {
      legacyStateMigration: {
        copied: 3,
        skipped: 1,
        logPath: join(root, '.emperor', 'migration-log.jsonl'),
        reportPath: join(
          root,
          '.emperor',
          'migrations',
          'state-root-migration.json',
        ),
        entries: [],
        legacyStateRoots: [
          {
            path: join(root, 'memory'),
            kind: 'ancient-bare-runtime-root',
            existed: false,
          },
          {
            path: join(root, '.emperor'),
            kind: 'previous-dotemperor-root',
            existed: true,
          },
        ],
      },
    }).payload()
    expect(withMigration.legacyStateMigration).toMatchObject({
      copied: 3,
      skipped: 1,
      reportPath: join(
        root,
        '.emperor',
        'migrations',
        'state-root-migration.json',
      ),
      legacyStateRoots: [
        {
          path: join(root, 'memory'),
          kind: 'ancient-bare-runtime-root',
          existed: false,
        },
        {
          path: join(root, '.emperor'),
          kind: 'previous-dotemperor-root',
          existed: true,
        },
      ],
    })
  })
})
