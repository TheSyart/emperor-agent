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
      lifecycle: () => ({
        state: 'ready',
        failedServiceId: null,
        failedPhase: null,
        services: [
          {
            id: 'scheduler',
            required: true,
            dependsOn: ['session-runtime'],
            state: 'ready',
            error: null,
          },
        ],
      }),
      subagents: () => ({
        active: 2,
        maxGlobal: 6,
        maxPerSession: 3,
        bySession: { session_1: 2 },
        taskIds: ['subagent_1', 'subagent_2'],
      }),
      agentDefinitions: () =>
        ({
          schemaVersion: 1,
          revision: 'agents-r1',
          sources: [
            {
              id: 'emperor-builtin-agents',
              kind: 'builtin',
              trust: 'system',
              active: true,
            },
          ],
          agents: [{ definition: { name: 'sili_suitang' } }],
          aliases: { researcher: 'dongchang_tanshi' },
          diagnostics: [],
        }) as never,
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
      hybridMemory: () => ({
        capability: {
          requestedMode: 'on',
          effectiveMode: 'eval',
          promptMutationAllowed: false,
          reason: 'embedding_unavailable',
          evaluationDatasetSha256: null,
          embeddingProviderId: null,
        },
        indexPath: join(root, 'memory', 'hybrid-index', 'index.v1.json'),
        searches: 3,
        promptMutations: 0,
        embeddingFallbacks: 1,
        lastStrategy: 'fts_fallback',
        lastResultCount: 4,
        lastSourceDigest: 'a'.repeat(64),
        derivedDiskBytes: 4096,
      }),
      codeIntelligence: () => ({
        capability: {
          requestedMode: 'on',
          effectiveMode: 'eval',
          toolAllowed: false,
          reason: 'gate_missing',
          evaluationDatasetSha256: null,
          parserRevision: 'typescript-5.9-code-graph-v1',
        },
        graphManagers: 0,
        queries: 0,
        lspQueries: 0,
        graphFallbacks: 0,
        notifications: 0,
        lastStrategy: null,
        lastLatencyMs: null,
        graph: {
          state: 'idle',
          version: 0,
          indexedFiles: 0,
          sourceBytes: 0,
          parserLoads: 0,
          parseErrors: 0,
          skippedOversized: 0,
          skippedSymlinks: 0,
          skippedBinary: 0,
          skippedUnsupported: 0,
          skippedCapacity: 0,
          oversizedFileGateVerified: false,
          cacheStatus: 'not_checked',
          cacheBytes: 0,
        },
        lsp: [],
      }),
      activeTasks: () => [{ id: 'turn:1', status: 'running' }],
      sessionRuntimes: () => [
        {
          sessionId: 'session_1',
          running: true,
          queued: 1,
          closed: false,
          commandReceipts: 2,
          pendingInterjections: 0,
          interjectionReceipts: 0,
          illegalTransitions: 0,
          lastUsed: 4,
        },
      ],
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
    expect(payload.lifecycle).toMatchObject({
      state: 'ready',
      services: [{ id: 'scheduler', state: 'ready' }],
    })
    expect(payload.subagents).toEqual({
      active: 2,
      maxGlobal: 6,
      maxPerSession: 3,
      bySession: { session_1: 2 },
      taskIds: ['subagent_1', 'subagent_2'],
    })
    expect(payload.agentDefinitions).toMatchObject({
      schemaVersion: 1,
      revision: 'agents-r1',
      sources: [{ kind: 'builtin', trust: 'system', active: true }],
      agents: [{ definition: { name: 'sili_suitang' } }],
      diagnostics: [],
    })
    expect(payload.effectiveConfig).toMatchObject({
      revision: 'a'.repeat(64),
      entries: [{ key: 'sandbox.runtime' }],
    })
    expect(payload.hybridMemory).toMatchObject({
      capability: {
        requestedMode: 'on',
        effectiveMode: 'eval',
        reason: 'embedding_unavailable',
      },
      searches: 3,
      promptMutations: 0,
      embeddingFallbacks: 1,
    })
    expect(payload.codeIntelligence).toMatchObject({
      capability: {
        requestedMode: 'on',
        effectiveMode: 'eval',
        toolAllowed: false,
        reason: 'gate_missing',
      },
      graphManagers: 0,
      graph: { state: 'idle', indexedFiles: 0 },
      lsp: [],
    })
    expect(payload.activeTasks).toHaveLength(1)
    expect(payload.sessionRuntimes).toEqual([
      expect.objectContaining({ sessionId: 'session_1', running: true }),
    ])
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
        processesRoot: join(stateRoot, 'processes'),
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
})
