import { describe, expect, it } from 'vitest'
import type { DiagnosticsPayload } from '../../types'
import {
  diagnosticRows,
  diagnosticStatusTone,
  diagnosticStatusText,
} from './diagnosticsPanelModel'

describe('diagnostics panel model', () => {
  it('classifies diagnostics statuses for operational scanning', () => {
    expect(diagnosticStatusTone('ok')).toBe('ok')
    expect(diagnosticStatusTone('missing')).toBe('warn')
    expect(diagnosticStatusTone('corrupt')).toBe('error')
    expect(diagnosticStatusTone('invalid')).toBe('error')
    expect(diagnosticStatusTone('unknown')).toBe('muted')

    expect(diagnosticStatusText('ok')).toBe('正常')
    expect(diagnosticStatusText('missing')).toBe('缺失')
    expect(diagnosticStatusText('corrupt')).toBe('损坏')
  })

  it('projects config, runtime, and dependency diagnostics into stable rows', () => {
    const payload: DiagnosticsPayload = {
      root: '/repo',
      paths: {
        runtimeRoot: '/repo',
        stateRoot: '/Users/me/.emperor-agent',
        stateRootSource: 'default',
        sessionsRoot: '/Users/me/.emperor-agent/sessions',
        attachmentsRoot: '/Users/me/.emperor-agent/memory/attachments',
        mcpConfigPath: '/Users/me/.emperor-agent/mcp_config.json',
      },
      modelConfig: {
        path: '/repo/model_config.json',
        exists: false,
        status: 'missing',
        error: '',
      },
      localConfig: {
        path: '/repo/emperor.local.json',
        exists: true,
        status: 'corrupt',
        error: 'Unexpected token',
        corruptBackups: [
          { path: '/repo/emperor.local.json.corrupt-1', bytes: 16 },
        ],
      },
      scheduler: {
        lastActionErrors: [{ line: 2 }],
        corruptActionFiles: [
          { path: '/repo/scheduler/action.corrupt-1.jsonl', bytes: 9 },
        ],
      },
      runtime: {
        events: 4,
        archiveFiles: 2,
        needsRotation: false,
      },
      workspacePolicy: {
        workspaceRoot: '/repo/project',
        stateRoot: '/repo/.emperor',
        allowRoots: [{ path: '/repo/project', label: 'workspace' }],
        denyRoots: [{ path: '/repo/.emperor', label: 'state' }],
        outsideWorkspace: 'deny',
      },
      sandbox: {
        platform: 'darwin',
        backend: 'macos-seatbelt',
        status: 'available',
        filesystem: 'workspace-write',
        network: 'policy-controlled',
        processTree: true,
        reason: 'probe passed',
      },
      processRuntime: {
        platform: 'darwin',
        ownership: true,
        leases: true,
        reparent: true,
        orphanReconcile: true,
        stableProcessIdentity: true,
        processTree: 'process_group',
        terminal: { interactiveStdio: true, pty: false, resize: false },
        outputQuota: {
          defaultBytes: 65_536,
          maximumBytes: 8_388_608,
          defaultStrategy: 'terminate',
        },
      },
      hybridMemory: {
        capability: {
          requestedMode: 'on',
          effectiveMode: 'eval',
          promptMutationAllowed: false,
          reason: 'embedding_unavailable',
          evaluationDatasetSha256: null,
          embeddingProviderId: null,
        },
        indexPath: '/Users/me/.emperor-agent/memory/hybrid-index/index.v1.json',
        searches: 3,
        promptMutations: 0,
        embeddingFallbacks: 1,
        lastStrategy: 'fts_fallback',
        lastResultCount: 4,
        lastSourceDigest: 'abcdef0123456789',
        derivedDiskBytes: 4096,
      },
      codeIntelligence: {
        capability: {
          requestedMode: 'on',
          effectiveMode: 'eval',
          toolAllowed: false,
          reason: 'gate_missing',
          evaluationDatasetSha256: null,
          parserRevision: 'typescript-5.9-code-graph-v1',
        },
        graphManagers: 1,
        queries: 12,
        lspQueries: 2,
        graphFallbacks: 3,
        notifications: 4,
        lastStrategy: 'graph_fallback',
        lastLatencyMs: 8.5,
        graph: {
          state: 'ready',
          indexedFiles: 120,
          sourceBytes: 8192,
          parserLoads: 1,
          parseErrors: 0,
          skippedOversized: 1,
          skippedSymlinks: 2,
          skippedBinary: 0,
          skippedUnsupported: 5,
          oversizedFileGateVerified: true,
          cacheStatus: 'loaded',
          cacheBytes: 4096,
        },
        lsp: [
          {
            descriptorId: 'typescript-language-server',
            sourceKind: 'managed',
            state: 'ready',
            starts: 1,
            restarts: 0,
            crashes: 0,
            pendingRequests: 0,
            openDocuments: 1,
            ignoredNotifications: 0,
            protocolErrors: 0,
          },
        ],
      },
      lifecycle: {
        state: 'ready',
        failedServiceId: null,
        failedPhase: null,
        services: [
          { id: 'process-runtime', required: true, state: 'ready' },
          { id: 'code-intelligence', required: true, state: 'ready' },
          { id: 'task-runtime', required: true, state: 'ready' },
          { id: 'subagent-supervisor', required: true, state: 'ready' },
          { id: 'session-runtime', required: true, state: 'ready' },
          { id: 'mcp', required: true, state: 'ready' },
          { id: 'scheduler', required: true, state: 'ready' },
        ],
      },
      subagents: {
        active: 2,
        maxGlobal: 6,
        maxPerSession: 3,
        bySession: { session_1: 2 },
        taskIds: ['subagent_1', 'subagent_2'],
      },
      agentDefinitions: {
        revision: 'agents-r1',
        sources: [
          {
            id: 'emperor-builtin-agents',
            kind: 'builtin',
            trust: 'system',
            active: true,
          },
        ],
        agents: [
          { definition: { name: 'sili_suitang' } },
          { definition: { name: 'neiguan_yingzao' } },
        ],
        diagnostics: [],
      },
      effectiveConfig: {
        schemaVersion: 1,
        revision: 'config-r1',
        entries: [
          {
            key: 'mcp.config',
            value: {
              servers: {
                docs: { headers: '[REDACTED]', enabled: true },
              },
            },
            source: {
              kind: 'user',
              id: 'mcp_config.json',
              trust: 'trusted',
            },
            trust: 'trusted',
            trace: [
              {
                source: { kind: 'builtin', id: 'mcp.config:builtin' },
                status: 'applied',
                reason: 'builtin_default',
              },
              {
                source: { kind: 'user', id: 'mcp_config.json' },
                status: 'applied',
                reason: 'layer_merged',
              },
            ],
            secretSources: [
              {
                path: 'servers.*.headers',
                source: { kind: 'user', id: 'mcp_config.json' },
              },
            ],
          },
        ],
      },
      promptSnapshots: {
        count: 2,
        recent: [
          {
            turnId: 'turn_2',
            projection: {
              stablePrefix: { hash: 'abcdef0123456789' },
              cacheBreak: {
                classification: 'unexpected',
                reasonCode: 'stable_section_changed_without_version',
                firstChanged: {
                  kind: 'section',
                  id: 'section:bootstrap',
                  index: 0,
                },
              },
            },
          },
        ],
      },
      activeTasks: [
        {
          id: 'task_1',
          kind: 'turn',
          label: 'Visual task',
          turn_id: 'turn_1',
          session_id: 'session_1',
          job_id: null,
          cancelled: false,
        },
      ],
      desktopPet: {
        enabled: false,
        autoStartWithWebui: false,
        running: false,
        installCommand: 'npm install',
      },
      dependencies: {
        nodeRuntime: true,
        desktopRenderer: true,
        desktopPetModules: false,
      },
    }

    const groups = diagnosticRows(payload)
    const rows = groups.flatMap((group) => group.rows)

    expect(groups.map((group) => group.title)).toEqual([
      '存储路径',
      '配置',
      '运行时',
      '桌面能力',
      '依赖',
    ])
    expect(
      rows.find((row) => row.id === 'runtime-resources-root'),
    ).toMatchObject({
      label: 'Runtime 资源根',
      value: '已定位',
      path: '/repo',
    })
    expect(rows.find((row) => row.id === 'global-state-root')).toMatchObject({
      label: '全局私有数据根',
      value: '默认 ~/.emperor-agent',
      detail: '/Users/me/.emperor-agent',
      path: '/Users/me/.emperor-agent',
    })
    expect(rows.find((row) => row.id === 'active-project-path')).toMatchObject({
      label: '当前项目路径',
      value: '已定位',
      path: '/repo/project',
    })
    expect(rows.find((row) => row.id === 'sessions-path')).toMatchObject({
      path: '/Users/me/.emperor-agent/sessions',
    })
    expect(rows.find((row) => row.id === 'attachments-path')).toMatchObject({
      path: '/Users/me/.emperor-agent/memory/attachments',
    })
    expect(rows.find((row) => row.id === 'mcp-config-path')).toMatchObject({
      path: '/Users/me/.emperor-agent/mcp_config.json',
    })
    expect(rows.find((row) => row.id === 'model-config')).toMatchObject({
      label: '模型配置',
      value: '缺失',
      tone: 'warn',
    })
    expect(rows.find((row) => row.id === 'local-config')).toMatchObject({
      label: '本地配置',
      value: '损坏',
      tone: 'error',
      detail: 'Unexpected token · 1 个腐化备份',
    })
    expect(
      rows.find((row) => row.id === 'effective-config-mcp-config'),
    ).toMatchObject({
      label: 'mcp.config',
      value: 'user:mcp_config.json',
      tone: 'ok',
    })
    expect(
      rows.find((row) => row.id === 'effective-config-mcp-config')?.detail,
    ).toContain('1 secret source redacted')
    expect(
      rows.find((row) => row.id === 'effective-config-mcp-config')?.detail,
    ).toContain(
      'trace 2 [builtin:mcp.config:builtin applied > user:mcp_config.json applied]',
    )
    expect(
      rows.find((row) => row.id === 'effective-config-mcp-config')?.detail,
    ).toContain('[REDACTED]')
    expect(rows.find((row) => row.id === 'scheduler-store')).toMatchObject({
      label: 'Scheduler Store',
      value: '异常',
      tone: 'error',
      detail: '1 个坏 action 行 · 1 个隔离文件',
    })
    expect(rows.find((row) => row.id === 'workspace-policy')).toMatchObject({
      label: 'Workspace Fence',
      value: '1 个允许根 / 1 个禁止根',
      tone: 'ok',
      detail: 'workspace /repo/project · state /repo/.emperor · outside deny',
    })
    expect(rows.find((row) => row.id === 'process-sandbox')).toMatchObject({
      label: 'Command OS Sandbox',
      value: 'macos-seatbelt · 可用',
      tone: 'ok',
      detail:
        'filesystem workspace-write · network policy-controlled · process tree controlled · probe passed',
    })
    expect(
      rows.find((row) => row.id === 'owned-process-runtime'),
    ).toMatchObject({
      label: 'Owned Process Runtime',
      value: 'owned · process_group',
      tone: 'ok',
      detail:
        'lease on / reparent on / orphan on · interactive stdio; PTY/resize unavailable · quota 65536/8388608 terminate',
    })
    expect(rows.find((row) => row.id === 'hybrid-memory')).toMatchObject({
      label: 'Hybrid Memory',
      value: 'eval · fts_fallback',
      tone: 'warn',
      path: '/Users/me/.emperor-agent/memory/hybrid-index/index.v1.json',
      detail:
        'requested on / prompt off · reason embedding_unavailable · search 3 / mutations 0 / fallbacks 1 · results 4 / index 4096 bytes',
    })
    expect(rows.find((row) => row.id === 'code-intelligence')).toMatchObject({
      label: 'Code Intelligence',
      value: 'eval · graph_fallback',
      tone: 'warn',
      detail:
        'requested on / tool off · reason gate_missing · graph ready / 1 managers / 120 files / 4096 cache bytes · skipped 8 / parse errors 0 · lsp 1 / ready 1 / restarts 0 / protocol 0 · queries 12 / lsp 2 / fallbacks 3 / events 4 / 8.5ms',
    })
    expect(rows.find((row) => row.id === 'lifecycle-supervisor')).toMatchObject(
      {
        label: 'Lifecycle Supervisor',
        value: 'ready · 7/7 ready',
        detail: '所有 required service 已就绪',
        tone: 'ok',
      },
    )
    expect(rows.find((row) => row.id === 'subagent-supervisor')).toMatchObject({
      label: 'Subagent Supervisor',
      value: '2 active · 2/6 capacity',
      detail: 'per-session limit 3 · session_1: 2',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'agent-definitions')).toMatchObject({
      label: 'Agent Definitions',
      value: '2 agents · 1/1 sources',
      detail: 'builtin:system',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'prompt-cache-break')).toMatchObject({
      label: 'Prompt Cache Break',
      value: 'unexpected · stable_section_changed_without_version',
      detail:
        'turn turn_2 · first section:section:bootstrap[0] · stable abcdef012345',
      tone: 'error',
    })
    expect(rows.find((row) => row.id === 'desktop-renderer')).toMatchObject({
      label: '桌面 Renderer',
      value: '已构建',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'node-runtime')).toMatchObject({
      label: 'Node.js Runtime',
      value: '可用',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'desktop-pet-modules')).toMatchObject({
      label: '桌宠模块',
      value: '缺少模块',
      tone: 'warn',
    })
  })

  it('shows chat sessions as unbound and omits the legacy-data group when nothing was detected', () => {
    const groups = diagnosticRows({
      root: '/repo',
      paths: {
        runtimeRoot: '/repo',
        stateRoot: '/repo',
        stateRootSource: 'explicit',
      },
      workspacePolicy: { workspaceRoot: '/repo' },
    })
    const rows = groups.flatMap((group) => group.rows)

    expect(groups.map((group) => group.title)).not.toContain('旧数据')
    expect(rows.find((row) => row.id === 'active-project-path')).toMatchObject({
      value: '未绑定',
      tone: 'muted',
    })
  })

  it('surfaces legacy state migration and project-local legacy private data as warnings, not silent auto-fixes', () => {
    const groups = diagnosticRows({
      root: '/repo',
      legacyStateMigration: {
        copied: 12,
        skipped: 1,
        legacyStateRoots: [
          {
            path: '/repo/memory',
            kind: 'ancient-bare-runtime-root',
            existed: false,
          },
          {
            path: '/repo/.emperor',
            kind: 'previous-dotemperor-root',
            existed: true,
          },
        ],
      },
      projectLegacyPrivateData: {
        projectPath: '/Users/me/projects/demo',
        sessions: true,
        memory: false,
      },
    })
    const rows = groups.flatMap((group) => group.rows)

    expect(groups.map((group) => group.title)).toContain('旧数据')
    expect(
      rows.find((row) => row.id === 'legacy-state-migration'),
    ).toMatchObject({
      value: '12 个文件已迁移',
      tone: 'warn',
      path: '/repo/.emperor',
      detail: '检测到 1 处旧存储位置 · 1 个跳过（已存在或损坏） · 旧数据未删除',
    })
    expect(
      rows.find((row) => row.id === 'project-legacy-private-data'),
    ).toMatchObject({
      value: '未迁移/可迁移',
      tone: 'warn',
      path: '/Users/me/projects/demo',
      detail: '.emperor/sessions · 仅提示，不会自动删除或搬移',
    })
  })

  it('shows memory context explanation when available', () => {
    const groups = diagnosticRows({
      root: '/repo',
      contextExplanation: {
        status: 'ok',
        sessionId: 'session_1',
        turnId: 'turn_1',
        mode: 'build',
        injected: [
          { kind: 'bootstrap', tokenEstimate: 12 },
          { kind: 'project_memory', tokenEstimate: 34 },
        ],
        omitted: [
          {
            kind: 'global_memory',
            reason: 'build mode intentionally does not inject global MEMORY',
          },
        ],
        checkpoint: { status: 'none' },
        compaction: { cursor: { compactedUntilSeq: 7, status: 'active' } },
        microcompact: {
          records: [{ original_chars: 1200 }, { original_chars: 800 }],
          omittedChars: 2000,
        },
        artifacts: [
          {
            kind: 'project_memory',
            visibility: 'build_only',
            injectedIn: ['build'],
          },
          {
            kind: 'runtime_event_log',
            visibility: 'runtime_only',
            injectedIn: [],
          },
          {
            kind: 'model_call_audit',
            visibility: 'debug_only',
            injectedIn: [],
          },
          {
            kind: 'history_archive',
            visibility: 'never_model_visible',
            injectedIn: [],
          },
        ],
      },
    })

    const group = groups.find((item) => item.id === 'context-explanation')
    expect(group?.title).toBe('上下文解释')
    expect(group?.rows.find((row) => row.id === 'context-mode')).toMatchObject({
      value: 'build',
      detail: 'session_1 / turn_1',
      tone: 'ok',
    })
    expect(
      group?.rows.find((row) => row.id === 'context-injected'),
    ).toMatchObject({
      value: '2 项注入',
      detail: 'bootstrap, project_memory · 46 tokens',
    })
    expect(
      group?.rows.find((row) => row.id === 'context-omitted'),
    ).toMatchObject({
      value: '1 项未注入',
      detail:
        'global_memory: build mode intentionally does not inject global MEMORY',
    })
    expect(
      group?.rows.find((row) => row.id === 'context-microcompact'),
    ).toMatchObject({
      value: '2 条裁剪',
      detail: '本次请求局部裁剪 2000 chars，不写回 history',
    })
    expect(
      group?.rows.find((row) => row.id === 'context-compaction-cursor'),
    ).toMatchObject({
      value: 'seq 7',
      detail: 'active',
    })
    expect(
      group?.rows.find((row) => row.id === 'context-artifacts'),
    ).toMatchObject({
      label: '记忆 Artifact 边界',
      value: '4 个 artifact',
      detail:
        'project_memory: build_only -> build · runtime_event_log: runtime_only -> 不注入 · model_call_audit: debug_only -> 不注入 · history_archive: never_model_visible -> 不注入',
      tone: 'ok',
    })
  })
})
