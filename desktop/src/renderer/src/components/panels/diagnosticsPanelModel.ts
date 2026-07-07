import type {
  DesktopPetPayload,
  DiagnosticsConfigSummary,
  DiagnosticsDependencyPayload,
  DiagnosticsPayload,
  DiagnosticsRuntimePaths,
  ExternalDiagnosticsPayload,
  LegacyStateMigrationPayload,
  MemoryContextExplanationPayload,
  ProjectLegacyPrivateDataPayload,
  RuntimeStats,
  SchedulerDiagnosticsPayload,
  WorkspacePolicyDiagnosticsPayload,
} from '../../types'

export type DiagnosticTone = 'ok' | 'warn' | 'error' | 'muted'

export interface DiagnosticRow {
  id: string
  label: string
  value: string
  detail: string
  tone: DiagnosticTone
  path?: string
}

export interface DiagnosticGroup {
  id: string
  title: string
  rows: DiagnosticRow[]
}

export function diagnosticStatusTone(status: unknown): DiagnosticTone {
  const normalized = String(status || 'unknown').toLowerCase()
  if (['ok', 'ready', 'running', 'healthy'].includes(normalized)) return 'ok'
  if (['corrupt', 'invalid', 'error', 'failed', 'failure'].includes(normalized)) return 'error'
  if (['missing', 'disabled', 'stopped', 'not_installed', 'not-installed', 'warning', 'warn'].includes(normalized)) return 'warn'
  return 'muted'
}

export function diagnosticStatusText(status: unknown): string {
  const normalized = String(status || 'unknown').toLowerCase()
  const labels: Record<string, string> = {
    ok: '正常',
    ready: '就绪',
    running: '运行中',
    healthy: '正常',
    missing: '缺失',
    corrupt: '损坏',
    invalid: '无效',
    error: '异常',
    failed: '失败',
    failure: '失败',
    disabled: '已关闭',
    stopped: '已停止',
    unknown: '未知',
    warning: '警告',
    warn: '警告',
    not_installed: '未安装',
    'not-installed': '未安装',
  }
  return labels[normalized] || String(status || '未知')
}

export function diagnosticRows(payload: DiagnosticsPayload | null | undefined): DiagnosticGroup[] {
  const diagnostics = payload || {}
  const legacyRows = legacyDataRows(diagnostics.legacyStateMigration, diagnostics.projectLegacyPrivateData)
  return [
    {
      id: 'storage',
      title: '存储路径',
      rows: storagePathRows(diagnostics.paths, diagnostics.workspacePolicy, diagnostics.modelConfig),
    },
    {
      id: 'config',
      title: '配置',
      rows: [
        configRow('model-config', '模型配置', diagnostics.modelConfig),
        configRow('local-config', '本地配置', diagnostics.localConfig),
      ],
    },
    ...contextExplanationGroup(diagnostics.contextExplanation),
    ...(legacyRows.length ? [{ id: 'legacy-data', title: '旧数据', rows: legacyRows }] : []),
    {
      id: 'runtime',
      title: '运行时',
      rows: [
        schedulerRow(diagnostics.scheduler),
        runtimeRow(diagnostics.runtime),
        workspacePolicyRow(diagnostics.workspacePolicy),
        activeTasksRow(diagnostics.activeTasks),
      ],
    },
    {
      id: 'external',
      title: '外部能力',
      rows: [
        externalRow(diagnostics.external),
        desktopPetRow(diagnostics.desktopPet),
      ],
    },
    {
      id: 'dependencies',
      title: '依赖',
      rows: dependencyRows(diagnostics.dependencies),
    },
  ]
}

function contextExplanationGroup(explanation: MemoryContextExplanationPayload | undefined): DiagnosticGroup[] {
  if (!explanation) return []
  const status = String(explanation.status || 'unknown')
  const injected = arrayOfRecords(explanation.injected)
  const omitted = arrayOfRecords(explanation.omitted)
  const artifacts = arrayOfRecords(explanation.artifacts)
  const microcompact = recordValue(explanation.microcompact)
  const compaction = recordValue(explanation.compaction)
  const cursor = recordValue(compaction.cursor)
  return [{
    id: 'context-explanation',
    title: '上下文解释',
    rows: [
      {
        id: 'context-mode',
        label: 'Context Plan',
        value: String(explanation.mode || status),
        detail: contextModeDetail(explanation),
        tone: status === 'ok' ? 'ok' : diagnosticStatusTone(status),
      },
      {
        id: 'context-injected',
        label: '已注入模型上下文',
        value: `${injected.length} 项注入`,
        detail: joinParts([
          injected.map((item) => String(item.kind || item.id || '')).filter(Boolean).join(', '),
          injectedTokenEstimate(injected) ? `${injectedTokenEstimate(injected)} tokens` : '',
        ]),
        tone: injected.length ? 'ok' : 'muted',
      },
      {
        id: 'context-omitted',
        label: '未注入项',
        value: omitted.length ? `${omitted.length} 项未注入` : '无',
        detail: omitted.length
          ? omitted.map((item) => `${String(item.kind || 'unknown')}: ${String(item.reason || '')}`.trim()).join(' · ')
          : '当前 ContextPlan 没有记录被策略排除的上下文',
        tone: omitted.length ? 'warn' : 'ok',
      },
      {
        id: 'context-microcompact',
        label: '局部 microcompact',
        value: `${arrayOfRecords(microcompact.records).length} 条裁剪`,
        detail: Number(microcompact.omittedChars || 0)
          ? `本次请求局部裁剪 ${Number(microcompact.omittedChars)} chars，不写回 history`
          : '本次请求没有局部裁剪记录',
        tone: arrayOfRecords(microcompact.records).length ? 'warn' : 'ok',
      },
      {
        id: 'context-compaction-cursor',
        label: '语义压缩游标',
        value: Number(cursor.compactedUntilSeq || 0) ? `seq ${Number(cursor.compactedUntilSeq)}` : '未压缩',
        detail: String(cursor.status || 'unknown'),
        tone: Number(cursor.compactedUntilSeq || 0) ? 'ok' : 'muted',
      },
      {
        id: 'context-artifacts',
        label: '记忆 Artifact 边界',
        value: artifacts.length ? `${artifacts.length} 个 artifact` : '未返回',
        detail: artifacts.length ? artifactBoundaryDetail(artifacts) : 'memory.explainContext 未返回 artifact taxonomy',
        tone: artifacts.length ? 'ok' : 'muted',
      },
      {
        id: 'context-checkpoint',
        label: 'Turn Checkpoint',
        value: diagnosticStatusText(recordValue(explanation.checkpoint).status),
        detail: String(recordValue(explanation.checkpoint).reason || recordValue(explanation.checkpoint).phase || ''),
        tone: diagnosticStatusTone(recordValue(explanation.checkpoint).status),
      },
    ],
  }]
}

function storagePathRows(
  paths: DiagnosticsRuntimePaths | undefined,
  workspacePolicy: WorkspacePolicyDiagnosticsPayload | undefined,
  modelConfig: DiagnosticsConfigSummary | undefined,
): DiagnosticRow[] {
  const activeProjectPath = workspacePolicy?.workspaceRoot || ''
  const hasBoundProject = Boolean(activeProjectPath) && activeProjectPath !== paths?.runtimeRoot
  return [
    pathRow('runtime-resources-root', 'Runtime 资源根', paths?.runtimeRoot, '内置技能/模板等只读资源所在目录'),
    {
      id: 'global-state-root',
      label: '全局私有数据根',
      value: sourceLabel(paths?.stateRootSource),
      detail: paths?.stateRoot || '未返回',
      tone: paths?.stateRoot ? 'ok' : 'muted',
      path: paths?.stateRoot,
    },
    hasBoundProject
      ? pathRow('active-project-path', '当前项目路径', activeProjectPath, '项目已绑定；私有会话仍保存到全局 Emperor store，不写入项目源码目录')
      : {
        id: 'active-project-path',
        label: '当前项目路径',
        value: '未绑定',
        detail: '当前是 chat 会话，没有绑定项目目录',
        tone: 'muted',
      },
    pathRow('sessions-path', 'Sessions 路径', paths?.sessionsRoot),
    pathRow('attachments-path', '附件路径', paths?.attachmentsRoot),
    pathRow('model-config-path', '模型配置路径', modelConfig?.path || paths?.stateRoot),
    pathRow('mcp-config-path', 'MCP 配置路径', paths?.mcpConfigPath),
  ]
}

function pathRow(id: string, label: string, path: string | undefined, detail?: string): DiagnosticRow {
  return {
    id,
    label,
    value: path ? '已定位' : '未返回',
    detail: detail || path || '未返回',
    tone: path ? 'ok' : 'muted',
    path,
  }
}

function sourceLabel(source: string | undefined): string {
  if (source === 'explicit') return '显式指定'
  if (source === 'env') return '环境变量 EMPEROR_CONFIG_DIR'
  if (source === 'default') return '默认 ~/.emperor-agent'
  return '未知'
}

function legacyDataRows(
  migration: LegacyStateMigrationPayload | undefined,
  projectLegacy: ProjectLegacyPrivateDataPayload | null | undefined,
): DiagnosticRow[] {
  const rows: DiagnosticRow[] = []
  const detectedLegacyRoots = (migration?.legacyStateRoots ?? []).filter((entry) => entry.existed)
  if (detectedLegacyRoots.length) {
    rows.push({
      id: 'legacy-state-migration',
      label: '旧存储位置迁移',
      value: `${numberOrZero(migration?.copied)} 个文件已迁移`,
      detail: joinParts([
        `检测到 ${detectedLegacyRoots.length} 处旧存储位置`,
        numberOrZero(migration?.skipped) ? `${migration?.skipped} 个跳过（已存在或损坏）` : '',
        '旧数据未删除',
      ]),
      tone: 'warn',
      path: detectedLegacyRoots[0]?.path,
    })
  }
  if (projectLegacy && (projectLegacy.sessions || projectLegacy.memory)) {
    rows.push({
      id: 'project-legacy-private-data',
      label: '项目目录内的旧私有数据',
      value: '未迁移/可迁移',
      detail: joinParts([
        projectLegacy.sessions ? '.emperor/sessions' : '',
        projectLegacy.memory ? '.emperor/memory' : '',
        '仅提示，不会自动删除或搬移',
      ]),
      tone: 'warn',
      path: projectLegacy.projectPath,
    })
  }
  return rows
}

function configRow(id: string, label: string, summary: DiagnosticsConfigSummary | undefined): DiagnosticRow {
  const status = summary?.status || 'unknown'
  const backupCount = count(summary?.corruptBackups)
  return {
    id,
    label,
    value: diagnosticStatusText(status),
    detail: joinParts([
      summary?.error,
      typeof summary?.models === 'number' ? `${summary.models} 个模型条目` : '',
      backupCount ? `${backupCount} 个腐化备份` : '',
    ]),
    tone: diagnosticStatusTone(status),
    path: summary?.path,
  }
}

function schedulerRow(summary: SchedulerDiagnosticsPayload | undefined): DiagnosticRow {
  const errorCount = count(summary?.lastActionErrors)
  const corruptCount = count(summary?.corruptActionFiles)
  const hasError = errorCount > 0 || corruptCount > 0
  return {
    id: 'scheduler-store',
    label: 'Scheduler Store',
    value: hasError ? '异常' : summary ? '正常' : '未返回',
    detail: joinParts([
      errorCount ? `${errorCount} 个坏 action 行` : '',
      corruptCount ? `${corruptCount} 个隔离文件` : '',
      !hasError ? summary?.jobsFile : '',
    ]),
    tone: hasError ? 'error' : summary ? 'ok' : 'muted',
    path: summary?.jobsFile,
  }
}

function runtimeRow(runtime: RuntimeStats | undefined): DiagnosticRow {
  return {
    id: 'runtime-events',
    label: 'Runtime Events',
    value: runtime ? `${numberOrZero(runtime.events)} 条事件` : '未返回',
    detail: runtime
      ? joinParts([
        `${numberOrZero(runtime.archiveFiles)} 个归档`,
        runtime.needsRotation ? '需要轮转' : '无需轮转',
        runtime.path,
      ])
      : '未返回详细信息',
    tone: runtime?.needsRotation ? 'warn' : runtime ? 'ok' : 'muted',
    path: runtime?.path,
  }
}

function activeTasksRow(activeTasks: unknown[] | undefined): DiagnosticRow {
  const taskCount = count(activeTasks)
  return {
    id: 'active-tasks',
    label: 'Active Tasks',
    value: taskCount ? `${taskCount} 个运行中` : '空闲',
    detail: taskCount ? '有可取消任务' : '当前没有登记的运行任务',
    tone: taskCount ? 'warn' : 'ok',
  }
}

function workspacePolicyRow(policy: WorkspacePolicyDiagnosticsPayload | undefined): DiagnosticRow {
  const allowRoots = policy?.allowRoots ?? []
  const denyRoots = policy?.denyRoots ?? []
  const workspaceRoot = policy?.workspaceRoot || ''
  const stateRoot = policy?.stateRoot || ''
  return {
    id: 'workspace-policy',
    label: 'Workspace Fence',
    value: policy ? `${allowRoots.length} 个允许根 / ${denyRoots.length} 个禁止根` : '未返回',
    detail: policy
      ? joinParts([
        workspaceRoot ? `workspace ${workspaceRoot}` : '',
        stateRoot ? `state ${stateRoot}` : '',
        policy.outsideWorkspace ? `outside ${policy.outsideWorkspace}` : '',
      ])
      : '未返回详细信息',
    tone: !policy ? 'muted' : allowRoots.length ? 'ok' : 'warn',
    path: workspaceRoot || stateRoot || undefined,
  }
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function injectedTokenEstimate(items: Array<Record<string, unknown>>): number {
  return items.reduce((sum, item) => sum + Number(item.tokenEstimate || 0), 0)
}

function artifactBoundaryDetail(items: Array<Record<string, unknown>>): string {
  return items.map((item) => {
    const kind = String(item.kind || 'unknown')
    const visibility = String(item.visibility || 'unknown')
    const injectedIn = Array.isArray(item.injectedIn)
      ? item.injectedIn.map((entry) => String(entry)).filter(Boolean)
      : []
    return `${kind}: ${visibility} -> ${injectedIn.length ? injectedIn.join('/') : '不注入'}`
  }).join(' · ')
}

function contextModeDetail(explanation: MemoryContextExplanationPayload): string {
  const sessionId = String(explanation.sessionId || '')
  const turnId = String(explanation.turnId || '')
  const pair = sessionId && turnId ? `${sessionId} / ${turnId}` : joinParts([sessionId, turnId])
  return joinParts([pair, String(explanation.reason || '')])
}

function externalRow(external: ExternalDiagnosticsPayload | undefined): DiagnosticRow {
  const pending = numberOrZero(external?.inbox?.pending)
  const errors = count(external?.recentErrors)
  const backups = count(external?.store?.corruptBackups)
  const tone: DiagnosticTone = errors || backups ? 'error' : external?.running ? 'ok' : external ? 'warn' : 'muted'
  return {
    id: 'external-bridge',
    label: 'External Bridge',
    value: external ? (external.running ? '运行中' : '已停止') : '未返回',
    detail: joinParts([
      `${pending} 条待处理`,
      errors ? `${errors} 个近期错误` : '',
      backups ? `${backups} 个腐化备份` : '',
      external?.store?.path || '',
    ]),
    tone,
    path: external?.store?.path || undefined,
  }
}

function desktopPetRow(pet: (DesktopPetPayload & Record<string, unknown>) | undefined): DiagnosticRow {
  const enabled = Boolean(pet?.enabled)
  const running = Boolean(pet?.running)
  const lastError = typeof pet?.lastError === 'string' ? pet.lastError : ''
  return {
    id: 'desktop-pet',
    label: '桌宠',
    value: running ? '运行中' : enabled ? '待启动' : '已关闭',
    detail: joinParts([
      lastError,
      pet?.pid ? `PID ${pet.pid}` : '',
      pet?.autoStartWithWebui ? '跟随 WebUI' : '手动',
    ]),
    tone: lastError ? 'error' : running ? 'ok' : enabled ? 'warn' : 'muted',
  }
}

function dependencyRows(dependencies: DiagnosticsDependencyPayload | undefined): DiagnosticRow[] {
  return [
    dependencyRow('node-runtime', 'Node.js Runtime', dependencies?.nodeRuntime, '可用', '不可用'),
    dependencyRow('desktop-renderer', '桌面 Renderer', dependencies?.desktopRenderer, '已构建', '缺少构建产物'),
    dependencyRow('desktop-pet-modules', '桌宠依赖', dependencies?.desktopPetNodeModules, '已安装', '未安装'),
  ]
}

function dependencyRow(id: string, label: string, present: unknown, okValue: string, missingValue: string): DiagnosticRow {
  if (typeof present !== 'boolean') {
    return {
      id,
      label,
      value: '未返回',
      detail: '依赖检查未返回该字段',
      tone: 'muted',
    }
  }
  return {
    id,
    label,
    value: present ? okValue : missingValue,
    detail: present ? '依赖可用' : '需要按需安装或重新构建',
    tone: present ? 'ok' : 'warn',
  }
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' · ') || '未返回详细信息'
}
