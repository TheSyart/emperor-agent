import type { Page } from '@playwright/test'
import { resolve } from 'node:path'
import { showcaseScenario } from '../../src/renderer/src/components/conversation/gallery/scenarios'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'

type VisualSessionMode = 'build' | 'chat'

type VisualProjectInfo = {
  project_id: string
  project_path: string
  project_name: string
}

type VisualCoreListener = (event: unknown) => void

type VisualBridge = {
  version: string
  platform: string
  selectDirectory: () => Promise<string>
  getPathForFile: (file: File) => string
  selectFile?: (input?: unknown) => Promise<string | null>
  openSkillsFolder?: (input: {
    scope?: string
  }) => Promise<{ ok: boolean; path?: string }>
  openPath?: (target: string) => Promise<{ ok: boolean }>
  onCoreEvent: (listener: VisualCoreListener) => () => void
  onTerminalEvent: (listener: VisualCoreListener) => () => void
  onSessionEvents: (listener: VisualCoreListener) => () => void
  invokeCore: (operationKey: string, ...args: unknown[]) => Promise<unknown>
}

declare global {
  interface Window {
    emperor?: VisualBridge
  }
}

export const visualProjectDir = resolve(
  process.cwd(),
  'screenshots',
  'fixtures',
  'visual-build-project',
)

/** A raw session log the bridge serves through `sessions.history`. */
export interface VisualSessionLog {
  id: string
  header: Record<string, unknown>
  events: Array<{ seq: number; type: string; time?: number; data?: unknown }>
}

const FIXTURE_TIME = Date.parse('2026-06-26T12:00:00.000Z')

/**
 * Default raw logs: `build-ui` carries the gallery showcase turn (tools,
 * reasoning, a delegated child `showcase-child`); every other session
 * starts empty (hero).
 */
function defaultSessionLogs(): VisualSessionLog[] {
  const scenario = showcaseScenario(FIXTURE_TIME)
  const [root, ...children] = scenario.sessions
  return [
    {
      id: 'build-ui',
      header: { version: 0, id: 'build-ui', createdAt: FIXTURE_TIME },
      events: [...(root?.events ?? [])] as VisualSessionLog['events'],
    },
    ...children.map((child) => ({
      id: child.id,
      header: {
        version: 0,
        id: child.id,
        createdAt: FIXTURE_TIME,
        origin: 'subagent',
      },
      events: [...child.events] as VisualSessionLog['events'],
    })),
  ]
}

/**
 * Events streamed after a submitted prompt (turn 1 / seq 0 based; the bridge
 * renumbers them): reasoning, a short reply, one read call, a closing line.
 */
function replyTemplate(): VisualSessionLog['events'] {
  const log = new ShowcaseLog(FIXTURE_TIME)
  log.stepStart(1, 1)
  log.stream(1, 1, [
    { reasoning: '先看一下入口文件，再给出结论。' },
    { text: '我先读取入口文件确认结构。' },
    {
      tool: {
        id: 'call_reply_read',
        name: 'read',
        args: { file_path: 'src/main.ts' },
      },
    },
  ])
  log.call(1, 1, 'call_reply_read', 'read', { file_path: 'src/main.ts' })
  log.result(
    1,
    1,
    'call_reply_read',
    "import { createApp } from 'vue'\nimport App from './App.vue'\n\ncreateApp(App).mount('#app')\n",
    { meta: { path: 'src/main.ts', startLine: 1, endLine: 4, totalLines: 4 } },
  )
  log.stepEnd(1, 1)
  log.stepStart(1, 2)
  log.stream(1, 2, [
    {
      text: "入口很简单：`createApp(App).mount('#app')`。界面改动都集中在 `App.vue` 之下。",
    },
  ])
  log.stepEnd(1, 2)
  log.turnEnd(1)
  return log.events as unknown as VisualSessionLog['events']
}

export async function installVisualCoreBridge(
  page: Page,
  options: { sessionLogs?: VisualSessionLog[] } = {},
) {
  await page.addInitScript(
    ({ projectDir, sessionLogs, replyEvents }) => {
      const now = '2026-06-26T12:00:00.000Z'
      const visualParams = new URLSearchParams(window.location.search)
      const visualPlanEnabled = visualParams.get('visualPlan') === 'on'
      const visualGoalPhase = visualParams.get('visualGoal')
      const visualTheme = visualParams.get('visualTheme')
      const visualQueueEnabled = visualParams.get('visualQueue') === 'on'
      const visualControlMode = visualParams.get('visualControl')
      const visualProgressMode = visualParams.get('visualProgress')
      if (visualTheme === 'light' || visualTheme === 'dark')
        localStorage.setItem('emperor.theme', visualTheme)
      const project = {
        project_id: 'visual_project',
        project_path: projectDir,
        project_name: 'Visual Build Project',
        summary: 'Fixture project for renderer visual tests.',
      }
      const visualCommands = [
        visualCommand('help', '系统与诊断', '打开命令中心', {
          kind: 'local_ui',
          surface: 'command_center',
        }),
        visualCommand('status', '系统与诊断', '查看当前执行状态', {
          kind: 'local_ui',
          surface: 'status',
        }),
        visualCommand('clear', '会话与历史', '创建全新上下文', {
          busyPolicy: 'after_turn',
          dangerous: true,
        }),
        visualCommand('plan', '模型与执行', '开启 Plan 并生成实施方案', {
          busyPolicy: 'after_turn',
          argumentHint: '[on|off|status|open|description]',
        }),
        visualCommand('goal', '模型与执行', '启动或管理长期 Goal', {
          busyPolicy: 'after_turn',
          argumentHint: '[start|status|list|pause|resume|cancel]',
        }),
        visualCommand('files', '能力与工作台', '打开项目文件工作区', {
          kind: 'local_ui',
          surface: 'files',
          argumentHint: '[path|query]',
        }),
        {
          ...visualCommand(
            'visual-audit',
            '项目 Skill',
            '运行项目专属视觉审计',
            {
              kind: 'agent_prompt',
              busyPolicy: 'after_turn',
              argumentHint: '[scope]',
            },
          ),
          id: 'skill.project.visual-audit',
          source: 'project_skill',
          skill: {
            name: 'visual-audit',
            context: 'inline',
            agent: null,
            allowedTools: [],
            effort: null,
          },
        },
      ]
      const sessions = [
        session('build-ui', '构建 Visual UI', 'build', project),
        session('build-api', '构建 Visual API', 'build', project),
        session('missing-path', '缺失项目路径', 'build', {
          project_id: 'missing_visual_project',
          project_path: `${projectDir}/missing`,
          project_name: 'Missing visual project',
        }),
        session('chat-main', '普通对话', 'chat'),
      ]
      const modelUnavailable = visualParams.get('visualModel') === 'unavailable'
      const profileOnboarding = {
        status:
          visualParams.get('visualProfile') === 'pending'
            ? 'pending'
            : 'completed',
        sessionId: null as string | null,
        interactionId: null as string | null,
        attemptCount: 0,
        lastError: null as string | null,
        canStart: true,
        canSkip: true,
      }
      const profileOnboardingQuestions = [
        {
          id: 'preferred_address',
          header: '称呼',
          question: '我平时怎么称呼你？',
          options: [
            { label: '直接称呼“你”', description: '不记录额外称呼' },
            { label: '自定义称呼', description: '填写昵称或称呼' },
            { label: '暂不设置', description: '以后再补充' },
          ],
        },
      ]
      const profileOnboardingFollowupQuestions = [
        {
          id: 'working_style',
          header: '协作方式',
          question: '你希望我怎样推进日常协作？',
          options: [
            { label: '主动推进', description: '边界清晰时直接完成' },
            { label: '关键步骤确认', description: '重要决策先征求意见' },
            { label: '按任务判断', description: '根据风险动态选择' },
          ],
        },
      ]
      const visualModelEntry = {
        entryId: 'visual-entry',
        provider: 'visual',
        protocol: 'openai',
        modelId: 'visual-main',
        displayName: 'Visual Local',
        effectiveDisplayName: 'Visual Local',
        apiBase: 'https://visual.example/v1',
        apiKey: '',
        capabilityOverrides: { vision: true },
        contextWindowTokens: 128000,
        maxTokens: 4096,
        reasoningEffort: 'high',
        resolvedProfile: {
          toolCall: true,
          vision: true,
          reasoning: true,
          sources: {
            toolCall: 'inferred',
            vision: 'override',
            reasoning: 'inferred',
          },
          contextWindowTokens: 128000,
          maxTokens: 4096,
          reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          reasoningAdapter: 'openai',
        },
      }
      const visualSecondaryEntry = {
        ...visualModelEntry,
        entryId: 'anthropic-entry',
        provider: 'anthropic',
        protocol: 'anthropic',
        modelId: 'claude-visual-sonnet',
        displayName: 'Claude Visual',
        effectiveDisplayName: 'Claude Visual',
        apiBase: 'https://api.anthropic.com',
        reasoningEffort: 'medium',
      }
      const visualCurrent = {
        entryId: 'visual-entry',
        provider: 'visual',
        providerLabel: 'Visual Provider',
        protocol: 'openai',
        modelId: 'visual-main',
        displayName: 'Visual Local',
        effectiveDisplayName: 'Visual Local',
        apiBase: 'https://visual.example/v1',
        reasoningEffort: 'high',
        contextWindowTokens: 128000,
        maxTokens: 4096,
        capabilities: { toolCall: true, vision: true, reasoning: true },
        capabilitySources: visualModelEntry.resolvedProfile.sources,
        reasoningEfforts: visualModelEntry.resolvedProfile.reasoningEfforts,
        reasoningAdapter: 'openai',
      }
      const currentForEntry = (entry: any) => ({
        ...visualCurrent,
        entryId: entry.entryId,
        provider: entry.provider,
        providerLabel:
          entry.provider === 'anthropic' ? 'Anthropic' : 'Visual Provider',
        protocol: entry.protocol,
        modelId: entry.modelId,
        displayName: entry.displayName || null,
        effectiveDisplayName: entry.displayName || entry.modelId,
        apiBase: entry.apiBase,
        reasoningEffort: entry.reasoningEffort ?? null,
        contextWindowTokens: entry.contextWindowTokens,
        maxTokens: entry.maxTokens,
        capabilities: {
          toolCall: entry.resolvedProfile.toolCall,
          vision: entry.resolvedProfile.vision,
          reasoning: entry.resolvedProfile.reasoning,
        },
        capabilitySources: entry.resolvedProfile.sources,
        reasoningEfforts: entry.resolvedProfile.reasoningEfforts,
      })
      const modelConfig: any = {
        schemaVersion: 2,
        activeModelId: modelUnavailable ? null : 'visual-entry',
        models: modelUnavailable
          ? []
          : [visualModelEntry, visualSecondaryEntry],
        availability: modelUnavailable
          ? {
              usable: false,
              code: 'model_configuration_required',
              message: '还没有可用模型，请先配置模型。',
              action: 'open_model_settings',
              provider: null,
            }
          : {
              usable: true,
              message: '模型已配置',
              provider: 'visual',
            },
        current: modelUnavailable ? null : visualCurrent,
        providerOptions: [
          {
            name: 'visual',
            displayName: 'Visual Provider',
            protocols: ['openai'],
            defaultProtocol: 'openai',
            apiBases: { openai: 'https://visual.example/v1' },
            iconId: 'openai',
            region: 'local',
            isLocal: true,
            modelDiscovery: { openai: 'openai_compat' },
          },
          {
            name: 'anthropic',
            displayName: 'Anthropic',
            protocols: ['anthropic'],
            defaultProtocol: 'anthropic',
            apiBases: { anthropic: 'https://api.anthropic.com' },
            iconId: 'anthropic',
            region: 'global',
            isLocal: false,
            modelDiscovery: { anthropic: 'anthropic' },
          },
        ],
      }
      const memory = {
        long_term: '偏好：保持界面紧凑，优先展示可操作状态。',
        today_episode: '今天完成 TypeScript 迁移视觉检查。',
        episodes: ['2026-06-26', '2026-06-25', '2026-06-23'],
        context: {
          mode: 'build',
          session: sessions[0],
          project,
          projectMemory: '项目记忆：视觉测试使用固定 Core bridge fixture。',
          projectIndexSummary: 'README.md: Visual Build Project',
          sources: ['MEMORY.local.md', 'project/index.json'],
        },
        history: {
          active_lines: 4,
          active_bytes: 2048,
          archive_files: 1,
          archive_bytes: 8192,
        },
        runtime: {
          bytes: 18432,
          events: 42,
          latestSeq: 128,
          activeTurns: 1,
          activeTurnEvents: 6,
          archiveFiles: 0,
        },
        compaction: {
          cursor: {
            compactedUntilSeq: 96,
            status: 'active',
            lastCompactionId: 'cmp_visual_3',
          },
          archive: { compactedUntilSeq: 96, archivedUntilSeq: 64 },
          latest: { status: 'completed', compactionId: 'cmp_visual_3' },
        },
        schedulerMaintenance: {
          jobs: 1,
          enabled: 1,
          nextRunAtMs: Date.now() + 3600000,
        },
        watchlist: {
          content: '- [ ] 检查发布产物',
          lastDecision: {
            action: 'skip',
            reason: 'visual fixture',
            checkedAt: Date.now(),
          },
        },
        versions: {
          versions: [
            {
              id: 'ver_visual_3',
              target: 'memory',
              relPath: 'memory/MEMORY.local.md',
              label: 'MEMORY.local.md · v3',
              reason: 'save',
              createdAt: Math.floor(Date.now() / 1000) - 1800,
              contentHash: 'c3',
              bytes: 1480,
            },
            {
              id: 'ver_visual_2',
              target: 'user',
              relPath: 'memory/profile/USER.local.md',
              label: 'USER.local.md · v2',
              reason: 'profile_interview',
              createdAt: Math.floor(Date.now() / 1000) - 86400,
              contentHash: 'c2',
              bytes: 912,
            },
            {
              id: 'ver_visual_1',
              target: 'episode',
              relPath: 'memory/episodes/2026-06-25.md',
              label: '2026-06-25.md · v1',
              reason: 'compaction',
              createdAt: Math.floor(Date.now() / 1000) - 3 * 86400,
              contentHash: 'c1',
              bytes: 2310,
            },
          ],
          count: 3,
        },
        tokenTotals: { input: 1200, output: 640, total: 1840, calls: 3 },
        tokensByModel: {
          'visual-main': { input: 1200, output: 640, total: 1840, calls: 3 },
        },
        tokensByUsageType: {
          chat: { input: 1200, output: 640, total: 1840, calls: 3 },
        },
      }
      const scheduler: Record<string, any> = {
        status: {
          running: true,
          jobs: 3,
          enabled: 2,
          nextRunAtMs: Date.now() + 3600000,
          lastError: null,
          active: 0,
          queued: 0,
          maxConcurrentRuns: 2,
          maxPerOwner: 1,
        },
        jobs: [
          {
            id: 'job_daily_digest',
            name: '每日站会摘要',
            enabled: true,
            schedule: {
              kind: 'cron',
              expr: '0 9 * * 1-5',
              tz: 'Asia/Shanghai',
            },
            payload: {
              kind: 'agent_turn',
              message: '汇总昨天的提交、未关闭的 PR 与阻塞项，生成站会摘要。',
              deliver: true,
            },
            misfirePolicy: 'latest',
            createdAtMs: Date.now() - 12 * 86400000,
            updatedAtMs: Date.now() - 2 * 86400000,
            state: {
              nextRunAtMs: Date.now() + 5 * 3600000,
              lastRunAtMs: Date.now() - 19 * 3600000,
              lastStatus: 'ok',
              runHistory: [
                {
                  runId: 'run_digest_1',
                  taskId: 'task_41',
                  runAtMs: Date.now() - 67 * 3600000,
                  scheduledForMs: Date.now() - 67 * 3600000,
                  status: 'error',
                  durationMs: 4200,
                  error: 'model_configuration_required',
                },
                {
                  runId: 'run_digest_2',
                  taskId: 'task_52',
                  runAtMs: Date.now() - 43 * 3600000,
                  scheduledForMs: Date.now() - 43 * 3600000,
                  status: 'ok',
                  durationMs: 38000,
                },
                {
                  runId: 'run_digest_3',
                  taskId: 'task_63',
                  runAtMs: Date.now() - 19 * 3600000,
                  scheduledForMs: Date.now() - 19 * 3600000,
                  status: 'ok',
                  durationMs: 41000,
                },
              ],
            },
          },
          {
            id: 'job_weekly_report',
            name: '周报整理',
            enabled: false,
            deleteAfterRun: false,
            schedule: { kind: 'every', everyMs: 7 * 86400000 },
            payload: {
              kind: 'agent_turn',
              message: '整理本周完成事项与下周计划，写入 docs/weekly.md。',
              deliver: false,
            },
            createdAtMs: Date.now() - 30 * 86400000,
            updatedAtMs: Date.now() - 6 * 86400000,
            state: {
              nextRunAtMs: null,
              lastRunAtMs: Date.now() - 7 * 86400000,
              lastStatus: 'error',
              lastError: 'Scheduler run interrupted: app closed during run',
              runHistory: [
                {
                  runId: 'run_weekly_1',
                  taskId: 'task_12',
                  runAtMs: Date.now() - 7 * 86400000,
                  status: 'interrupted',
                  durationMs: 91000,
                  missedCount: 2,
                  countCapped: false,
                  error: 'app closed during run',
                },
              ],
            },
          },
          {
            id: 'memory-maintenance',
            name: 'Memory maintenance',
            enabled: true,
            protected: true,
            schedule: { kind: 'every', everyMs: 3600000 },
            payload: { kind: 'system_event', message: 'memory-maintenance' },
            state: {
              nextRunAtMs: Date.now() + 3600000,
              lastStatus: 'ok',
              lastRunAtMs: Date.now() - 3600000,
            },
            purpose: 'Visual fixture',
          },
        ],
        diagnostics: {},
      }
      const syncScheduler = () => {
        const jobs = scheduler.jobs as Array<Record<string, any>>
        scheduler.status = {
          ...scheduler.status,
          jobs: jobs.length,
          enabled: jobs.filter((job) => job.enabled).length,
        }
        // IPC results are structured clones: hand back a fresh copy.
        return JSON.parse(JSON.stringify(scheduler))
      }
      // Deterministic ~5 months of token usage relative to the real clock
      // (the heatmap / 7 天 / 30 天 windows are computed from today).
      const visualTokens = () => {
        const fields = [
          'input',
          'output',
          'cache_read',
          'cache_create',
          'total',
          'calls',
        ]
        const empty = (): Record<string, any> => ({
          input: 0,
          output: 0,
          cache_read: 0,
          cache_create: 0,
          total: 0,
          calls: 0,
        })
        const add = (target: Record<string, any>, row: Record<string, any>) => {
          for (const field of fields)
            target[field] = (target[field] || 0) + (row[field] || 0)
        }
        const models = [
          ['deepseek', 'deepseek-chat', 0.5, 0.72],
          ['anthropic', 'claude-sonnet-4-5', 0.26, 0.55],
          ['visual', 'visual-main', 0.12, 0.3],
          ['openai', 'gpt-5-mini', 0.07, 0.2],
          ['qwen', 'qwen3-coder', 0.04, 0],
          ['moonshot', 'kimi-k2', 0.01, 0],
        ] as const
        let seed = 11
        const rand = () => {
          seed = (seed * 16807) % 2147483647
          return seed / 2147483647
        }
        const pad = (value: number) => String(value).padStart(2, '0')
        const iso = (d: Date) =>
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const byDate: Record<string, any> = {}
        const byDateModel: Record<string, any> = {}
        const byModel: Record<string, any> = {}
        const totals = empty()
        for (let back = 150; back >= 0; back -= 1) {
          const day = new Date(today)
          day.setDate(today.getDate() - back)
          const weekend = day.getDay() === 0 || day.getDay() === 6
          if (back > 0 && rand() < (weekend ? 0.62 : 0.16)) continue
          const volume = (30000 + rand() * 240000) * (back < 30 ? 1.5 : 1)
          const date = iso(day)
          byDate[date] = empty()
          byDateModel[date] = {}
          for (const [provider, model, weight, cache] of models) {
            if (weight < 0.1 && rand() < 0.5) continue
            const total = Math.round(volume * weight * (0.6 + rand() * 0.8))
            const output = Math.round(total * 0.14)
            const fresh = total - output
            const cacheRead = Math.round(fresh * cache * (0.75 + rand() * 0.25))
            const cacheCreate = Math.round((fresh - cacheRead) * 0.12)
            const row = {
              input: fresh - cacheRead - cacheCreate,
              output,
              cache_read: cacheRead,
              cache_create: cacheCreate,
              total,
              calls: Math.max(1, Math.round(total / 9000)),
            }
            const key = `${provider}/${model}`
            byDateModel[date][key] = { ...row, provider, model }
            add(byDate[date], row)
            add(totals, row)
            byModel[key] ??= { ...empty(), provider, model }
            add(byModel[key], row)
          }
        }
        const scaled = (factor: number) => {
          const row = empty()
          for (const field of fields)
            row[field] = Math.round((totals[field] || 0) * factor)
          return row
        }
        const byHour: Record<string, any> = {}
        for (let hour = 0; hour < 24; hour += 1) {
          const weight =
            hour < 8 ? 0.004 : hour < 12 ? 0.07 : hour < 14 ? 0.03 : 0.06
          byHour[pad(hour)] = scaled(hour === 15 ? 0.11 : weight)
        }
        const stamp = (minutesAgo: number) => {
          const d = new Date(Date.now() - minutesAgo * 60000)
          return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        }
        const recentCacheCalls = [
          [4, 'deepseek', 'deepseek-chat', 'main_agent', 1820, 640, 38200, 0],
          [
            11,
            'anthropic',
            'claude-sonnet-4-5',
            'main_agent',
            2400,
            910,
            21800,
            3100,
          ],
          [
            26,
            'deepseek',
            'deepseek-chat',
            'subagent:reviewer',
            900,
            420,
            16400,
            0,
          ],
          [
            48,
            'deepseek',
            'deepseek-chat',
            'memory_compaction',
            5200,
            1300,
            9800,
            1200,
          ],
        ].map(([ago, provider, model, usage, input, output, read, create]) => ({
          ts: stamp(Number(ago)),
          provider,
          model,
          usage_type: usage,
          input: Number(input),
          output: Number(output),
          cache_read: Number(read),
          cache_create: Number(create),
          total: Number(input) + Number(output) + Number(read) + Number(create),
        }))
        return {
          totals,
          byDate,
          byModel,
          byUsageType: {
            main_agent: scaled(0.78),
            memory_compaction: scaled(0.09),
            'subagent:reviewer': scaled(0.1),
            title_generation: {
              ...scaled(0.03),
              cache_read: 0,
              cache_create: 0,
            },
          },
          byDateModel,
          byHour,
          streak: {
            active_days: Object.keys(byDate).length,
            current_streak: 4,
            longest_streak: 19,
          },
          sessions: sessions.length * 23,
          messages: 1186,
          recentCalls: recentCacheCalls,
          recentCacheCalls,
          generatedAt: stamp(0),
        }
      }
      const team = {
        members: [
          {
            name: 'reviewer',
            role: 'reviewer',
            agent_type: 'reviewer',
            status: 'idle',
            unread: 0,
            tools: ['read_file'],
          },
        ],
        leadUnread: 0,
        leadInbox: [],
        config: { version: 1, team_name: 'Visual Team', members: [] },
      }
      // Claude Code hooks.json fixture (hooks-service payload shapes).
      const hooksContent = JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Write|Edit',
                hooks: [
                  {
                    type: 'command',
                    command: 'node scripts/guard-write.mjs',
                    timeout: 10,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [{ type: 'command', command: 'npm run lint --silent' }],
              },
            ],
          },
        },
        null,
        2,
      )
      const hooksPayload = {
        path: '~/.emperor/hooks.json',
        content: `${hooksContent}\n`,
        files: ['~/.emperor/hooks.json', `${projectDir}/.claude/settings.json`],
        events: { PreToolUse: 1, Stop: 1 },
        errors: [] as string[],
        supportedEvents: [
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
          'SubagentStart',
          'SubagentStop',
        ],
      }
      const hooksMetadata = {
        format: 'claude-code',
        path: '~/.emperor/hooks.json',
        events: [
          { eventName: 'PreToolUse', matcher: 'tool_name' },
          { eventName: 'PostToolUse', matcher: 'tool_name' },
          { eventName: 'Stop', matcher: null },
          { eventName: 'SessionStart', matcher: 'source' },
        ],
        handlerTypes: ['command'],
        matcher: {
          literal: '精确匹配工具名，如 Write',
          regex: '正则匹配，如 Write|Edit',
        },
        substitutions: ['$CLAUDE_PROJECT_DIR'],
        defaults: { timeoutSec: 60 },
      }
      const hooksAudit = {
        cursor: '0',
        nextCursor: null,
        total: 1,
        badLines: [],
        records: [
          {
            handlerId: 'audit-command',
            eventName: 'PreToolUse',
            turn: 3,
            dialect: 'claude-code',
            matcher: 'Write|Edit',
            outcome: 'allow',
            exitCode: 0,
            stderrSummary: null,
            durationMs: 42,
            invokedAt: Date.parse(now),
            completedAt: Date.parse(now) + 42,
          },
        ],
      }
      const environmentListeners = new Set<VisualCoreListener>()
      const terminalListeners = new Set<VisualCoreListener>()
      const sessionEventListeners = new Set<VisualCoreListener>()
      const visualSidebarState = {
        section_order: ['projects', 'chats'],
        project_sort: 'updated_at',
        chat_sort: 'updated_at',
        project_order: [],
        chat_order: [],
        project_session_order: {},
        collapsed_project_ids: [],
        right_workspace: {
          open: true,
          width: 360,
          pane: 'environment',
        },
      }
      const visualGitStatus = {
        repository: {
          root: projectDir,
          commonDir: `${projectDir}/.git`,
          worktreeRoot: projectDir,
          branch: 'main',
          headOid: '18d26534aabbccddeeff00112233445566778899',
          defaultBranch: 'main',
          detached: false,
          unborn: false,
          objectFormat: 'sha1' as const,
          transientState: 'none' as const,
        },
        root: projectDir,
        branch: 'main',
        head: '18d26534aabbccddeeff00112233445566778899',
        upstream: 'origin/main',
        detached: false,
        ahead: 2,
        behind: 0,
        files: [
          {
            path: 'src/workspace.ts',
            index: 'M',
            worktree: '.',
            conflict: false,
            untracked: false,
          },
          {
            path: 'README.md',
            index: '.',
            worktree: 'M',
            conflict: false,
            untracked: false,
          },
          {
            path: 'notes/验收记录.md',
            index: '?',
            worktree: '?',
            conflict: false,
            untracked: true,
          },
        ],
        summary: {
          changedFiles: 3,
          additions: 18,
          deletions: 4,
          untracked: 1,
          binary: 0,
        },
        truncated: false,
        revision: 'visual-git-revision',
      }
      const visualTerminal = {
        id: 'terminal_visual',
        sessionId: 'build-ui',
        pid: 4242,
        cwd: projectDir,
        title: 'zsh',
        createdAt: Date.parse(now),
        exited: false,
        exitCode: null,
      }
      const environmentTools = [
        {
          id: 'git',
          category: 'base',
          required: true,
          reason: '基础文件能力与 GitHub Skill 来源需要 Git',
          declarationSource: null,
          status: 'ready',
          detectedVersion: '2.55.0',
          versionSummary: 'git 2.55.0',
          requiredVersion: '>=2.40.0',
          executablePath: '/usr/bin/git',
          installStrategy: 'git-system',
          sourceUrl: 'https://git-scm.com',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
        {
          id: 'node',
          category: 'project',
          required: true,
          reason: 'package.json 声明 Node 24',
          declarationSource: 'package.json#engines.node',
          status: 'version_mismatch',
          detectedVersion: '22.16.0',
          versionSummary: 'node 22.16.0',
          requiredVersion: '>=24.0.0',
          executablePath: '/usr/local/bin/node',
          installStrategy: 'node-volta',
          sourceUrl: 'https://nodejs.org',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
        {
          id: 'python',
          category: 'skill',
          required: true,
          reason: 'blocked-visual Skill 需要 Python',
          declarationSource: 'skills/blocked-visual/SKILL.md',
          status: 'missing',
          detectedVersion: null,
          versionSummary: null,
          requiredVersion: '>=3.12.0',
          executablePath: null,
          installStrategy: 'python-uv',
          sourceUrl: 'https://www.python.org',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
        {
          id: 'msvc-build-tools',
          category: 'large-prerequisite',
          required: false,
          reason: '当前平台不需要此大型依赖',
          declarationSource: null,
          status: 'unsupported',
          detectedVersion: null,
          versionSummary: null,
          requiredVersion: null,
          executablePath: null,
          installStrategy: null,
          sourceUrl: null,
          requiresElevation: true,
          requiresSeparateConfirmation: true,
        },
      ]
      const environmentPayload = {
        status: {
          cacheKey: 'd'.repeat(64),
          catalogRevision: 'a'.repeat(64),
          projectFingerprint: 'b'.repeat(64),
          project: {
            projectRoot: projectDir,
            fingerprint: 'b'.repeat(64),
            declarations: {},
            files: ['package.json'],
            diagnostics: [],
          },
          platform: 'darwin',
          arch: 'arm64',
          pathEntries: ['/usr/bin', '/usr/local/bin'],
          tools: environmentTools,
          skills: [
            {
              skillName: 'blocked-visual',
              status: 'blocked',
              requiredTools: ['python'],
              missing: ['python'],
              unsupported: [],
            },
          ],
          diagnostics: [],
        },
        catalog: {
          revision: 'a'.repeat(64),
          release: '2026.07',
          licenses: [
            {
              id: 'mit',
              name: 'MIT License',
              spdx: 'MIT',
              url: 'https://opensource.org/license/mit',
            },
            {
              id: 'python-psf-2',
              name: 'Python Software Foundation License 2.0',
              spdx: 'PSF-2.0',
              url: 'https://docs.python.org/3/license.html',
            },
          ],
          tools: [
            {
              id: 'node',
              displayName: 'Node.js',
              pinnedVersion: '24.18.0',
              licenseId: 'mit',
              strategies: [
                {
                  id: 'node-volta',
                  kind: 'version_manager',
                  sourceUrl: 'https://nodejs.org',
                  publisher: 'OpenJS Foundation',
                  estimatedBytes: 48000000,
                  requiresElevation: false,
                  requiresSeparateConfirmation: false,
                  cancellable: true,
                },
              ],
            },
            {
              id: 'python',
              displayName: 'Python',
              pinnedVersion: '3.12.11',
              licenseId: 'python-psf-2',
              strategies: [
                {
                  id: 'python-uv',
                  kind: 'version_manager',
                  sourceUrl: 'https://www.python.org',
                  publisher: 'Python Software Foundation',
                  estimatedBytes: 34000000,
                  requiresElevation: false,
                  requiresSeparateConfirmation: false,
                  cancellable: true,
                },
              ],
            },
          ],
        },
        activeJob: null as Record<string, unknown> | null,
        recentJobs: [] as Array<Record<string, unknown>>,
      }
      let environmentCancelled = false
      const environmentLogs = [
        {
          schemaVersion: 1,
          timestamp: now,
          jobId: 'job_visual',
          level: 'info',
          kind: 'job_started',
          message: 'Environment installation started.',
          details: {},
        },
      ]
      const supportedGoalPhases = new Set([
        'contract',
        'planning',
        'executing',
        'verifying',
        'awaiting_user',
        'paused',
      ])
      const normalizedGoalPhase = supportedGoalPhases.has(
        String(visualGoalPhase),
      )
        ? String(visualGoalPhase)
        : null
      const visualGoal = normalizedGoalPhase
        ? {
            id: 'goal_visual_lifecycle',
            status: 'active',
            phase: normalizedGoalPhase,
            outcome: '让 Composer 的 Goal 生命周期清晰、可控并且可恢复',
            sessionId: 'build-ui',
            currentPlanId: visualPlanEnabled ? 'plan_visual' : null,
            cyclesUsed: 2,
            acceptance: {
              passed: normalizedGoalPhase === 'verifying' ? 1 : 0,
              failed: 0,
              missing: normalizedGoalPhase === 'verifying' ? 1 : 2,
              total: 2,
              criteria: [],
            },
            createdAt: new Date(Date.now() - 23_000).toISOString(),
            updatedAt: new Date().toISOString(),
            lastEventSeq: 1,
          }
        : null
      const boot = {
        app: 'Emperor Agent',
        model: 'visual-main',
        provider: 'visual',
        providerLabel: 'Visual Provider',
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            read_only: true,
            source: 'builtin',
            concurrency_safe: true,
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: '要读取的文件路径（相对工作区）。',
                },
                offset: { type: 'integer', description: '起始行号。' },
                limit: { type: 'integer', description: '最多读取的行数。' },
              },
              required: ['path'],
            },
          },
          {
            name: 'run_command',
            description: 'Run a command',
            read_only: false,
            source: 'builtin',
            exclusive: true,
            parameters: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: '要执行的 shell 命令。',
                },
                timeout_ms: { type: 'integer', description: '超时时间。' },
                sandbox: {
                  type: 'string',
                  enum: ['read-only', 'workspace-write'],
                  description: '执行时的沙箱模式。',
                },
              },
              required: ['command'],
            },
          },
        ],
        plugins: [
          {
            pluginId: 'emperor/web-research',
            name: 'Web Research',
            scope: 'user',
            version: '1.4.0',
            digest: 'b'.repeat(64),
            source: { kind: 'local', label: 'web-research' },
            signature: { status: 'local_user_source', publisher: null },
            enabled: true,
            materialization: 'installed',
            activation: 'active',
            capabilities: {
              skills: 2,
              agents: 0,
              hooks: 1,
              mcpServers: 1,
              lspServers: 0,
              commands: 0,
            },
          },
          {
            pluginId: 'acme/release-notes',
            name: 'Release Notes',
            scope: 'project',
            version: '0.3.2',
            digest: 'c'.repeat(64),
            source: { kind: 'url', url: 'https://plugins.acme.dev/notes.zip' },
            signature: { status: 'unverified', publisher: null },
            enabled: true,
            materialization: 'installed',
            activation: 'blocked_unverified',
            capabilities: {
              skills: 1,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              lspServers: 0,
              commands: 1,
            },
          },
          {
            pluginId: 'emperor/pdf-tools',
            name: 'PDF Tools',
            scope: 'user',
            version: '2.0.1',
            digest: 'd'.repeat(64),
            source: { kind: 'local', label: 'pdf-tools.zip' },
            signature: { status: 'local_user_source', publisher: null },
            enabled: false,
            materialization: 'installed',
            activation: 'disabled',
            capabilities: {
              skills: 3,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              lspServers: 0,
              commands: 0,
            },
          },
        ] as Array<Record<string, any>>,
        skills: [
          {
            name: 'visual-fixture',
            description: 'Fixture skill',
            path: 'skills/visual-fixture/SKILL.md',
            tags: '',
            always: false,
            source: 'user',
            status: 'active',
            readOnly: false,
            requirements: { bins: [], runtimes: [], env: [] },
          },
          {
            name: 'blocked-visual',
            description: '等待 Python 依赖后启用',
            path: 'skills/blocked-visual/SKILL.md',
            tags: '',
            always: false,
            source: 'user',
            status: 'blocked',
            readOnly: false,
            requirements: { bins: [], runtimes: ['python'], env: [] },
          },
        ] as Array<{
          name: string
          description: string
          path: string
          tags: string
          always: boolean
          source: string
          status: string
          readOnly: boolean
          requirements: { bins: string[]; runtimes: string[]; env: string[] }
        }>,
        memory,
        modelConfig,
        profileOnboarding,
        scheduler,
        team,
        control: {
          mode: visualPlanEnabled ? 'plan' : 'ask_before_edit',
          previous_mode: visualPlanEnabled ? 'auto' : null,
          plan: visualPlanEnabled,
          pending: null as Record<string, unknown> | null,
        },
        goals: {
          active: visualGoal,
          recent: visualGoal ? [visualGoal] : [],
        },
        desktopPet: {
          enabled: false,
          autoStartWithWebui: false,
          running: false,
          installCommand: 'npm install',
        },
        diagnostics: {
          root: projectDir,
          paths: {
            runtimeRoot: '/Applications/Emperor.app/Contents/Resources/app',
            stateRoot: '/Users/visual/.emperor',
            stateRootSource: 'default',
            sessionsRoot: '/Users/visual/.emperor/sessions',
            attachmentsRoot: '/Users/visual/.emperor/attachments',
            mcpConfigPath: '/Users/visual/.emperor/mcp_config.json',
          },
          workspacePolicy: { workspaceRoot: projectDir },
          modelConfig: {
            status: 'ok',
            exists: true,
            models: modelConfig.models.length,
          },
          localConfig: { status: 'ok', exists: true },
          scheduler: { jobsFile: 'memory/scheduler/jobs.json' },
          runtime: { events: 0, latestSeq: 1 },
          desktopPet: {
            enabled: false,
            running: false,
            autoStartWithWebui: false,
            installCommand: 'npm install',
          },
          dependencies: { nodeRuntime: true, desktopRenderer: true },
          environment: {
            catalogRevision: 'a'.repeat(64),
            platform: 'darwin',
            arch: 'arm64',
            projectRoot: projectDir,
            required: 3,
            ready: 1,
            missing: 1,
            versionMismatch: 1,
            blockedSkills: 1,
            diagnostics: [],
            activeJob: null,
          },
        },
        projects: [project],
        runtime: {
          latestSeq: 1,
          sessionId: 'build-ui',
          busy: false,
          scope: 'unarchived',
          events: [] as Array<Record<string, unknown>>,
        },
        unarchivedHistory: [],
        context_used: 12000,
      }
      const visualQueuedPrompts = visualQueueEnabled
        ? [
            {
              id: 'prompt_visual_queue',
              turnId: 'turn_visual_queue',
              clientMessageId: 'prompt_visual_queue',
              delivery: 'queue',
              state: 'queued',
              content: '继续补充视觉验收细节',
              displayContent: '继续补充视觉验收细节',
              supportsInterjection: true,
              createdOrder: 1,
              createdAt: now,
              updatedAt: now,
              attachmentIds: [],
              requestedSkills: [],
            },
          ]
        : []
      if (visualQueueEnabled) {
        boot.runtime.busy = true
        boot.runtime.latestSeq = 2
        boot.runtime.events = [
          {
            event: 'message_delta',
            seq: 2,
            session_id: 'build-ui',
            turn_id: 'turn_visual_queue_owner',
            id: 'assistant_visual_queue_owner',
            delta: '我正在整理当前任务的视觉验收边界。',
            timestamp: now,
          },
        ]
      }

      const visualAskInteraction = {
        id: 'ask_visual_bottom',
        kind: 'ask',
        status: 'waiting',
        created_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
        parent_call_id: 'call_visual_bottom_ask',
        context: '确认最终展示密度。',
        questions: [
          {
            id: 'visual_density',
            header: '展示密度',
            question: '底部控制面板采用哪种信息密度？',
            options: [
              {
                id: 'compact',
                label: '紧凑展示',
                description: '保持主要操作在一屏内完成',
              },
              {
                id: 'detailed',
                label: '完整展示',
                description: '保留更多说明和上下文',
              },
            ],
          },
        ],
        answers: {},
        title: '',
        summary: '',
        plan_markdown: '',
        assumptions: [],
        risk_level: 'low',
        comments: [],
        meta: { control_session_id: 'build-ui' },
      }
      const visualPlanInteraction = {
        id:
          visualControlMode === 'plan-stream'
            ? 'provisional-plan-visual-bottom'
            : 'plan_visual_bottom',
        kind: 'plan',
        status: 'waiting',
        created_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
        parent_call_id: 'call_visual_bottom_plan',
        context: '',
        questions: [],
        answers: {},
        title: '底部交互与单槽队列实施计划',
        summary: '将审批与消息输入互斥投影到底部控制槽。',
        plan_markdown:
          '# 底部交互与单槽队列实施计划\n\n1. 静态保留时间线提案。\n2. 底部审批替代 Composer。\n3. 回答后恢复草稿。',
        assumptions: ['Composer 草稿由 renderer 会话状态持有'],
        risk_level: 'medium',
        comments: [],
        meta: {
          control_session_id: 'build-ui',
          ...(visualControlMode === 'plan-stream'
            ? { plan_stream_id: 'visual-bottom', provisional: true }
            : {}),
        },
      }
      const visualMultiAskInteraction = {
        ...visualAskInteraction,
        id: 'ask_visual_multi',
        questions: [
          {
            id: 'visual_surfaces',
            header: '验收范围',
            question: '这次视觉回归需要覆盖哪些界面？',
            multi_select: true,
            options: [
              {
                id: 'sidebar',
                label: '侧栏',
                description: '展开、图标栏与搜索',
              },
              {
                id: 'composer',
                label: '输入框',
                description: '芯片、菜单与 Dock',
              },
              {
                id: 'takeover',
                label: '接管卡片',
                description: '审批、提问与计划',
              },
              { id: 'settings', label: '设置弹窗', description: '十三个分区' },
            ],
          },
          visualAskInteraction.questions[0]!,
        ],
      }
      const visualPermissionInteraction = {
        ...visualAskInteraction,
        id: 'ask_visual_permission',
        context: 'Permission Guard',
        questions: [
          {
            id: 'permission',
            header: '权限',
            question: '允许执行以下操作吗？',
            options: [
              { id: 'allow_once', label: '允许本次', description: '' },
              { id: 'deny', label: '拒绝', description: '' },
            ],
          },
        ],
        meta: {
          control_session_id: 'build-ui',
          interaction_type: 'permission',
          permission: {
            version: 2,
            operation_count: 1,
            operations: [
              {
                tool_name: 'bash',
                risk: 'medium',
                reason: '需要在项目目录运行测试并写入截图文件',
                summary: 'npm --prefix desktop run screenshots',
                execution_boundary: 'sandbox',
              },
            ],
          },
        },
      }
      if (
        visualControlMode === 'ask' ||
        visualControlMode === 'plan' ||
        visualControlMode === 'ask-multi' ||
        visualControlMode === 'permission'
      ) {
        const interaction =
          visualControlMode === 'ask'
            ? visualAskInteraction
            : visualControlMode === 'ask-multi'
              ? visualMultiAskInteraction
              : visualControlMode === 'permission'
                ? visualPermissionInteraction
                : visualPlanInteraction
        boot.control.pending = interaction
        sessions[0]!.control_pending = {
          kind: interaction.kind,
          label:
            interaction.kind === 'plan' ? '计划需要用户确认' : '需要用户输入',
          tone: interaction.kind === 'plan' ? 'green' : 'blue',
          interaction_id: interaction.id,
          updated_at: Date.now() / 1000,
        }
        boot.runtime.latestSeq = 3
        boot.runtime.events = [
          {
            event: interaction.kind === 'plan' ? 'plan_draft' : 'ask_request',
            seq: 2,
            session_id: 'build-ui',
            turn_id: 'turn_visual_bottom_control',
            interaction,
            timestamp: now,
          },
          {
            event: 'turn_paused',
            seq: 3,
            session_id: 'build-ui',
            turn_id: 'turn_visual_bottom_control',
            interaction,
            timestamp: now,
          },
        ]
      } else if (visualControlMode === 'plan-stream') {
        boot.runtime.latestSeq = 2
        boot.runtime.events = [
          {
            event: 'plan_draft_delta',
            seq: 2,
            session_id: 'build-ui',
            turn_id: 'turn_visual_bottom_plan_stream',
            tool_call_id: 'visual-bottom',
            interaction: visualPlanInteraction,
            timestamp: now,
          },
        ]
      }
      if (visualProgressMode === 'running') {
        boot.runtime.busy = true
        boot.runtime.latestSeq = 5
        boot.runtime.events = [
          {
            event: 'user_message',
            seq: 1,
            session_id: 'build-ui',
            turn_id: 'turn_visual_progress',
            content: '实现底部执行进度',
            timestamp: now,
          },
          {
            event: 'message_delta',
            seq: 2,
            session_id: 'build-ui',
            turn_id: 'turn_visual_progress',
            delta: '正在实现执行进度胶囊，并同步核对文件变更。',
            timestamp: now,
          },
          {
            event: 'plan_runtime_update',
            seq: 3,
            session_id: 'build-ui',
            turn_id: 'turn_visual_progress',
            plan: {
              id: 'plan_visual_progress',
              title: '执行进度与变更摘要',
              status: 'executing',
              steps: [
                { id: 'step-1', title: '读取执行要求', status: 'completed' },
                { id: 'step-2', title: '实现进度胶囊', status: 'active' },
                { id: 'step-3', title: '接入变更统计', status: 'pending' },
                { id: 'step-4', title: '精简历史 Todo', status: 'pending' },
                { id: 'step-5', title: '验证键盘交互', status: 'pending' },
                { id: 'step-6', title: '完成视觉回归', status: 'pending' },
              ],
            },
            timestamp: now,
          },
          {
            event: 'turn_change_snapshot',
            version: 2,
            seq: 4,
            session_id: 'build-ui',
            turn_id: 'turn_visual_progress',
            turnId: 'turn_visual_progress',
            executionId: 'execution_visual_progress',
            rootTurnId: 'turn_visual_progress',
            activeTurnId: 'turn_visual_progress',
            status: 'tracking',
            filesChanged: 3,
            additions: 301,
            deletions: 0,
            binaryFiles: 0,
            truncated: false,
            files: [
              {
                path: 'ComposerProgressStatus.vue',
                kind: 'created',
                additions: 148,
                deletions: 0,
                binary: false,
              },
              {
                path: 'ChatView.vue',
                kind: 'modified',
                additions: 42,
                deletions: 0,
                binary: false,
              },
              {
                path: 'codex-v2.css',
                kind: 'modified',
                additions: 111,
                deletions: 0,
                binary: false,
              },
            ],
            timestamp: now,
          },
          {
            event: 'thought_delta',
            seq: 5,
            session_id: 'build-ui',
            turn_id: 'turn_visual_progress',
            content: '核对弹框位置和底部安全间距。',
            timestamp: now,
          },
        ]
      } else if (visualProgressMode === 'final') {
        boot.runtime.busy = false
        boot.runtime.latestSeq = 4
        boot.runtime.events = [
          {
            event: 'user_message',
            seq: 1,
            session_id: 'build-ui',
            turn_id: 'turn_visual_final',
            content: '修复最终文件变更摘要',
            timestamp: now,
          },
          {
            event: 'message_delta',
            seq: 2,
            session_id: 'build-ui',
            turn_id: 'turn_visual_final',
            delta: '最终摘要已经并入回答时间线，并保持与正文相同的内容宽度。',
            timestamp: now,
          },
          {
            event: 'assistant_done',
            seq: 3,
            session_id: 'build-ui',
            turn_id: 'turn_visual_final',
            content: '最终摘要已经并入回答时间线，并保持与正文相同的内容宽度。',
            timestamp: now,
          },
          {
            event: 'turn_change_snapshot',
            version: 2,
            seq: 4,
            session_id: 'build-ui',
            turn_id: 'turn_visual_final',
            turnId: 'turn_visual_final',
            executionId: 'execution_visual_final',
            rootTurnId: 'turn_visual_final',
            activeTurnId: 'turn_visual_final',
            status: 'complete',
            filesChanged: 1,
            additions: 366,
            deletions: 0,
            binaryFiles: 0,
            truncated: false,
            files: [
              {
                path: 'index.html',
                kind: 'created',
                additions: 366,
                deletions: 0,
                binary: false,
              },
            ],
            timestamp: now,
          },
        ]
      }
      let visualRuntimeSeq = boot.runtime.latestSeq

      // Legacy fixture-only events outside the Core wire contract; the
      // renderer rejects them on the live channel (replay tolerates them).
      const unregisteredLiveEvents = new Set(['turn_paused', 'ready'])
      function emitVisualRuntime(event: Record<string, unknown>) {
        if (unregisteredLiveEvents.has(String(event.event))) return
        const payload = { ...event, seq: ++visualRuntimeSeq }
        boot.runtime.events.push(payload)
        boot.runtime.latestSeq = visualRuntimeSeq
        for (const listener of environmentListeners) listener(payload)
      }

      // ── raw session logs (sessions.history / lineage / children) ─────────
      type RawEvent = {
        seq: number
        type: string
        time?: number
        data?: Record<string, unknown>
        surfaceOp?: string
      }
      const rawLogs = new Map<
        string,
        { header: Record<string, unknown>; events: RawEvent[] }
      >()
      for (const log of sessionLogs)
        rawLogs.set(log.id, {
          header: log.header,
          events: log.events as RawEvent[],
        })
      function registerSessionLog(
        id: string,
        header: Record<string, unknown>,
        events: RawEvent[],
      ) {
        rawLogs.set(id, { header: { ...header, id }, events })
      }
      ;(
        window as unknown as {
          __visualRegisterSessionLog?: typeof registerSessionLog
        }
      ).__visualRegisterSessionLog = registerSessionLog
      function emitSessionEvents(sessionId: string, events: RawEvent[]) {
        if (!events.length) return
        for (const target of sessionEventListeners)
          target({ sessionId, events })
      }
      function appendRaw(
        sessionId: string,
        type: string,
        data: Record<string, unknown>,
        surfaceOp?: string,
      ): RawEvent {
        let log = rawLogs.get(sessionId)
        if (!log) {
          log = {
            header: { version: 0, id: sessionId, createdAt: Date.now() },
            events: [],
          }
          rawLogs.set(sessionId, log)
        }
        const event: RawEvent = {
          seq: (log.events.at(-1)?.seq ?? -1) + 1,
          type,
          time: Date.now(),
          data,
          ...(surfaceOp ? { surfaceOp } : {}),
        }
        log.events.push(event)
        emitSessionEvents(sessionId, [event])
        return event
      }
      /** Parent session and delegation description of a child id. */
      function parentOf(
        childId: string,
      ): { sessionId: string; description?: string; callId?: string } | null {
        for (const [id, log] of rawLogs)
          for (const event of log.events)
            if (
              event.type === 'subagent/started' &&
              event.data?.subagentId === childId
            )
              return {
                sessionId: id,
                description: String(event.data?.description ?? ''),
                callId: String(event.data?.callId ?? ''),
              }
        return null
      }
      function lineageOf(sessionId: string) {
        const chain: Array<Record<string, unknown>> = []
        let current: string | null = sessionId
        for (let depth = 0; current && depth < 16; depth += 1) {
          const parent = parentOf(current)
          chain.unshift({
            sessionId: current,
            ...(parent?.description ? { description: parent.description } : {}),
            ...(parent?.callId ? { parentCallId: parent.callId } : {}),
          })
          current = parent?.sessionId ?? null
        }
        return { chain }
      }
      function childrenOf(sessionId: string) {
        const log = rawLogs.get(sessionId)
        if (!log) return []
        const children = new Map<string, Record<string, unknown>>()
        for (const event of log.events) {
          const data = event.data ?? {}
          if (event.type === 'subagent/started')
            children.set(String(data.subagentId), {
              subagentId: data.subagentId,
              callId: data.callId,
              description: data.description ?? '',
              mode: data.mode ?? 'spawn',
              background: data.background === true,
              status: 'running',
            })
          if (event.type === 'subagent/settled') {
            const child = children.get(String(data.subagentId))
            if (child) {
              child.status = 'settled'
              child.stopReason = data.stopReason
            }
          }
        }
        return [...children.values()]
      }
      if (visualParams.get('visualTodos') === 'on') {
        const buildLog = rawLogs.get('build-ui')
        buildLog?.events.push({
          seq: (buildLog.events.at(-1)?.seq ?? -1) + 1,
          type: 'todo/write',
          time: Date.now(),
          data: {
            todos: [
              { content: '读取 dsh 设计规格', status: 'completed' },
              { content: '实现 AppFrame 三栏外壳', status: 'completed' },
              { content: '重做输入框与 Dock', status: 'in_progress' },
              { content: '截图并修复视觉缺陷', status: 'pending' },
            ],
          },
        })
      }

      /**
       * chat.submit: append the user message and a new turn to the raw log
       * at once (the bubble shows through the live session-event path), then
       * stream the reply template, renumbered onto this session and turn.
       */
      function streamVisualReply(
        sessionId: string,
        input: { content?: string; displayContent?: string },
      ) {
        const log = rawLogs.get(sessionId)
        const turn =
          (log?.events.filter((event) => event.type === 'turn/start').length ??
            0) + 1
        const turnId = `${sessionId}:${turn}`
        const text = String(input.displayContent || input.content || '')
        appendRaw(
          sessionId,
          'user/message',
          {
            id: `visual-user-${turn}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          },
          'append',
        )
        appendRaw(sessionId, 'turn/start', { turn })
        emitVisualRuntime({
          event: 'turn_phase',
          session_id: sessionId,
          turn_id: turnId,
          phase: 'started',
        })
        const pending = (replyEvents as RawEvent[]).map((event) => ({
          type: event.type,
          surfaceOp: event.surfaceOp,
          data: {
            ...(event.data ?? {}),
            ...(typeof event.data?.turn === 'number' ? { turn } : {}),
          },
        }))
        const delay = Number(visualParams.get('visualReplyMs') || 45)
        const timer = setInterval(() => {
          const next = pending.shift()
          if (!next) {
            clearInterval(timer)
            emitVisualRuntime({
              event: 'assistant_done',
              session_id: sessionId,
              turn_id: turnId,
              content: '',
            })
            return
          }
          appendRaw(sessionId, next.type, next.data, next.surfaceOp)
        }, delay)
        return { turnId }
      }

      function session(
        id: string,
        title: string,
        mode: VisualSessionMode,
        projectInfo?: VisualProjectInfo,
      ) {
        return {
          id,
          title,
          created_at: now,
          updated_at: now,
          preview:
            mode === 'build' ? 'Visual build session' : 'Visual chat session',
          mode,
          project_id: projectInfo?.project_id ?? null,
          project_path: projectInfo?.project_path ?? null,
          project_name: projectInfo?.project_name ?? null,
          message_count: 2,
          title_status: 'ready',
          archived_at: null,
          version: 1,
          control_pending: null as Record<string, unknown> | null,
        }
      }

      function visualCommand(
        name: string,
        category: string,
        description: string,
        options: {
          kind?: 'local_ui' | 'core_action' | 'agent_prompt'
          busyPolicy?: 'immediate' | 'after_turn' | 'reject_when_busy'
          surface?: string
          argumentHint?: string
          dangerous?: boolean
        } = {},
      ) {
        return {
          id: `builtin.${name}`,
          name,
          aliases: [],
          hiddenAliases: [],
          category,
          description,
          kind: options.kind ?? 'core_action',
          source: 'builtin',
          busyPolicy: options.busyPolicy ?? 'immediate',
          argumentSchema: [],
          argumentHint: options.argumentHint,
          userInvocable: true,
          invocationSources: ['desktop'],
          available: true,
          uiSurface: options.surface,
          dangerous: options.dangerous,
        }
      }

      // ── MCP settings fixture (mcp.* ops) ────────────────────────────
      // Masked config view (Core shows every secret leaf as [REDACTED]);
      // `?visualMcp=empty` starts without servers. Imports connect at once.
      type VisualMcpServer = {
        name: string
        transport: string
        enabled: boolean
        command: string | null
        args: string[]
        env: Record<string, string>
        url: string | null
        headers: Record<string, string>
        tool_overrides: Record<string, Record<string, unknown>>
      }
      const visualMcpTools: Record<string, Record<string, string>> = {
        github: {
          search_repositories:
            '按关键词搜索 GitHub 仓库，返回名称、星标和简介。',
          get_file_contents: '读取仓库中指定路径的文件或目录内容。',
          create_issue: '在指定仓库创建 issue，可附带标签与负责人。',
        },
        context7: {
          'resolve-library-id': '把库名解析为 Context7 可识别的库 ID。',
          'get-library-docs': '获取指定库的最新文档片段与代码示例。',
        },
        aihot: {
          get_hot_topics: '获取当前 AI 领域的热门话题与新闻摘要。',
          search_news: '按关键词检索 AI 热点新闻。',
        },
      }
      const visualMcpFailures: Record<
        string,
        { state: string; code: string; message: string }
      > = {
        linear: {
          state: 'auth_failed',
          code: 'mcp_auth_failed',
          message: 'MCP server authentication failed (HTTP 401)',
        },
      }
      function visualMcpServer(
        name: string,
        patch: Partial<VisualMcpServer>,
      ): VisualMcpServer {
        return {
          name,
          transport: 'stdio',
          enabled: true,
          command: null,
          args: [],
          env: {},
          url: null,
          headers: {},
          tool_overrides: {},
          ...patch,
        }
      }
      const visualMcpServers: Record<string, VisualMcpServer> =
        visualParams.get('visualMcp') === 'empty'
          ? {}
          : {
              github: visualMcpServer('github', {
                command: 'npx',
                args: ['[REDACTED]', '[REDACTED]'],
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: '[REDACTED]' },
              }),
              context7: visualMcpServer('context7', {
                transport: 'http',
                url: 'https://mcp.context7.com/mcp',
              }),
              linear: visualMcpServer('linear', {
                transport: 'sse',
                url: 'https://mcp.linear.app/sse',
                headers: { Authorization: '[REDACTED]' },
              }),
              filesystem: visualMcpServer('filesystem', {
                enabled: false,
                command: 'npx',
                args: ['[REDACTED]', '[REDACTED]', '[REDACTED]'],
              }),
            }
      function visualMcpConfig() {
        return {
          servers: JSON.parse(JSON.stringify(visualMcpServers)) as Record<
            string,
            VisualMcpServer
          >,
          defaults: { read_only: false, exclusive: false },
        }
      }
      function visualMcpStatus() {
        const servers = Object.values(visualMcpServers)
          .filter((server) => server.enabled)
          .map((server) => {
            const failure = visualMcpFailures[server.name]
            const tools = failure
              ? []
              : Object.keys(visualMcpTools[server.name] ?? { ping: '' })
            return {
              serverName: server.name,
              transport: server.transport,
              generation: 1,
              clientId: `client_${server.name}`,
              state: failure?.state ?? 'ready',
              health: failure ? 'unhealthy' : 'healthy',
              auth: failure ? 'failed' : 'ok',
              toolCount: tools.length,
              tools,
              restartAttempts: 0,
              nextRetryAt: null,
              activeRequestCount: 0,
              activeRequestIds: [],
              lastError: failure
                ? { code: failure.code, message: failure.message }
                : null,
            }
          })
        return {
          initialized: true,
          servers,
          ready: servers.filter((server) => server.state === 'ready').length,
          configured: servers.length,
          tools: servers.reduce((total, server) => total + server.toolCount, 0),
          toolCapabilities: [],
        }
      }
      function syncVisualMcp() {
        const status = visualMcpStatus()
        const tools = boot.tools as Array<Record<string, unknown>>
        const builtin = tools.filter((tool) => tool.source !== 'mcp')
        const mcp = status.servers.flatMap((server) =>
          server.tools.map((tool) => ({
            name: `mcp_${server.serverName}_${tool}`,
            description:
              visualMcpTools[server.serverName]?.[tool] ?? 'Fixture MCP tool',
            read_only: true,
            source: 'mcp',
            server: server.serverName,
          })),
        )
        tools.splice(0, tools.length, ...builtin, ...mcp)
        ;(boot as unknown as { mcp: unknown }).mcp = status
      }
      function visualMcpNotFound(name: string) {
        return {
          ok: false,
          error: {
            message: `MCP server '${name}' is not configured`,
            code: 'mcp_server_not_found',
          },
        }
      }
      function visualMcpImport(input: unknown) {
        const body = (input ?? {}) as {
          raw?: unknown
          overwrite?: boolean | string[]
          dryRun?: boolean
        }
        let value = body.raw
        if (typeof value === 'string') {
          const text = value.trim()
          try {
            value = JSON.parse(text.startsWith('"') ? `{${text}}` : text)
          } catch {
            return {
              ok: false,
              error: {
                message: '无法解析 MCP 配置：不是有效的 JSON',
                code: 'mcp_import_invalid',
              },
            }
          }
        }
        const root = (value ?? {}) as Record<string, any>
        const entries = Object.entries(
          (root.mcpServers ??
            root.servers ??
            root.mcp?.servers ??
            root) as Record<string, Record<string, any>>,
        )
        const plan = {
          added: [] as string[],
          updated: [] as string[],
          skipped: [] as string[],
          conflicts: [] as string[],
          warnings: [] as string[],
          servers: [] as Array<Record<string, unknown>>,
          dryRun: body.dryRun === true,
        }
        const replace = (name: string) =>
          body.overwrite === true ||
          (Array.isArray(body.overwrite) && body.overwrite.includes(name))
        for (const [name, config] of entries) {
          const declared = String(config.type ?? config.transport ?? '')
          const transport = /^(stdio|sse)$/.test(declared)
            ? declared
            : declared || !config.command
              ? 'http'
              : 'stdio'
          if (transport !== 'stdio' && !config.url) {
            plan.warnings.push(`已跳过 "${name}"：${transport} server 缺少 url`)
            continue
          }
          const server = visualMcpServer(name, {
            transport,
            command: transport === 'stdio' ? String(config.command) : null,
            args: (config.args ?? []).map(() => '[REDACTED]'),
            url:
              transport === 'stdio'
                ? null
                : String(config.url).replace(/=([^&#]*)/g, '=[REDACTED]'),
            headers: Object.fromEntries(
              Object.keys(config.headers ?? {}).map((key) => [
                key,
                '[REDACTED]',
              ]),
            ),
            env: Object.fromEntries(
              Object.keys(config.env ?? {}).map((key) => [key, '[REDACTED]']),
            ),
          })
          const conflict = name in visualMcpServers
          const action = !conflict ? 'add' : replace(name) ? 'update' : 'skip'
          if (conflict) plan.conflicts.push(name)
          ;(action === 'add'
            ? plan.added
            : action === 'update'
              ? plan.updated
              : plan.skipped
          ).push(name)
          if (action === 'skip')
            plan.warnings.push(
              `server "${name}" 已存在，未覆盖（设置 overwrite 以替换）`,
            )
          plan.servers.push({
            name,
            transport,
            target:
              transport === 'stdio'
                ? [config.command, ...(config.args ?? [])].join(' ')
                : server.url,
            enabled: true,
            action,
            conflict,
          })
          if (!plan.dryRun && action !== 'skip') {
            delete visualMcpFailures[name]
            visualMcpServers[name] = server
          }
        }
        if (!plan.dryRun) syncVisualMcp()
        return { ...plan, config: visualMcpConfig(), status: visualMcpStatus() }
      }
      syncVisualMcp()

      // ── Skills settings fixture (skills.* ops) ─────────────────────────
      const visualSkillHome = '/Users/visual/.emperor/skills'
      type VisualSkill = {
        name: string
        description: string
        path: string
        root: string
        skillFile: string
        tags: string
        always: boolean
        source: string
        status: string
        readOnly: boolean
        flat: boolean
        requirements: { bins: string[]; runtimes: string[]; env: string[] }
        command: null
        warnings: string[]
        content: string
      }
      function visualSkillDoc(name: string, description: string) {
        return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## 何时使用\n\n- ${description}\n\n## 步骤\n\n1. 阅读相关文件。\n2. 按约定完成任务并说明结果。\n`
      }
      function visualSkill(
        input: Partial<VisualSkill> & { name: string; source: string },
        base: string,
      ): VisualSkill {
        const root = `${base}/${input.name}`
        const description = input.description ?? 'Visual fixture'
        return {
          path: `skills/${input.name}/SKILL.md`,
          root,
          skillFile: `${root}/SKILL.md`,
          tags: '',
          always: false,
          status: 'active',
          readOnly: input.source === 'builtin' || input.source === 'plugin',
          flat: false,
          requirements: { bins: [], runtimes: [], env: [] },
          command: null,
          warnings: [],
          content: visualSkillDoc(input.name, description),
          ...input,
          description,
        }
      }
      const visualSkills: VisualSkill[] = [
        ...boot.skills.map((skill) =>
          visualSkill({ ...skill }, visualSkillHome),
        ),
        visualSkill(
          {
            name: 'release-notes',
            source: 'project',
            description: '根据提交记录整理发布说明，按模块归类变更。',
            tags: 'release git',
            requirements: { bins: ['git'], runtimes: [], env: [] },
            warnings: [
              'Folder name "release_notes" differs from the frontmatter name "release-notes"',
            ],
          },
          `${projectDir}/.emperor/skills`,
        ),
        visualSkill(
          {
            name: 'skill-creator',
            source: 'builtin',
            description:
              '创建或更新 Skill：规划结构、编写 SKILL.md，并用 skill_manage 保存。',
            tags: 'meta authoring',
          },
          '/Applications/Emperor.app/Contents/Resources/skills',
        ),
        visualSkill(
          {
            name: 'docx',
            source: 'plugin',
            description: '读取、编辑和生成 Word 文档，保留格式与修订记录。',
            tags: 'office documents',
            requirements: { bins: [], runtimes: ['python'], env: [] },
          },
          '/Users/visual/.emperor/plugins/office/skills',
        ),
      ]
      const visualInvalidSkills = [
        {
          name: 'broken-yaml',
          source: 'user',
          path: `${visualSkillHome}/broken-yaml`,
          reason: 'SKILL.md frontmatter is not valid YAML',
          errors: [
            'YAML parse error at line 3, column 14: bad indentation of a mapping entry',
          ],
          warnings: [] as string[],
        },
        {
          name: 'legacy-helper',
          source: 'project',
          path: `${projectDir}/.emperor/skills/legacy-helper.md`,
          reason: 'SKILL.md needs a description',
          errors: ['frontmatter "description" is required'],
          warnings: [
            'Folder Skills (<name>/SKILL.md) are preferred over a single .md file',
          ],
        },
      ]
      function visualSkillPayload(skill: VisualSkill) {
        const payload: Partial<VisualSkill> = { ...skill }
        delete payload.content
        return payload
      }
      function visualSkillError(message: string, code: string, action = '') {
        return {
          ok: false,
          error: { message, code, ...(action ? { action } : {}) },
        }
      }
      function visualSkillFrontmatter(content: string) {
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
        if (!match) return null
        const data: Record<string, string> = {}
        for (const line of (match[1] ?? '').split(/\r?\n/)) {
          const entry = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
          if (entry)
            data[entry[1]!] = (entry[2] ?? '')
              .replace(/^['"]|['"]$/g, '')
              .trim()
        }
        return data
      }
      function visualValidateSkill(content: string, folder = '') {
        const data = visualSkillFrontmatter(content)
        const errors: string[] = []
        const warnings: string[] = []
        if (!data)
          errors.push('SKILL.md must start with YAML frontmatter (---)')
        else {
          if (!data.name) errors.push('frontmatter "name" is required')
          else if (!/^[a-z0-9][a-z0-9._-]*$/.test(data.name))
            errors.push(
              `Invalid Skill name "${data.name}": use lowercase letters, digits, "-", "_" or "."`,
            )
          if (!data.description)
            errors.push('frontmatter "description" is required')
          if (folder && data.name && folder !== data.name)
            warnings.push(
              `Folder name "${folder}" differs from the frontmatter name "${data.name}"`,
            )
          if (!/\n#{1,6}\s/.test(content))
            warnings.push(
              'SKILL.md has no Markdown heading after the frontmatter',
            )
        }
        return {
          name: data?.name || folder,
          valid: errors.length === 0,
          errors,
          warnings,
          source: 'virtual',
          path: null,
        }
      }
      function visualSkillDetail(skill: VisualSkill) {
        return { ...visualSkillPayload(skill), content: skill.content }
      }
      function visualImportSkill(
        name: string,
        content: string,
        scope: string,
        overwrite: boolean,
        warnings: string[] = [],
      ) {
        const existing = visualSkills.findIndex((item) => item.name === name)
        if (
          existing >= 0 &&
          visualSkills[existing]!.source === scope &&
          !overwrite
        )
          return {
            error: {
              code: 'skill_exists',
              name,
              path: '.',
              reason: `A Skill named "${name}" already exists; choose overwrite to replace it`,
            },
          }
        const data = visualSkillFrontmatter(content) ?? {}
        const base =
          scope === 'project'
            ? `${projectDir}/.emperor/skills`
            : visualSkillHome
        const skill = visualSkill(
          {
            name,
            source: scope,
            description: data.description || 'Imported Skill',
            content,
          },
          base,
        )
        if (existing >= 0) visualSkills.splice(existing, 1, skill)
        else visualSkills.push(skill)
        return {
          imported: {
            name,
            scope,
            path: skill.root,
            warnings,
            replaced: existing >= 0,
          },
        }
      }
      function visualSkillsImport(input: unknown) {
        const body = (input ?? {}) as {
          source: {
            kind: string
            content?: string
            name?: string
            path?: string
            url?: string
          }
          scope: string
          overwrite?: boolean
        }
        const result = {
          imported: [] as unknown[],
          errors: [] as unknown[],
        }
        const add = (
          name: string,
          content: string,
          warnings: string[] = [],
        ) => {
          const outcome = visualImportSkill(
            name,
            content,
            body.scope,
            body.overwrite === true,
            warnings,
          )
          if (outcome.error) result.errors.push(outcome.error)
          else result.imported.push(outcome.imported)
        }
        const source = body.source
        if (source.kind === 'content') {
          const content = String(source.content ?? '')
          const check = visualValidateSkill(content)
          const name = String(source.name || check.name || '').trim()
          if (!check.valid || !name)
            return visualSkillError(
              check.errors[0] ?? 'Enter a Skill name',
              'skill_invalid',
            )
          add(name, content.replace(/^name:.*$/m, `name: ${name}`))
        } else if (source.kind === 'folder') {
          const name =
            String(source.path ?? '')
              .split('/')
              .filter(Boolean)
              .pop() || 'folder-skill'
          add(name, visualSkillDoc(name, '从本地文件夹导入的 Skill。'))
        } else if (source.kind === 'zip') {
          add(
            'pdf-tools',
            visualSkillDoc('pdf-tools', '拆分、合并与批注 PDF。'),
          )
          add(
            'sheet-helper',
            visualSkillDoc('sheet-helper', '整理表格并生成透视汇总。'),
            ['Skipped .venv (virtual environment) while copying'],
          )
          result.errors.push({
            code: 'skill_invalid',
            name: null,
            path: 'extras/notes',
            reason: 'SKILL.md must start with YAML frontmatter (---)',
          })
        } else {
          const url = String(source.url ?? '')
          if (!/^https:\/\/github\.com\//.test(url))
            return visualSkillError(
              `Download failed (HTTP 404): ${url}`,
              'skill_import_failed',
            )
          const name =
            url.split('/').filter(Boolean).pop()?.toLowerCase() ||
            'github-skill'
          add(name, visualSkillDoc(name, '从 GitHub 导入的 Skill。'), [
            'Skipped node_modules while copying',
          ])
        }
        return result
      }

      window.emperor = {
        version: '0.1.0-visual',
        platform: 'visual',
        selectDirectory: async () => projectDir,
        getPathForFile: () => `${projectDir}/visual-skill.zip`,
        selectFile: async () => `${projectDir}/visual-skills.zip`,
        openSkillsFolder: async (input: { scope?: string }) => {
          const path =
            input?.scope === 'project'
              ? `${projectDir}/.emperor/skills`
              : visualSkillHome
          ;((
            window as unknown as { __visualOpenedPaths?: string[] }
          ).__visualOpenedPaths ??= []).push(path)
          return { ok: true, path }
        },
        openPath: async (target: string) => {
          ;((
            window as unknown as { __visualOpenedPaths?: string[] }
          ).__visualOpenedPaths ??= []).push(target)
          return { ok: true }
        },
        onCoreEvent: (listener: VisualCoreListener) => {
          environmentListeners.add(listener)
          return () => environmentListeners.delete(listener)
        },
        onTerminalEvent: (listener: VisualCoreListener) => {
          terminalListeners.add(listener)
          return () => terminalListeners.delete(listener)
        },
        onSessionEvents: (listener: VisualCoreListener) => {
          ;(
            window as unknown as {
              __visualEmitSessionEvents?: (batch: unknown) => void
            }
          ).__visualEmitSessionEvents = (batch) => {
            for (const target of sessionEventListeners) target(batch)
          }
          sessionEventListeners.add(listener)
          return () => sessionEventListeners.delete(listener)
        },
        invokeCore: async (operationKey: string, ...args: unknown[]) => {
          switch (operationKey) {
            case 'bootstrap':
              return boot
            case 'commands.list':
              return visualCommands
            case 'commands.complete':
              return []
            case 'commands.invoke':
              return {
                status: 'rejected',
                code: 'visual_command_not_executed',
                message: '视觉夹具不执行命令副作用。',
              }
            case 'sessions.list':
              return sessions
            case 'sessions.activate':
              return { active: args[0], complete: true }
            case 'sessions.history': {
              const input = args[0] as { sessionId: string }
              // Raw session-log fixture (sessionLogFixture.ts), when installed.
              const fixtureHistory = (
                window as unknown as {
                  __visualSessionHistory?: (query: unknown) => unknown
                }
              ).__visualSessionHistory
              const page = fixtureHistory?.(input)
              if (page !== undefined && page !== null) return page
              const raw = rawLogs.get(input.sessionId)
              const beforeSeq = (input as { beforeSeq?: number }).beforeSeq
              const events = (raw?.events ?? []).filter(
                (event) => beforeSeq === undefined || event.seq < beforeSeq,
              )
              return {
                header: raw?.header ?? {
                  version: 0,
                  id: input.sessionId,
                  createdAt: 0,
                },
                events,
                hasMore: false,
                lastSeq: raw?.events.at(-1)?.seq ?? -1,
              }
            }
            case 'sessions.lineage':
              return lineageOf((args[0] as { sessionId: string }).sessionId)
            case 'sessions.children':
              return childrenOf((args[0] as { sessionId: string }).sessionId)
            case 'chat.submit': {
              const input = (args[0] ?? {}) as {
                sessionId?: string
                clientDraftId?: string
                content?: string
                displayContent?: string
              }
              // Recorded so specs can assert where a message was sent.
              const record = window as unknown as {
                __visualSubmits?: Array<Record<string, unknown>>
              }
              ;(record.__visualSubmits ??= []).push({ ...input })
              // Core promotes a draft on its first message and announces the
              // real session before the turn starts; the renderer has to
              // follow. Mirror that here or the draft path goes untested.
              const target = String(input.sessionId || '')
              if (!target.startsWith('draft:'))
                return streamVisualReply(target, input)
              const promoted = session(
                `created-${sessions.length}`,
                '新会话',
                'chat',
              )
              sessions.unshift(promoted)
              emitVisualRuntime({
                event: 'session_created',
                session_id: promoted.id,
                session: promoted,
                client_draft_id: String(input.clientDraftId || target),
              })
              return streamVisualReply(promoted.id, input)
            }
            case 'tasks.cancel':
              return true
            case 'sessions.watch':
              return {
                watching: (args[0] as { sessionIds: string[] }).sessionIds,
              }
            case 'sessions.create': {
              const body = (args[0] ?? {}) as {
                title?: string
                mode?: VisualSessionMode
                project?: VisualProjectInfo
              }
              const created = session(
                `created-${sessions.length}`,
                body.title || '新会话',
                body.mode || 'chat',
                body.project,
              )
              sessions.unshift(created)
              return created
            }
            case 'chat.listQueuedPrompts': {
              const ownerSessionId = String(
                ((args[0] || {}) as { sessionId?: string }).sessionId || '',
              )
              return ownerSessionId === 'build-ui' ? visualQueuedPrompts : []
            }
            case 'projects.resolve':
              return project
            case 'projects.list':
              return [project]
            case 'workspace.snapshot':
              return {
                version: 1,
                sessionId: 'build-ui',
                project: {
                  id: project.project_id,
                  name: project.project_name,
                  path: project.project_path,
                },
                git: visualGitStatus,
                plan: {
                  id: 'plan_visual_workspace',
                  title: '完成右侧项目工作台',
                  status: 'executing',
                  steps: [
                    { id: 'step_core', status: 'completed' },
                    { id: 'step_renderer', status: 'active' },
                    { id: 'step_verify', status: 'pending' },
                  ],
                },
                goal: {
                  outcome: '交付可验证的项目工作台',
                  phase: 'execution',
                },
                subagents: [
                  {
                    id: 'subagent_visual',
                    title: 'Review Git service',
                    status: 'completed',
                    started_at: Date.parse(now) - 84_000,
                    ended_at: Date.parse(now),
                    metadata: {
                      agent_type: 'reviewer',
                      workspace_mode: 'shared',
                    },
                  },
                ],
                team: {
                  members: team.members,
                  leadUnread: 1,
                },
                processes: [
                  {
                    id: 'process_visual_dev',
                    label: 'npm run dev',
                    status: 'running',
                  },
                ],
                terminals: [visualTerminal],
                capturedAt: Date.parse(now),
              }
            case 'git.status':
              return visualGitStatus
            case 'git.branches':
              return {
                current: 'main',
                branches: [
                  {
                    name: 'main',
                    head: visualGitStatus.head,
                    upstream: 'origin/main',
                  },
                  {
                    name: 'codex/workspace-panel',
                    head: '99887766554433221100ffeeddccbbaa00112233',
                    upstream: null,
                  },
                ],
              }
            case 'git.worktrees':
              return {
                worktrees: [
                  {
                    path: projectDir,
                    head: visualGitStatus.head,
                    branch: 'main',
                    detached: false,
                    locked: false,
                    prunable: false,
                    ownerSessionId: null,
                    owned: false,
                    active: true,
                  },
                ],
                owned: [],
              }
            case 'git.pullRequest':
              return null
            case 'git.diff':
              return {
                content:
                  'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n # Visual Build Project\n+\n+Workspace review fixture.\n',
                truncated: false,
              }
            case 'git.compare':
              return {
                baseRef: 'codex/workspace-panel',
                headRef: 'HEAD',
                ahead: 2,
                behind: 0,
                diff: 'diff --git a/README.md b/README.md\n',
                truncated: false,
              }
            case 'git.stage':
            case 'git.unstage':
            case 'git.discard':
            case 'git.commit':
            case 'git.fetch':
            case 'git.pull':
            case 'git.push':
            case 'git.createBranch':
            case 'git.switchBranch':
              return visualGitStatus
            case 'files.list':
            case 'files.search':
              return {
                projectRoot: projectDir,
                relativePath: '',
                entries: [
                  {
                    name: 'src',
                    path: 'src',
                    kind: 'directory',
                    bytes: 96,
                    modifiedAt: Date.parse(now),
                    hidden: false,
                  },
                  {
                    name: 'README.md',
                    path: 'README.md',
                    kind: 'file',
                    bytes: 68,
                    modifiedAt: Date.parse(now),
                    hidden: false,
                  },
                  {
                    name: 'package.json',
                    path: 'package.json',
                    kind: 'file',
                    bytes: 420,
                    modifiedAt: Date.parse(now),
                    hidden: false,
                  },
                ],
                nextCursor: null,
                truncated: false,
              }
            case 'files.read':
              return {
                projectRoot: projectDir,
                relativePath: String(
                  ((args[0] || {}) as { relativePath?: string }).relativePath ||
                    'README.md',
                ),
                name: 'README.md',
                kind: 'text',
                mimeType: 'text/markdown',
                bytes: 68,
                truncated: false,
                content:
                  '# Visual Build Project\n\nA project workspace visual fixture.\n',
              }
            case 'terminals.list':
              return [visualTerminal]
            case 'terminals.create':
              return visualTerminal
            case 'terminals.read':
              return {
                terminalId: visualTerminal.id,
                chunks: [
                  {
                    seq: 1,
                    data: `\u001b[32mvisual@emperor\u001b[0m ${projectDir}\r\n$ git status --short\r\n M README.md\r\n`,
                  },
                ],
                latestSeq: 1,
                exited: false,
                exitCode: null,
              }
            case 'terminals.write':
            case 'terminals.resize':
            case 'terminals.close':
              return { ok: true }
            case 'memory.get':
              return memory
            case 'memory.tokens':
              return visualTokens()
            case 'memory.getEpisode': {
              const date = String(args[0] || '2026-06-26')
              return {
                date,
                content: `# ${date}\n\n- 完成 TypeScript 迁移视觉检查\n- 设置页按 dsh 规格重写 Scheduler / 记忆 / 用量\n- 待办：补齐截图并逐张检查\n`,
              }
            }
            case 'memory.getVersion': {
              const id = String(args[0] || '')
              const version =
                memory.versions.versions.find((item) => item.id === id) ||
                memory.versions.versions[0]
              return {
                version,
                content: '偏好：保持界面紧凑。\n回答使用中文，命令保留英文。\n',
                currentContent: `${memory.long_term}\n回答使用中文，命令保留英文。\n`,
                diff: '',
              }
            }
            case 'memory.restoreVersion':
              return {
                restored: { path: 'memory/MEMORY.local.md', content: '' },
                memory: JSON.parse(JSON.stringify(memory)),
              }
            case 'memory.save':
              memory.long_term = String(args[0] ?? '')
              return memory
            case 'memory.saveEpisode':
              return {
                date: String(args[1] || ''),
                content: String(args[0] ?? ''),
              }
            case 'memory.saveWatchlist':
              memory.watchlist = {
                ...memory.watchlist,
                content: String(args[0] ?? ''),
              }
              return memory.watchlist
            case 'memory.checkWatchlist':
              return {
                decision: memory.watchlist.lastDecision,
                watchlist: memory.watchlist,
              }
            case 'model.getConfig':
              return modelConfig
            case 'model.resolveProfile': {
              const input = (args[0] || {}) as any
              const reasoning = /gpt|claude|visual/i.test(input.modelId || '')
              return {
                ...visualModelEntry.resolvedProfile,
                toolCall: input.capabilityOverrides?.toolCall ?? true,
                vision: input.capabilityOverrides?.vision ?? false,
                reasoning: input.capabilityOverrides?.reasoning ?? reasoning,
                sources: {
                  toolCall:
                    input.capabilityOverrides?.toolCall === undefined
                      ? 'default'
                      : 'override',
                  vision:
                    input.capabilityOverrides?.vision === undefined
                      ? 'default'
                      : 'override',
                  reasoning:
                    input.capabilityOverrides?.reasoning === undefined
                      ? 'inferred'
                      : 'override',
                },
                contextWindowTokens: input.contextWindowTokens || 128000,
                maxTokens: input.maxTokens || 4096,
                reasoningEfforts: reasoning
                  ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
                  : [],
              }
            }
            case 'model.saveEntry': {
              const input = (args[0] || {}) as any
              const wasUsable = Boolean(modelConfig.availability.usable)
              const entryId =
                input.entryId ||
                (modelConfig.models.length
                  ? `visual-entry-${modelConfig.models.length + 1}`
                  : 'visual-entry')
              const existing = modelConfig.models.find(
                (entry: any) => entry.entryId === entryId,
              )
              const overrides = input.capabilityOverrides || {}
              const saved = {
                ...(existing || visualModelEntry),
                ...input,
                entryId,
                apiKey: '',
                effectiveDisplayName: input.displayName || input.modelId,
                resolvedProfile: {
                  ...visualModelEntry.resolvedProfile,
                  toolCall: overrides.toolCall ?? true,
                  vision: overrides.vision ?? true,
                  reasoning: overrides.reasoning ?? true,
                  contextWindowTokens: input.contextWindowTokens || 128000,
                  maxTokens: input.maxTokens || 4096,
                },
              }
              const index = modelConfig.models.findIndex(
                (entry: any) => entry.entryId === entryId,
              )
              if (index >= 0) modelConfig.models[index] = saved
              else modelConfig.models.push(saved)
              if (!modelConfig.activeModelId)
                modelConfig.activeModelId = entryId
              const active = modelConfig.models.find(
                (entry: any) => entry.entryId === modelConfig.activeModelId,
              )
              modelConfig.current = active ? currentForEntry(active) : null
              Object.assign(modelConfig.availability, {
                usable: true,
                message: '模型已配置',
                provider: 'visual',
              })
              if (!wasUsable) {
                const action = await window.emperor?.invokeCore(
                  'onboarding.startProfileInterview',
                )
                return { ...modelConfig, profileOnboarding: action }
              }
              // Real IPC structured-clones results; a fresh copy lets the
              // renderer's reactive boot pick the new entry up.
              return JSON.parse(JSON.stringify(modelConfig))
            }
            case 'model.activate': {
              const entryId = String((args[0] as any)?.entryId || '')
              const active = modelConfig.models.find(
                (entry: any) => entry.entryId === entryId,
              )
              if (active) {
                modelConfig.activeModelId = entryId
                modelConfig.current = currentForEntry(active)
              }
              return modelConfig
            }
            case 'model.deleteEntry': {
              const entryId = String((args[0] as any)?.entryId || '')
              modelConfig.models = modelConfig.models.filter(
                (entry: any) => entry.entryId !== entryId,
              )
              if (modelConfig.activeModelId === entryId) {
                modelConfig.activeModelId =
                  modelConfig.models[0]?.entryId || null
              }
              const active = modelConfig.models.find(
                (entry: any) => entry.entryId === modelConfig.activeModelId,
              )
              modelConfig.current = active ? currentForEntry(active) : null
              modelConfig.availability.usable = Boolean(active)
              // Real IPC structured-clones results (see model.saveEntry).
              return JSON.parse(JSON.stringify(modelConfig))
            }
            case 'model.savePolicy': {
              modelConfig.policy = JSON.parse(JSON.stringify(args[0] ?? {}))
              return JSON.parse(JSON.stringify(modelConfig))
            }
            case 'model.setReasoningEffort': {
              const body = (args[0] || {}) as any
              const entry = modelConfig.models.find(
                (candidate: any) => candidate.entryId === body.entryId,
              )
              if (entry) entry.reasoningEffort = body.reasoningEffort
              if (entry?.entryId === modelConfig.activeModelId) {
                modelConfig.current = currentForEntry(entry)
              }
              return modelConfig
            }
            case 'onboarding.getProfileStatus':
              return profileOnboarding
            case 'onboarding.startProfileInterview': {
              const onboardingTurnId = 'onboarding_visual_profile'
              const interaction = {
                id: 'ask_visual_profile_1',
                kind: 'ask',
                status: 'waiting',
                created_at: Date.now() / 1000,
                updated_at: Date.now() / 1000,
                parent_call_id: 'call_visual_profile',
                context: '先从称呼开始，后续问题会根据你的回答调整。',
                questions: profileOnboardingQuestions,
                answers: {},
                title: '',
                summary: '',
                plan_markdown: '',
                assumptions: [],
                risk_level: 'medium',
                comments: [],
                meta: {
                  profileOnboardingVersion: 2,
                  profileOnboardingMode: 'agent',
                },
              }
              profileOnboarding.status = 'in_progress'
              profileOnboarding.sessionId = 'chat-main'
              profileOnboarding.interactionId = interaction.id
              profileOnboarding.attemptCount += 1
              profileOnboarding.canStart = false
              boot.control.pending = interaction
              const chatSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (chatSession) {
                chatSession.control_pending = {
                  kind: 'ask',
                  label: '需要用户输入',
                  tone: 'blue',
                  interaction_id: interaction.id,
                  updated_at: Date.now() / 1000,
                }
              }
              emitVisualRuntime({
                event: 'message_delta',
                session_id: 'chat-main',
                turn_id: onboardingTurnId,
                source: 'onboarding',
                delta:
                  '初次见面。我会根据你的回答逐步了解偏好，不需要一次说完；先从称呼开始。',
              })
              emitVisualRuntime({
                event: 'ask_request',
                session_id: 'chat-main',
                turn_id: onboardingTurnId,
                source: 'onboarding',
                interaction,
              })
              emitVisualRuntime({
                event: 'turn_paused',
                session_id: 'chat-main',
                turn_id: onboardingTurnId,
                source: 'onboarding',
                interaction,
              })
              emitVisualRuntime({
                event: 'profile_onboarding_status_changed',
                session_id: 'chat-main',
                profile_onboarding: { ...profileOnboarding },
              })
              return { started: true, state: { ...profileOnboarding } }
            }
            case 'onboarding.skipProfileInterview': {
              profileOnboarding.status = 'skipped'
              profileOnboarding.sessionId = null
              profileOnboarding.interactionId = null
              profileOnboarding.canStart = true
              profileOnboarding.canSkip = false
              boot.control.pending = null
              const skippedSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (skippedSession) skippedSession.control_pending = null
              for (const listener of environmentListeners)
                listener({
                  event: 'profile_onboarding_status_changed',
                  session_id: 'chat-main',
                  profile_onboarding: { ...profileOnboarding },
                })
              return { started: false, state: { ...profileOnboarding } }
            }
            case 'control.cancelInteraction': {
              profileOnboarding.status = 'pending'
              profileOnboarding.sessionId = null
              profileOnboarding.interactionId = null
              profileOnboarding.canStart = true
              profileOnboarding.canSkip = true
              boot.control.pending = null
              const deferredSession = sessions.find(
                (entry) => entry.id === 'chat-main',
              )
              if (deferredSession) deferredSession.control_pending = null
              for (const listener of environmentListeners) {
                listener({
                  event: 'interaction_cancelled',
                  session_id: 'chat-main',
                  control: boot.control,
                })
                listener({
                  event: 'profile_onboarding_status_changed',
                  session_id: 'chat-main',
                  profile_onboarding: { ...profileOnboarding },
                })
              }
              return { control: boot.control }
            }
            case 'control.approvePlan':
            case 'control.commentPlan': {
              const decided = boot.control.pending
              boot.control.pending = null
              const planSession = sessions.find(
                (entry) => entry.id === 'build-ui',
              )
              if (planSession) planSession.control_pending = null
              emitVisualRuntime({
                event:
                  operationKey === 'control.approvePlan'
                    ? 'plan_approved'
                    : 'plan_comment_added',
                session_id: 'build-ui',
                interaction: decided
                  ? {
                      ...decided,
                      status:
                        operationKey === 'control.approvePlan'
                          ? 'approved'
                          : 'commented',
                    }
                  : undefined,
                control: boot.control,
              })
              return { control: boot.control }
            }
            case 'control.answerInteraction': {
              const answered = boot.control.pending
              boot.control.pending = null
              // Profile onboarding asks live on chat-main; the visualControl
              // takeover fixtures (ask / ask-multi / permission) on build-ui.
              const answerOwner = String(answered?.id ?? '').startsWith(
                'ask_visual_profile',
              )
                ? 'chat-main'
                : 'build-ui'
              const answeredSession = sessions.find(
                (entry) => entry.id === answerOwner,
              )
              if (answeredSession) answeredSession.control_pending = null
              emitVisualRuntime({
                event: 'ask_answered',
                session_id: answerOwner,
                turn_id: 'onboarding_visual_profile',
                source: 'control',
                resume_model: true,
                interaction: answered
                  ? {
                      ...answered,
                      status: 'answered',
                      answers: args[1],
                    }
                  : undefined,
                control: boot.control,
              })
              if (answered?.id === 'ask_visual_profile_1') {
                const followup = {
                  id: 'ask_visual_profile_2',
                  kind: 'ask',
                  status: 'waiting',
                  created_at: Date.now() / 1000,
                  updated_at: Date.now() / 1000,
                  parent_call_id: 'call_visual_profile_followup',
                  context: '根据上一轮回答继续了解协作方式。',
                  questions: profileOnboardingFollowupQuestions,
                  answers: {},
                  title: '',
                  summary: '',
                  plan_markdown: '',
                  assumptions: [],
                  risk_level: 'medium',
                  comments: [],
                  meta: {
                    profileOnboardingVersion: 2,
                    profileOnboardingMode: 'agent',
                  },
                }
                boot.control.pending = followup
                profileOnboarding.status = 'in_progress'
                profileOnboarding.interactionId = followup.id
                if (answeredSession) {
                  answeredSession.control_pending = {
                    kind: 'ask',
                    label: '需要用户输入',
                    tone: 'blue',
                    interaction_id: followup.id,
                    updated_at: Date.now() / 1000,
                  }
                }
                emitVisualRuntime({
                  event: 'message_delta',
                  session_id: 'chat-main',
                  turn_id: 'onboarding_visual_profile_followup',
                  source: 'control',
                  delta: '明白了。我再确认一下日常协作方式。',
                })
                emitVisualRuntime({
                  event: 'ask_request',
                  session_id: 'chat-main',
                  turn_id: 'onboarding_visual_profile_followup',
                  source: 'control',
                  interaction: followup,
                })
                emitVisualRuntime({
                  event: 'turn_paused',
                  session_id: 'chat-main',
                  turn_id: 'onboarding_visual_profile_followup',
                  source: 'control',
                  interaction: followup,
                })
                emitVisualRuntime({
                  event: 'profile_onboarding_status_changed',
                  session_id: 'chat-main',
                  profile_onboarding: { ...profileOnboarding },
                })
                return {
                  control: boot.control,
                  resume: true,
                  profileOnboarding: { ...profileOnboarding },
                }
              }
              profileOnboarding.status = 'completed'
              profileOnboarding.sessionId = null
              profileOnboarding.interactionId = null
              profileOnboarding.canStart = false
              profileOnboarding.canSkip = false
              emitVisualRuntime({
                event: 'profile_onboarding_status_changed',
                session_id: 'chat-main',
                profile_onboarding: { ...profileOnboarding },
              })
              emitVisualRuntime({
                event: 'message_delta',
                session_id: 'chat-main',
                turn_id: 'onboarding_done_visual_profile',
                source: 'control',
                delta:
                  '个人档案已经完善。之后我会按这些偏好协作，也可以在后续对话中继续补充。',
              })
              emitVisualRuntime({
                event: 'assistant_done',
                session_id: 'chat-main',
                turn_id: 'onboarding_done_visual_profile',
                source: 'control',
                id: 'assistant_visual_profile_done',
                content:
                  '个人档案已经完善。之后我会按这些偏好协作，也可以在后续对话中继续补充。',
              })
              return {
                control: boot.control,
                resume: true,
                profileOnboarding: { ...profileOnboarding },
              }
            }
            case 'model.discoverModels':
              return {
                ok: true,
                provider: 'visual',
                protocol: 'openai',
                source: 'visual-fixture',
                models: [
                  { id: 'visual-main', ownedBy: 'Visual Labs' },
                  { id: 'visual-secondary', ownedBy: 'Visual Labs' },
                  { id: 'visual-pro', ownedBy: 'Visual Research' },
                ],
              }
            case 'model.test': {
              const body = (args[0] || {}) as any
              return {
                ok: true,
                entryId: body.entryId,
                kind: body.kind,
                latencyMs: 42,
                model: modelConfig.current?.modelId || 'visual-main',
                provider: 'visual',
                sample: body.kind === 'vision' ? 'red' : 'pong',
              }
            }
            case 'config.get':
              return {
                path: 'memory/profile/USER.local.md',
                content: '{\\n  "webui": {}\\n}\\n',
              }
            case 'mcp.getConfig':
              return visualMcpConfig()
            case 'mcp.status':
              return visualMcpStatus()
            case 'mcp.importServers':
              return visualMcpImport(args[0])
            case 'mcp.setServerEnabled': {
              const input = (args[0] ?? {}) as {
                name?: string
                enabled?: boolean
              }
              const server = visualMcpServers[String(input.name)]
              if (!server) return visualMcpNotFound(String(input.name))
              server.enabled = input.enabled !== false
              syncVisualMcp()
              return {
                name: input.name,
                enabled: server.enabled,
                changed: true,
                config: visualMcpConfig(),
                status: visualMcpStatus(),
              }
            }
            case 'mcp.removeServer': {
              const name = String((args[0] as { name?: string })?.name)
              if (!visualMcpServers[name]) return visualMcpNotFound(name)
              delete visualMcpServers[name]
              syncVisualMcp()
              return {
                removed: name,
                config: visualMcpConfig(),
                status: visualMcpStatus(),
              }
            }
            case 'mcp.saveConfig': {
              const saved = (args[0] ?? {}) as {
                servers?: Record<string, VisualMcpServer>
              }
              for (const name of Object.keys(visualMcpServers))
                delete visualMcpServers[name]
              Object.assign(visualMcpServers, saved.servers ?? {})
              syncVisualMcp()
              return visualMcpConfig()
            }
            case 'scheduler.get':
              return syncScheduler()
            case 'scheduler.createJob': {
              const input = (args[0] || {}) as Record<string, any>
              const job = {
                id: `job_visual_${scheduler.jobs.length + 1}`,
                enabled: true,
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
                state: { nextRunAtMs: Date.now() + 3600000, runHistory: [] },
                ...input,
              }
              scheduler.jobs = [job, ...scheduler.jobs]
              return { job, scheduler: syncScheduler() }
            }
            case 'scheduler.updateJob':
            case 'scheduler.pauseJob':
            case 'scheduler.resumeJob':
            case 'scheduler.runJob': {
              const id = String(args[0] || '')
              const patch = (
                operationKey === 'scheduler.updateJob' ? args[1] || {} : {}
              ) as Record<string, any>
              scheduler.jobs = scheduler.jobs.map((job: Record<string, any>) =>
                job.id !== id
                  ? job
                  : {
                      ...job,
                      ...patch,
                      ...(operationKey === 'scheduler.pauseJob'
                        ? { enabled: false }
                        : operationKey === 'scheduler.resumeJob'
                          ? { enabled: true }
                          : {}),
                      updatedAtMs: Date.now(),
                    },
              )
              const next = syncScheduler()
              const job = next.jobs.find(
                (item: Record<string, any>) => item.id === id,
              )
              return { job, scheduler: next }
            }
            case 'scheduler.deleteJob': {
              const id = String(args[0] || '')
              scheduler.jobs = scheduler.jobs.filter(
                (job: Record<string, any>) => job.id !== id,
              )
              return { deleted: true, scheduler: syncScheduler() }
            }
            case 'team.get':
              return team
            case 'team.getMember':
              return {
                member: team.members[0],
                inbox: [],
                leadInbox: [],
                thread: [],
              }
            case 'sidebar.get':
              return visualSidebarState
            case 'sidebar.patch': {
              const patch = (args[0] || {}) as Record<string, unknown>
              Object.assign(visualSidebarState, patch)
              return visualSidebarState
            }
            case 'desktopPet.get':
              return boot.desktopPet
            case 'desktopPet.setEnabled':
              boot.desktopPet.enabled = Boolean(args[0])
              return { ...boot.desktopPet }
            case 'diagnostics.get':
              return boot.diagnostics
            case 'environment.getStatus':
              if (
                localStorage.getItem('visual-environment-outcome') ===
                  'interrupted' &&
                !environmentPayload.recentJobs.length
              )
                environmentPayload.recentJobs = [
                  {
                    schemaVersion: 1,
                    jobId: 'job_interrupted',
                    planId: 'plan_interrupted',
                    catalogRevision: environmentPayload.catalog.revision,
                    projectFingerprint:
                      environmentPayload.status.projectFingerprint,
                    projectRoot: projectDir,
                    status: 'interrupted',
                    createdAt: now,
                    updatedAt: now,
                    currentStepId: null,
                    steps: [
                      {
                        stepId: 'step_node',
                        toolId: 'node',
                        strategyId: 'node-volta',
                        dependsOn: [],
                        status: 'cancelled',
                        requiresElevation: false,
                        requiresSeparateConfirmation: false,
                      },
                    ],
                    error: {
                      code: 'interrupted',
                      message: '上次环境安装被应用退出中断，请重新检测环境。',
                      action: 'refresh_environment',
                    },
                  },
                ]
              return environmentPayload
            case 'environment.createInstallPlan': {
              const requested = (
                (args[0] as { toolIds?: string[] } | undefined)?.toolIds || []
              ).filter((id) => id === 'node' || id === 'python')
              return {
                planId: 'plan_visual',
                catalogRevision: environmentPayload.catalog.revision,
                projectFingerprint:
                  environmentPayload.status.projectFingerprint,
                toolStateHash: 'c'.repeat(64),
                expiresAt: '2026-07-11T12:10:00.000Z',
                requiredLicenseIds: requested.map((id) =>
                  id === 'python' ? 'python-psf-2' : 'mit',
                ),
                warnings: ['安装期间请保持 Emperor Agent 运行'],
                steps: requested.map((id, index) => ({
                  stepId: `step_${id}`,
                  toolId: id,
                  strategyId: id === 'python' ? 'python-uv' : 'node-volta',
                  dependsOn: index ? [`step_${requested[index - 1]}`] : [],
                  status: 'planned',
                  requiresElevation: false,
                  requiresSeparateConfirmation: false,
                })),
              }
            }
            case 'environment.install': {
              environmentCancelled = false
              const planInput = (args[0] || {}) as { planId?: string }
              const startedAt = new Date().toISOString()
              const job = {
                schemaVersion: 1,
                jobId: 'job_visual',
                planId: planInput.planId || 'plan_visual',
                catalogRevision: environmentPayload.catalog.revision,
                projectFingerprint:
                  environmentPayload.status.projectFingerprint,
                projectRoot: projectDir,
                status: 'running',
                createdAt: startedAt,
                updatedAt: startedAt,
                currentStepId: 'step_node',
                steps: [
                  {
                    stepId: 'step_node',
                    toolId: 'node',
                    strategyId: 'node-volta',
                    dependsOn: [],
                    status: 'running',
                    requiresElevation: false,
                    requiresSeparateConfirmation: false,
                  },
                  {
                    stepId: 'step_python',
                    toolId: 'python',
                    strategyId: 'python-uv',
                    dependsOn: ['step_node'],
                    status: 'planned',
                    requiresElevation: false,
                    requiresSeparateConfirmation: false,
                  },
                ],
                error: null as null | {
                  code: string
                  message: string
                  action: string
                },
              }
              environmentPayload.activeJob = job
              for (const listener of environmentListeners)
                listener({
                  event: 'environment_install_started',
                  job_id: job.jobId,
                  status: 'running',
                  completed_steps: 0,
                  total_steps: 2,
                })
              await new Promise((resolve) => setTimeout(resolve, 80))
              const outcome = environmentCancelled
                ? 'cancelled'
                : localStorage.getItem('visual-environment-outcome')
              job.status =
                outcome === 'partial'
                  ? 'partial'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
              job.currentStepId = ''
              job.updatedAt = new Date().toISOString()
              job.steps[0].status =
                outcome === 'cancelled' ? 'cancelled' : 'completed'
              job.steps[1].status =
                outcome === 'partial'
                  ? 'failed'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
              job.error =
                outcome === 'partial'
                  ? {
                      code: 'post_install_probe_failed',
                      message: '安装后仍未检测到所需版本，请刷新环境状态。',
                      action: 'refresh_environment',
                    }
                  : outcome === 'cancelled'
                    ? {
                        code: 'cancelled',
                        message: '环境安装已由用户取消。',
                        action: 'refresh_environment',
                      }
                    : null
              if (outcome !== 'cancelled') {
                environmentTools[1].status = 'ready'
                environmentTools[1].detectedVersion = '24.18.0'
                environmentTools[1].versionSummary = 'node 24.18.0'
              }
              if (outcome !== 'partial' && outcome !== 'cancelled') {
                environmentTools[2].status = 'ready'
                environmentTools[2].detectedVersion = '3.12.11'
                environmentTools[2].versionSummary = 'python 3.12.11'
                environmentPayload.status.skills[0].status = 'ready'
                environmentPayload.status.skills[0].missing = []
              }
              environmentPayload.activeJob = null
              environmentPayload.recentJobs = [job]
              for (const listener of environmentListeners) {
                listener({
                  event: 'environment_install_completed',
                  job_id: job.jobId,
                  status: job.status,
                  completed_steps:
                    outcome === 'partial' ? 1 : outcome === 'cancelled' ? 0 : 2,
                  total_steps: 2,
                  error_code: job.error?.code,
                })
                listener({
                  event: 'environment_changed',
                  job_id: job.jobId,
                  status: 'completed',
                })
              }
              return job
            }
            case 'environment.cancelInstall': {
              environmentCancelled = true
              const job = environmentPayload.activeJob
              if (job) job.status = 'cancelling'
              for (const listener of environmentListeners)
                listener({
                  event: 'environment_install_progress',
                  job_id: job?.jobId || 'job_visual',
                  status: 'cancelling',
                  completed_steps: 0,
                  total_steps: 2,
                })
              return { cancelled: true, job }
            }
            case 'environment.getInstallLog':
              return {
                records: environmentLogs,
                badLines: [],
                cursor: 0,
                nextCursor: null,
                total: environmentLogs.length,
              }
            case 'skills.list':
              return {
                skills: visualSkills.map(visualSkillPayload),
                invalid: visualInvalidSkills.map((item) => ({ ...item })),
              }
            case 'skills.import':
              return visualSkillsImport(args[0])
            case 'skills.get': {
              const name = String(args[0] || '')
              const skill = visualSkills.find((item) => item.name === name)
              if (!skill)
                return visualSkillError(
                  `Skill not found: ${name}`,
                  'skill_not_found',
                )
              return visualSkillDetail(skill)
            }
            case 'skills.validate': {
              const input = (args[0] ?? {}) as {
                name?: string
                content?: string
              }
              if (typeof input.content === 'string')
                return visualValidateSkill(input.content, input.name ?? '')
              const skill = visualSkills.find(
                (item) => item.name === input.name,
              )
              if (!skill)
                return {
                  name: input.name ?? '',
                  valid: false,
                  errors: [`Skill not found: ${input.name}`],
                  warnings: [],
                  source: 'virtual',
                  path: null,
                }
              return {
                ...visualValidateSkill(skill.content, skill.name),
                source: skill.source,
                path: skill.root,
              }
            }
            case 'skills.save': {
              const name = String(args[0] || '')
              const content = String(args[1] ?? '')
              const skill = visualSkills.find((item) => item.name === name)
              if (skill?.readOnly)
                return visualSkillError(
                  `"${name}" is a ${skill.source} Skill and is read-only; copy it to your personal Skills to edit it`,
                  'skill_read_only',
                  'copy_to_user',
                )
              const check = visualValidateSkill(content, name)
              if (!check.valid)
                return visualSkillError(
                  check.errors.join('; '),
                  'skill_invalid',
                )
              if (!skill) {
                visualImportSkill(name, content, 'user', true)
                const created = visualSkills.find((item) => item.name === name)
                return created ? visualSkillDetail(created) : null
              }
              skill.content = content
              skill.description =
                visualSkillFrontmatter(content)?.description ||
                skill.description
              return visualSkillDetail(skill)
            }
            case 'skills.delete': {
              const name = String(args[0] || '')
              const options = (args[1] ?? {}) as { scope?: string | null }
              if (options.scope) {
                const invalidIndex = visualInvalidSkills.findIndex(
                  (item) =>
                    item.source === options.scope &&
                    item.path.split('/').pop() === name,
                )
                if (invalidIndex >= 0) {
                  const [removed] = visualInvalidSkills.splice(invalidIndex, 1)
                  return {
                    deleted: name,
                    scope: options.scope,
                    path: removed!.path,
                  }
                }
              }
              const index = visualSkills.findIndex(
                (item) =>
                  item.name === name &&
                  (!options.scope || item.source === options.scope),
              )
              const skill = visualSkills[index]
              if (!skill)
                return visualSkillError(
                  `Skill not found: ${name}`,
                  'skill_not_found',
                )
              if (skill.readOnly)
                return visualSkillError(
                  `"${name}" is read-only`,
                  'skill_read_only',
                  'copy_to_user',
                )
              visualSkills.splice(index, 1)
              return { deleted: name, scope: skill.source, path: skill.root }
            }
            case 'skills.copyToUser': {
              const input = (args[0] ?? {}) as { name?: string }
              const name = String(input.name ?? '')
              const index = visualSkills.findIndex((item) => item.name === name)
              const skill = visualSkills[index]
              if (!skill)
                return visualSkillError(
                  `Skill not found: ${name}`,
                  'skill_not_found',
                )
              if (skill.source === 'user')
                return visualSkillError(
                  `"${name}" is already a personal Skill`,
                  'skill_exists',
                )
              const copy = visualSkill(
                {
                  name,
                  source: 'user',
                  description: skill.description,
                  tags: skill.tags,
                  requirements: skill.requirements,
                  content: skill.content,
                },
                visualSkillHome,
              )
              visualSkills.splice(index, 1, copy)
              return visualSkillDetail(copy)
            }
            case 'skills.tools':
              return boot.tools
            // ── Plugins settings fixture (plugins.* ops) ──────────────
            case 'plugins.list':
              return boot.plugins
            case 'plugins.inspect': {
              const source = (args[0] ?? {}) as {
                kind?: string
                path?: string
                url?: string
              }
              const local = source.kind === 'local'
              return {
                previewId: 'plugin_preview_0123456789abcdef01234567',
                pluginId: 'emperor/visual-kit',
                name: 'Visual Kit',
                version: '1.0.0',
                description: '截图夹具：打包一个 Skill 和一个 Hook。',
                digest: 'e'.repeat(64),
                source: local
                  ? {
                      kind: 'local',
                      label: String(source.path ?? '')
                        .split('/')
                        .pop(),
                    }
                  : { kind: 'url', url: String(source.url ?? '') },
                signature: {
                  status: local ? 'local_user_source' : 'unverified',
                  publisher: null,
                },
                capabilities: {
                  skills: ['skills/visual'],
                  agents: [],
                  hooks: ['hooks/hooks.json'],
                  mcpServers: [],
                  lspServers: [],
                  commands: [],
                },
                fileCount: 6,
                totalBytes: 18_432,
              }
            }
            case 'plugins.install': {
              const input = (args[0] ?? {}) as { scope?: string }
              const local = !boot.plugins.some(
                (plugin) => plugin.pluginId === 'emperor/visual-kit',
              )
              const plugin = {
                pluginId: 'emperor/visual-kit',
                name: 'Visual Kit',
                scope: input.scope ?? 'user',
                version: '1.0.0',
                digest: 'e'.repeat(64),
                source: { kind: 'local', label: 'visual-kit' },
                signature: { status: 'local_user_source', publisher: null },
                enabled: true,
                materialization: 'installed',
                activation: 'active',
                capabilities: {
                  skills: 1,
                  agents: 0,
                  hooks: 1,
                  mcpServers: 0,
                  lspServers: 0,
                  commands: 0,
                },
              }
              if (local) boot.plugins.push(plugin)
              return { changed: true, plugin }
            }
            case 'plugins.setEnabled': {
              const input = (args[0] ?? {}) as {
                pluginId?: string
                scope?: string
                enabled?: boolean
              }
              const plugin = boot.plugins.find(
                (item) =>
                  item.pluginId === input.pluginId &&
                  item.scope === input.scope,
              )
              if (plugin) {
                plugin.enabled = Boolean(input.enabled)
                plugin.activation = !plugin.enabled
                  ? 'disabled'
                  : plugin.signature.status === 'unverified'
                    ? 'blocked_unverified'
                    : 'active'
              }
              return { changed: Boolean(plugin), plugin }
            }
            case 'plugins.uninstall': {
              const input = (args[0] ?? {}) as {
                pluginId?: string
                scope?: string
              }
              const index = boot.plugins.findIndex(
                (item) =>
                  item.pluginId === input.pluginId &&
                  item.scope === input.scope,
              )
              const [plugin] = index >= 0 ? boot.plugins.splice(index, 1) : []
              return { changed: Boolean(plugin), plugin }
            }
            case 'control.get':
              return { ...boot.control }
            case 'control.setPermissionMode': {
              const permissionMode = String(args[0] || 'ask_before_edit')
              if (boot.control.mode === 'plan')
                boot.control.previous_mode = permissionMode
              else {
                boot.control.mode = permissionMode
                boot.control.previous_mode = null
              }
              return { ...boot.control }
            }
            case 'control.setMode': {
              const nextMode = String(args[0] || 'ask_before_edit')
              if (nextMode === 'plan') {
                boot.control.previous_mode =
                  boot.control.mode === 'plan'
                    ? boot.control.previous_mode
                    : boot.control.mode
                boot.control.mode = 'plan'
              } else {
                boot.control.mode = nextMode
                boot.control.previous_mode = null
              }
              return { ...boot.control }
            }
            case 'goals.cancel': {
              const activeGoal = boot.goals.active
              if (!activeGoal) throw new Error('Goal is not active')
              const cancelledGoal = {
                ...activeGoal,
                status: 'cancelled',
                phase: 'terminal',
                updatedAt: new Date().toISOString(),
              }
              boot.goals.active = null
              boot.goals.recent = [cancelledGoal]
              return {
                accepted: true,
                goal: cancelledGoal,
                activeTask: null,
              }
            }
            case 'hooks.getConfig':
              return hooksPayload
            case 'hooks.getMetadata':
              return hooksMetadata
            case 'hooks.getAudit':
              return hooksAudit
            case 'hooks.testMatch': {
              const body = (args[0] ?? {}) as {
                eventName?: string
                query?: string
              }
              const matches =
                body.eventName === 'PreToolUse' &&
                /^(Write|Edit)$/.test(String(body.query ?? ''))
              return {
                eventName: body.eventName,
                query: body.query ?? '',
                items: matches
                  ? [
                      {
                        index: 0,
                        file: '~/.emperor/hooks.json',
                        groupIndex: 0,
                        hookIndex: 0,
                        matcher: 'Write|Edit',
                        command: 'node scripts/guard-write.mjs',
                        timeoutSec: 10,
                      },
                    ]
                  : [],
                errors: [],
              }
            }
            case 'hooks.testRun': {
              const body = (args[0] ?? {}) as { eventName?: string }
              return {
                eventName: body.eventName,
                command: 'node scripts/guard-write.mjs',
                payload: { tool_name: 'Write' },
                exitCode: 0,
                stdout: '{"decision":"approve"}',
                stderr: '',
                decision: 'approve',
                reason: null,
                additionalContext: null,
                durationMs: 18,
              }
            }
            case 'hooks.validateConfig': {
              const content = String(
                (args[0] as { content?: string } | undefined)?.content ?? '',
              )
              try {
                JSON.parse(content)
                return {
                  valid: true,
                  events: hooksPayload.events,
                  skipped: [],
                  unknownEvents: [],
                  errors: [],
                }
              } catch (cause) {
                return {
                  valid: false,
                  events: {},
                  skipped: [],
                  unknownEvents: [],
                  errors: [String(cause)],
                }
              }
            }
            case 'hooks.saveConfig': {
              hooksPayload.content = String(
                (args[0] as { content?: string } | undefined)?.content ?? '',
              )
              return { ...hooksPayload }
            }
            case 'chat.stopRuntime':
              return { cancelled: false }
            default:
              return {}
          }
        },
      }
    },
    {
      projectDir: visualProjectDir,
      sessionLogs: options.sessionLogs ?? defaultSessionLogs(),
      replyEvents: replyTemplate(),
    },
  )
}
