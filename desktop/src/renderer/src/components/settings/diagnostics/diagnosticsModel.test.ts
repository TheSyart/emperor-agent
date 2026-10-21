import { describe, expect, it } from 'vitest'
import type { DiagnosticsPayload } from '../../../types'
import {
  OPENABLE_DIAGNOSTIC_PATHS,
  diagnosticCardDescription,
  diagnosticReportText,
  diagnosticRows,
  diagnosticSectionBadges,
  diagnosticSections,
  diagnosticStatusTone,
  diagnosticStatusText,
  diagnosticSummary,
  shortenHomePaths,
} from './diagnosticsModel'

describe('diagnostics settings model', () => {
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
      commandCatalog: {
        status: 'warning',
        registeredSkills: 3,
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
    // A located path reads as the path itself, in the code font.
    expect(
      rows.find((row) => row.id === 'runtime-resources-root'),
    ).toMatchObject({
      label: '内置资源目录',
      value: '/repo',
      detail: '内置技能/模板等只读资源所在目录',
      path: '/repo',
      mono: true,
    })
    expect(rows.find((row) => row.id === 'global-state-root')).toMatchObject({
      label: 'Emperor Home',
      value: '/Users/me/.emperor-agent',
      detail: '默认位置',
      path: '/Users/me/.emperor-agent',
      mono: true,
    })
    expect(rows.find((row) => row.id === 'active-project-path')).toMatchObject({
      label: '当前项目',
      value: '/repo/project',
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
    expect(
      rows.find((row) => row.id === 'slash-command-catalog'),
    ).toMatchObject({
      value: '3 个 Skill · 1 个冲突',
      tone: 'warn',
    })
    expect(
      rows.find((row) => row.id === 'slash-command-catalog')?.detail,
    ).toContain('/new · user:new → builtin (builtin_collision)')
    expect(rows.find((row) => row.id === 'scheduler-store')).toMatchObject({
      label: '定时任务存储',
      value: '异常',
      tone: 'error',
      detail: '1 个坏 action 行 · 1 个隔离文件',
    })
    expect(rows.find((row) => row.id === 'workspace-policy')).toMatchObject({
      label: '工作区范围',
      value: '1 个允许根 / 1 个禁止根',
      tone: 'ok',
      detail: 'workspace /repo/project · state /repo/.emperor · outside deny',
    })
    expect(rows.find((row) => row.id === 'process-sandbox')).toMatchObject({
      label: '命令沙箱',
      value: 'macos-seatbelt · 可用',
      tone: 'ok',
      detail:
        'filesystem workspace-write · network policy-controlled · process tree controlled · probe passed',
    })
    expect(
      rows.find((row) => row.id === 'owned-process-runtime'),
    ).toMatchObject({
      label: '进程托管',
      value: 'owned · process_group',
      tone: 'ok',
      detail:
        'lease on / reparent on / orphan on · interactive stdio; PTY/resize unavailable · quota 65536/8388608 terminate',
    })
    expect(rows.find((row) => row.id === 'hybrid-memory')).toMatchObject({
      label: '混合记忆检索',
      value: 'eval · fts_fallback',
      tone: 'warn',
      path: '/Users/me/.emperor-agent/memory/hybrid-index/index.v1.json',
      detail:
        'requested on / prompt off · reason embedding_unavailable · search 3 / mutations 0 / fallbacks 1 · results 4 / index 4096 bytes',
    })
    expect(rows.find((row) => row.id === 'code-intelligence')).toMatchObject({
      label: '代码索引',
      value: 'eval · graph_fallback',
      tone: 'warn',
      detail:
        'requested on / tool off · reason gate_missing · graph ready / 1 managers / 120 files / 4096 cache bytes · skipped 8 / parse errors 0 · lsp 1 / ready 1 / restarts 0 / protocol 0 · queries 12 / lsp 2 / fallbacks 3 / events 4 / 8.5ms',
    })
    expect(rows.find((row) => row.id === 'lifecycle-supervisor')).toMatchObject(
      {
        label: '服务生命周期',
        value: 'ready · 7/7 ready',
        detail: '所有 required service 已就绪',
        tone: 'ok',
      },
    )
    expect(rows.find((row) => row.id === 'subagent-supervisor')).toMatchObject({
      label: '子智能体',
      value: '2 active · 2/6 capacity',
      detail: 'per-session limit 3 · session_1: 2',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'agent-definitions')).toMatchObject({
      label: 'Agent 定义',
      value: '2 agents · 1/1 sources',
      detail: 'builtin:system',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'prompt-cache-break')).toMatchObject({
      label: '提示词缓存',
      value: 'unexpected · stable_section_changed_without_version',
      detail:
        'turn turn_2 · first section:section:bootstrap[0] · stable abcdef012345',
      tone: 'error',
    })
    expect(rows.find((row) => row.id === 'desktop-renderer')).toMatchObject({
      label: '桌面渲染层',
      value: '已构建',
      tone: 'ok',
    })
    expect(rows.find((row) => row.id === 'node-runtime')).toMatchObject({
      label: 'Node.js 运行时',
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

  it('builds the settings sections: runtime, desktop, paths, config', () => {
    const sections = diagnosticSections({
      root: '/repo',
      paths: {
        runtimeRoot: '/Applications/Emperor.app/Contents/Resources/app',
        stateRoot: '/Users/me/.emperor',
        stateRootSource: 'default',
        sessionsRoot: '/Users/me/.emperor/sessions',
      },
      workspacePolicy: { workspaceRoot: '/Users/me/code/app' },
      scheduler: { jobsFile: 'memory/scheduler/jobs.json' },
      runtime: { events: 3 },
      dependencies: { nodeRuntime: true, desktopPetModules: false },
      effectiveConfig: {
        entries: [
          {
            key: 'sandbox.runtime',
            source: { kind: 'builtin', id: 'defaults', trust: 'trusted' },
            trace: [{ status: 'applied' }],
            value: { shell: { presets: ['a', 'b'] } },
          },
          {
            key: 'skills.writer',
            source: { kind: 'user', id: 'writer', trust: 'trusted' },
            trace: [{ status: 'applied' }],
            value: {},
          },
          {
            key: 'skills.web',
            source: { kind: 'project', id: 'web', trust: 'untrusted' },
            trace: [],
            value: {},
          },
        ],
      },
    } as never)

    expect(sections.map((section) => section.title)).toEqual([
      '运行时',
      '桌面',
      '存储路径',
      '配置',
    ])
    const runtime = sections[0]!
    // Rows Core returned nothing for are dropped and counted.
    expect(runtime.rows.map((row) => row.id)).toEqual([
      'scheduler-store',
      'runtime-events',
      'workspace-policy',
      'prompt-cache-break',
      'active-tasks',
    ])
    expect(runtime.hidden).toBe(7)
    // Core reports only the workspace root: no false 0-roots warning.
    expect(
      runtime.rows.find((row) => row.id === 'workspace-policy'),
    ).toMatchObject({
      value: '已设定',
      tone: 'ok',
      detail: 'workspace ~/code/app',
    })
    const desktop = sections[1]!
    expect(desktop.rows.map((row) => row.id)).toEqual([
      'desktop-pet',
      'node-runtime',
      'desktop-pet-modules',
    ])
    // Neither the renderer build nor computer use was reported.
    expect(desktop.hidden).toBe(2)
    const paths = sections[2]!
    expect(
      paths.rows.find((row) => row.id === 'global-state-root'),
    ).toMatchObject({
      label: 'Emperor Home',
      value: '~/.emperor',
      path: '/Users/me/.emperor',
    })
    expect(paths.rows.find((row) => row.id === 'sessions-path')).toMatchObject({
      value: '~/.emperor/sessions',
      mono: true,
    })
    // Effective config: no JSON, skills folded into one row.
    const config = sections[3]!
    expect(config.rows.map((row) => [row.label, row.value, row.tone])).toEqual([
      ['模型配置', '未知', 'muted'],
      ['本地配置', '未知', 'muted'],
      ['沙箱策略', '生效', 'ok'],
      ['Skills 配置', '2 项', 'warn'],
    ])
    expect(
      config.rows.find((row) => row.id === 'effective-config-skills')?.detail,
    ).toBe('web 来源不受信任或被拒绝')
    expect(JSON.stringify(config.rows)).not.toContain('presets')

    expect(
      diagnosticSections({
        legacyStateMigration: {
          copied: 1,
          legacyStateRoots: [{ path: '/old', existed: true }],
        },
      } as never)[2]!.rows.map((row) => row.id),
    ).toContain('legacy-state-migration')
  })

  it('opens 运行时 with the app facts that left 常规 (UI-S07)', () => {
    const [runtime] = diagnosticSections(
      { runtime: { events: 3 } },
      { app: { service: '在线', model: 'deepseek-flash', projects: 2 } },
    )
    expect(
      runtime?.rows.slice(0, 3).map((row) => [row.label, row.value]),
    ).toEqual([
      ['服务状态', '在线'],
      ['当前模型', 'deepseek-flash'],
      ['已绑定项目', '2 个'],
    ])
    expect(runtime?.rows[0]?.tone).toBe('ok')
    const [offline] = diagnosticSections(
      {},
      { app: { service: '服务不可用', model: '', projects: 0 } },
    )
    expect(offline?.rows[0]?.tone).toBe('error')
    expect(offline?.rows[1]?.value).toBe('未配置')
    // Without app facts the card is what Core returned.
    expect(
      diagnosticSections({ runtime: { events: 3 } })[0]?.rows.map(
        (row) => row.id,
      ),
    ).not.toContain('app-service')
  })

  it('puts the runtime root first in 存储路径, one row when it holds the resources', () => {
    const paths = (payload: Record<string, unknown>) =>
      diagnosticSections(payload as never).find(
        (section) => section.id === 'paths',
      )!.rows
    const shared = paths({
      root: '/Users/me/app/',
      paths: { runtimeRoot: '/Users/me/app', stateRoot: '/Users/me/.emperor' },
    })
    expect(shared[0]).toMatchObject({
      id: 'runtime-root',
      label: '运行根目录',
      value: '~/app',
      detail: '内置技能/模板等只读资源所在目录',
      tone: 'ok',
      path: '/Users/me/app/',
      mono: true,
    })
    expect(shared.map((row) => row.id)).not.toContain('runtime-resources-root')
    const apart = paths({
      root: '/Users/me/code/emperor',
      paths: {
        runtimeRoot: '/Applications/Emperor.app/Contents/Resources/app',
        stateRoot: '/Users/me/.emperor',
      },
    })
    expect(apart.map((row) => row.id).slice(0, 2)).toEqual([
      'runtime-root',
      'runtime-resources-root',
    ])
    expect(apart[0]!.detail).toBe('')
    // No root reported: no row.
    expect(
      paths({ paths: { stateRoot: '/Users/me/.emperor' } }).map(
        (row) => row.id,
      ),
    ).not.toContain('runtime-root')
  })

  it('shows a scheduler that did not start, and jobs it set aside (KRN-10 1, 2)', () => {
    const row = (scheduler: Record<string, unknown>) =>
      diagnosticRows({ scheduler } as never)
        .flatMap((group) => group.rows)
        .find((item) => item.id === 'scheduler-store')
    expect(
      row({
        jobsFile: '/data/scheduler/jobs.json',
        startError: '另一个 Emperor 进程（pid 4242）正在运行定时任务',
      }),
    ).toMatchObject({
      value: '未启动',
      tone: 'error',
      detail: expect.stringContaining('pid 4242'),
    })
    expect(
      row({
        jobsFile: '/data/scheduler/jobs.json',
        rejectedFile: '/data/scheduler/jobs.rejected.json',
        rejectedJobs: [{ id: 'job-bad', name: '坏任务', error: 'x' }],
      }),
    ).toMatchObject({
      value: '1 个任务无法读取',
      tone: 'warn',
      detail: expect.stringContaining('坏任务'),
      path: '/data/scheduler/jobs.rejected.json',
    })
  })

  it('summarises section health and lists issues, errors first', () => {
    const sections = diagnosticSections({
      root: '/Users/me/code/app',
      scheduler: { lastActionErrors: [{}] },
      runtime: { events: 1 },
      dependencies: { nodeRuntime: true, desktopPetModules: false },
    } as never)
    const summary = diagnosticSummary(sections, [
      {
        id: 'environment-git',
        label: 'git',
        value: '已就绪',
        detail: '',
        tone: 'ok',
      },
      {
        id: 'environment-node',
        label: 'node',
        value: '版本不匹配',
        detail: '要求 >=22',
        tone: 'warn',
      },
    ])
    expect(summary.tone).toBe('error')
    expect(summary.headline).toBe('有 1 项异常，2 项需要关注')
    expect(summary.issues.map((issue) => [issue.sectionId, issue.id])).toEqual([
      ['runtime', 'scheduler-store'],
      ['desktop', 'desktop-pet-modules'],
      ['environment', 'environment-node'],
    ])
    // Each issue names its card, for the overview line 「环境工具 · node」.
    expect(summary.issues.map((issue) => issue.section)).toEqual([
      '运行时',
      '桌面',
      '环境工具',
    ])
    expect(summary.counts.environment).toEqual({
      total: 2,
      ok: 1,
      warn: 1,
      error: 0,
    })
    // The overview: its badges, then one conclusion.
    expect(summary.badges).toEqual([
      { tone: 'error', text: '1 项异常' },
      { tone: 'warn', text: '2 项需要关注' },
    ])
    expect(summary.conclusion).toBe('其余都正常')
    const fine = diagnosticSummary([], [])
    expect(fine.headline).toBe('运行正常')
    expect(fine.badges).toEqual([{ tone: 'ok', text: '运行正常' }])
    expect(fine.conclusion).toBe('没有需要关注的项目')

    const report = diagnosticReportText({
      summary,
      sections,
      environment: [],
      environmentLabel: 'macOS · arm64',
    })
    // The runtime root is a 存储路径 line now, not a header of its own.
    expect(report).not.toMatch(/^运行根目录/m)
    expect(report).toContain('- [正常] 运行根目录：~/code/app')
    expect(report).toContain('总体：有 1 项异常，2 项需要关注')
    expect(report).toContain('## 环境工具 · macOS · arm64')
    expect(report).toContain('- [异常] 定时任务存储：异常')
  })

  it('marks a card only while something in it needs attention', () => {
    expect(
      diagnosticSectionBadges({ total: 8, ok: 7, warn: 0, error: 0 }),
    ).toEqual([])
    expect(
      diagnosticSectionBadges({ total: 4, ok: 3, warn: 1, error: 0 }),
    ).toEqual([{ tone: 'warn', text: '1 项需要关注' }])
    expect(
      diagnosticSectionBadges({ total: 4, ok: 1, warn: 2, error: 1 }),
    ).toEqual([
      { tone: 'error', text: '1 项异常' },
      { tone: 'warn', text: '2 项需要关注' },
    ])
  })

  it('describes a card by its size, what Core left out and what it holds', () => {
    expect(diagnosticCardDescription({ total: 12, hidden: 0 })).toBe('12 项')
    expect(diagnosticCardDescription({ total: 8, hidden: 4 })).toBe(
      '8 项 · 另有 4 项未返回数据',
    )
    expect(
      diagnosticCardDescription({
        total: 4,
        hidden: 0,
        prefix: 'macOS · arm64',
      }),
    ).toBe('macOS · arm64 · 4 项')
    expect(
      diagnosticCardDescription({ total: 8, hidden: 0, runtimeRoot: true }),
    ).toBe('8 项 · 含运行根目录')
  })

  it('reads home directories as ~', () => {
    expect(shortenHomePaths('/Users/me/.emperor/sessions')).toBe(
      '~/.emperor/sessions',
    )
    expect(shortenHomePaths('workspace /home/me/app · state /Users/me')).toBe(
      'workspace ~/app · state ~',
    )
    expect(shortenHomePaths('C:\\Users\\me\\app')).toBe('~\\app')
    expect(shortenHomePaths('/opt/app')).toBe('/opt/app')
  })
})

describe('computer use diagnostics row', () => {
  const row = (computerUse: Record<string, unknown>) =>
    diagnosticSections({ computerUse } as never)
      .find((section) => section.id === 'desktop')!
      .rows.find((item) => item.id === 'computer-use')

  it('reads off, unsupported and enabled states, with no stop shortcut', () => {
    expect(row({ supported: false })).toMatchObject({
      value: '不可用',
      tone: 'muted',
    })
    expect(row({ supported: true, enabled: false })).toMatchObject({
      value: '已关闭',
    })
    const drivers = [
      {
        driver: 'embedded-browser',
        stage: 'experimental',
        label: '内置浏览器（基础）',
        enabled: true,
        available: true,
      },
    ]
    expect(
      row({ supported: true, enabled: true, drivers, targets: 1 }),
    ).toMatchObject({
      value: '已开启',
      tone: 'ok',
      detail: '内置浏览器（基础） · 1 个目标',
    })
    expect(
      row({
        supported: true,
        enabled: true,
        drivers: [{ ...drivers[0], available: false }],
      }),
    ).toMatchObject({
      value: '已开启',
      tone: 'warn',
      detail: '没有可用驱动 · 0 个目标',
    })
  })
})

describe('process containment receipts row (SEC-08)', () => {
  const row = (processRuntime: Record<string, unknown>) =>
    diagnosticSections({ processRuntime } as never)
      .find((section) => section.id === 'runtime')!
      .rows.find((item) => item.id === 'process-containment')

  it('shows the recent receipts: who ran, contained or not, and the policy', () => {
    expect(row({ ownership: true })).toBeUndefined()
    expect(
      row({
        containment: {
          backend: 'seatbelt',
          available: true,
          recent: [
            {
              owner: 'mcp',
              id: 'notes',
              decision: 'user-allowed-unsandboxed',
              backend: 'none',
              policyHash: '0123456789ab',
              status: 'running',
              at: '2026-10-19T06:00:00.000Z',
            },
            {
              owner: 'hook',
              id: 'kit',
              decision: 'refused',
              backend: 'none',
              policyHash: 'ba9876543210',
              status: 'refused',
              reason: '进程沙箱不可用：mock',
              at: '2026-10-19T05:59:00.000Z',
            },
            {
              owner: 'mcp',
              id: 'files',
              decision: 'contained',
              backend: 'seatbelt',
              policyHash: 'aaaaaaaaaaaa',
              status: 'completed',
              at: '2026-10-19T05:58:00.000Z',
            },
          ],
        },
      }),
    ).toMatchObject({
      label: '进程隔离回执',
      value: '3 条 · 1 隔离 · 1 拒绝 · 1 经同意未隔离',
      tone: 'warn',
      detail:
        'MCP notes 经同意未隔离 (none · 0123456789ab) · Hook kit 已拒绝 (none · ba9876543210)：进程沙箱不可用：mock · MCP files 已隔离 (seatbelt · aaaaaaaaaaaa)',
    })
    expect(
      row({
        containment: {
          backend: 'seatbelt',
          available: true,
          recent: [
            {
              owner: 'environment',
              id: 'managed_plan_x',
              decision: 'contained',
              backend: 'seatbelt',
              policyHash: 'cccccccccccc',
              status: 'completed',
            },
          ],
        },
      }),
    ).toMatchObject({
      value: '1 条 · 1 隔离',
      tone: 'ok',
      detail: '环境安装 managed_plan_x 已隔离 (seatbelt · cccccccccccc)',
    })
    expect(
      row({
        containment: { backend: 'seatbelt', available: true, recent: [] },
      }),
    ).toMatchObject({ value: '暂无', tone: 'muted' })
  })
})

describe('the log folder in 存储路径 (REL-01)', () => {
  it('shows where main.log and core.log are, and offers to open it', () => {
    const sections = diagnosticSections(
      {
        root: '/Users/me/app',
        paths: {
          runtimeRoot: '/Users/me/app',
          stateRoot: '/Users/me/.emperor',
          logsRoot: '/Users/me/Library/Logs/Emperor Agent',
        },
      } as DiagnosticsPayload,
      { app: { service: '在线', model: '', projects: 0 } },
    )
    const row = sections
      .find((section) => section.id === 'paths')
      ?.rows.find((item) => item.id === 'logs-path')
    expect(row).toMatchObject({
      label: '日志',
      value: '~/Library/Logs/Emperor Agent',
      path: '/Users/me/Library/Logs/Emperor Agent',
      tone: 'ok',
    })
    expect(row?.detail).toContain('main.log')
    expect(OPENABLE_DIAGNOSTIC_PATHS.has('logs-path')).toBe(true)
  })

  it('leaves the row out when the host keeps no log folder', () => {
    const sections = diagnosticSections(
      {
        root: '/r',
        paths: { runtimeRoot: '/r', stateRoot: '/s' },
      } as DiagnosticsPayload,
      { app: { service: '在线', model: '', projects: 0 } },
    )
    expect(
      sections
        .find((section) => section.id === 'paths')
        ?.rows.some((item) => item.id === 'logs-path'),
    ).toBe(false)
  })
})
