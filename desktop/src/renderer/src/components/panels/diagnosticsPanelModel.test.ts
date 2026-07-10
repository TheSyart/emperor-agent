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
      external: {
        running: true,
        inbox: { pending: 3 },
        store: { exists: true, corruptBackups: [] },
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
      '外部能力',
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
