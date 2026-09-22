import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRuntimePaths } from '../../runtime/paths'
import { CoreDiagnosticsService } from './diagnostics-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreDiagnosticsService (MIG-IPC-007 / MIG-APP-002)', () => {
  it('summarizes diagnostics without mutating missing or corrupt config files', async () => {
    const root = tmp('emperor-diagnostics-service-')
    writeFileSync(join(root, 'settings.json'), '{bad json', 'utf8')
    writeFileSync(
      join(root, 'settings.json.corrupt-1'),
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
      subagents: () => [
        {
          id: 'child_1',
          parentId: 'session_1',
          description: 'explore repo',
          mode: 'spawn',
          depth: 1,
          createdAt: 3,
          status: 'running',
        },
      ],
      kernel: () => ({
        activeAgents: 2,
        busySessions: ['session_1'],
        sandbox: { backend: 'macos-seatbelt', available: true },
        modelRoutes: [{ entryId: 'primary', protocol: 'openai' }],
      }),
      effectiveConfig: async () => ({
        schemaVersion: 1,
        revision: 'a'.repeat(64),
        entries: [
          {
            key: 'sandbox.runtime',
            value: { command: 'required' },
            source: {
              kind: 'builtin',
              id: 'sandbox.runtime:builtin',
              trust: 'trusted',
            },
            trust: 'trusted',
            trace: [],
            secretSources: [],
          },
        ],
      }),
      commandCatalog: () => ({
        status: 'warning',
        registeredSkills: 1,
        conflicts: [
          {
            token: 'new',
            skillName: 'new',
            source: 'user',
            reason: 'builtin_collision',
            winnerSkillName: null,
            winnerSource: 'builtin',
          },
        ],
      }),
      activeTasks: () => [{ id: 'turn:1', status: 'running' }],
      desktopPetPayload: async () => ({ enabled: false, running: false }),
      environmentSummary: async () => ({
        platform: 'darwin',
        required: 4,
        ready: 3,
        activeJob: null,
      }),
      goalDiagnostics: () => ({
        root: join(root, '.emperor', 'goals'),
        recoveryRequired: 1,
        issues: [{ goalId: 'goal_1', code: 'event_corrupt' }],
      }),
    })

    const payload = await service.payload()

    expect(existsSync(join(root, 'model_config.json'))).toBe(false)
    expect(existsSync(join(root, 'settings.json'))).toBe(true)
    expect(payload.modelConfig).toMatchObject({
      path: join(root, 'model_config.json'),
      exists: false,
      status: 'missing',
      error: '',
    })
    expect(payload.localConfig).toMatchObject({
      path: join(root, 'settings.json'),
      exists: true,
      status: 'corrupt',
    })
    expect((payload.localConfig as any).corruptBackups).toEqual([
      expect.objectContaining({
        path: join(root, 'settings.json.corrupt-1'),
      }),
    ])
    expect(payload.scheduler).toMatchObject({
      jobsFile: join(root, 'scheduler', 'jobs.json'),
    })
    expect(payload.runtime).toMatchObject({ events: 2, archiveFiles: 1 })
    expect(payload.subagents).toEqual([
      expect.objectContaining({ id: 'child_1', status: 'running', depth: 1 }),
    ])
    expect(payload.kernel).toMatchObject({
      activeAgents: 2,
      busySessions: ['session_1'],
      sandbox: { backend: 'macos-seatbelt', available: true },
    })
    expect(payload).not.toHaveProperty('lifecycle')
    expect(payload).not.toHaveProperty('agentDefinitions')
    expect(payload).not.toHaveProperty('hybridMemory')
    expect(payload).not.toHaveProperty('codeIntelligence')
    expect(payload).not.toHaveProperty('sessionRuntimes')
    expect(payload.effectiveConfig).toMatchObject({
      revision: 'a'.repeat(64),
      entries: [{ key: 'sandbox.runtime' }],
    })
    expect(payload.commandCatalog).toMatchObject({
      status: 'warning',
      registeredSkills: 1,
      conflicts: [{ token: 'new', reason: 'builtin_collision' }],
    })
    expect(payload.activeTasks).toHaveLength(1)
    expect(payload.desktopPet).toMatchObject({ enabled: false, running: false })
    expect(payload.environment).toEqual({
      platform: 'darwin',
      required: 4,
      ready: 3,
      activeJob: null,
    })
    expect(payload.goals).toEqual({
      root: join(root, '.emperor', 'goals'),
      recoveryRequired: 1,
      issues: [{ goalId: 'goal_1', code: 'event_corrupt' }],
    })
    expect(payload.environment).not.toHaveProperty('logs')
    expect(payload.dependencies).toMatchObject({
      nodeRuntime: true,
      desktopRenderer: true,
      desktopPetModules: false,
    })
    expect(payload.optionalCapabilities.map((item) => item.id)).toEqual([
      'watchlist',
    ])
    expect(payload.promptSnapshots).toEqual({ count: 0, recent: [] })
    expect(payload.localConfig).not.toHaveProperty('permissions')
    expect(JSON.stringify(payload.optionalCapabilities)).not.toContain(root)
  })

  it('reports the effective workspace fence separately from runtime paths', async () => {
    const root = tmp('emperor-diagnostics-workspace-policy-')
    const workspace = join(root, 'project')
    const stateRoot = join(root, '.emperor')
    const service = new CoreDiagnosticsService(root, {
      runtimePaths: resolveRuntimePaths(root, { stateRoot }),
      workspacePolicy: () => ({
        workspaceRoot: workspace,
        stateRoot,
        allowRoots: [{ path: workspace, label: 'workspace' }],
        denyRoots: [{ path: stateRoot, label: 'state' }],
        readOnlyRoots: [],
        outsideWorkspace: 'deny',
      }),
      sandboxCapability: () => ({
        platform: 'darwin',
        backend: 'macos-seatbelt',
        status: 'available',
        filesystem: 'workspace-write',
        network: 'policy-controlled',
        processTree: true,
        reason: 'probe passed',
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
    expect(payload.sandbox).toEqual({
      platform: 'darwin',
      backend: 'macos-seatbelt',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
      reason: 'probe passed',
    })
  })

  it('reports workspace mcporter config without claiming ownership or deleting it', async () => {
    const root = tmp('emperor-diagnostics-external-tool-config-')
    const workspaceConfig = join(root, 'project', 'config', 'mcporter.json')
    mkdirSync(join(root, 'project', 'config'), { recursive: true })
    writeFileSync(workspaceConfig, '{"mcpServers":{}}', 'utf8')
    const service = new CoreDiagnosticsService(root, {
      externalToolConfig: () => ({
        mcporter: {
          workspacePath: workspaceConfig,
          workspacePathExists: true,
          workspacePathOwnedByEmperor: false,
          autoCleanupAllowed: false,
        },
      }),
    })

    const payload = await service.payload()

    expect(payload.externalToolConfig).toMatchObject({
      mcporter: {
        workspacePath: workspaceConfig,
        workspacePathExists: true,
        workspacePathOwnedByEmperor: false,
        autoCleanupAllowed: false,
      },
    })
    expect(readFileSync(workspaceConfig, 'utf8')).toBe('{"mcpServers":{}}')
  })

  it('contains Environment probe failures without leaking diagnostics internals', async () => {
    const payload = await new CoreDiagnosticsService(tmp('emperor-diag-env-'), {
      environmentSummary: async () => {
        throw new Error('secret executable path')
      },
    }).payload()

    expect(payload.environment).toEqual({
      status: 'unavailable',
      error: {
        code: 'internal_error',
        message: '发生内部错误，请查看日志。',
      },
    })
    expect(JSON.stringify(payload.environment)).not.toContain('secret')
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

  it('contains kernel/subagent probe failures and defaults them to empty', async () => {
    const root = tmp('emperor-diagnostics-kernel-')
    const empty = await new CoreDiagnosticsService(root, {}).payload()
    expect(empty.subagents).toEqual([])
    expect(empty.kernel).toEqual({})

    const failing = await new CoreDiagnosticsService(root, {
      subagents: () => {
        throw new Error('manager disposed')
      },
      kernel: () => {
        throw new Error('secret kernel detail')
      },
    }).payload()
    expect(failing.subagents).toEqual([])
    expect(failing.kernel).toMatchObject({ status: 'unavailable' })
    expect(JSON.stringify(failing.kernel)).not.toContain('secret')
  })

  it('keeps diagnostics available when the command catalog cannot be scanned', async () => {
    const root = tmp('emperor-diagnostics-command-catalog-')
    const service = new CoreDiagnosticsService(root, {
      commandCatalog: () => {
        throw new Error('catalog scan failed')
      },
    })

    await expect(service.payload()).resolves.toMatchObject({
      commandCatalog: {
        status: 'unavailable',
        error: {
          code: 'internal_error',
          message: '发生内部错误，请查看日志。',
        },
        registeredSkills: 0,
        conflicts: [],
      },
    })
  })
})
