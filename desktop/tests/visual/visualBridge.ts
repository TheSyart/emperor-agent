import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
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

/** `emperor:open-path` targets (shared/ipc-contract.ts OpenPathTarget). */
type VisualOpenPathTarget =
  | { kind: 'diagnostic'; rowId: string }
  | { kind: 'skill'; name: string; sessionId?: string | null }
  | { kind: 'invalid-skill'; path: string; sessionId?: string | null }

type VisualBridge = {
  /** REL-05: main's app.getVersion() over the preload bridge. */
  appVersion: () => Promise<string>
  platform: string
  selectDirectory: () => Promise<string>
  getPathForFile: (file: File) => string
  selectFile?: (input?: unknown) => Promise<string | null>
  openSkillsFolder?: (input: {
    scope?: string
  }) => Promise<{ ok: boolean; path?: string }>
  openPath?: (target: VisualOpenPathTarget) => Promise<{ ok: boolean }>
  onCoreEvent: (listener: VisualCoreListener) => () => void
  onTerminalEvent: (listener: VisualCoreListener) => () => void
  onSessionEvents: (listener: VisualCoreListener) => () => void
  invokeCore: (operationKey: string, ...args: unknown[]) => Promise<unknown>
  openBrowserUrl?: (url: string) => Promise<unknown>
  browserBounds?: (bounds: unknown) => void
  browserAction?: (action: string) => void
  browserClose?: () => void
  onBrowserState?: (listener: VisualCoreListener) => () => void
  agentPreviewStart?: (targetId: string) => Promise<unknown>
  agentPreviewStop?: (targetId: string) => void
  onAgentPreviewFrame?: (listener: VisualCoreListener) => () => void
  onAgentPreviewPointer?: (listener: VisualCoreListener) => () => void
  dictationStatus?: () => Promise<unknown>
  dictationOpenPrivacy?: (pane: string) => Promise<{ opened: boolean }>
  dictationStart?: () => Promise<unknown>
  dictationStop?: () => Promise<{ ok: boolean }>
  dictationCancel?: () => Promise<{ ok: boolean }>
  onDictationEvent?: (listener: VisualCoreListener) => () => void
  vaultStatus?: () => Promise<unknown>
  vaultSave?: (draft: Record<string, unknown>) => Promise<unknown>
  vaultRemove?: (handleId: string) => Promise<{ ok: boolean }>
  vaultUnlock?: (password: string) => Promise<unknown>
  vaultLock?: () => Promise<{ ok: boolean }>
  vaultSetMaster?: (password: string | null) => Promise<{ ok: boolean }>
  vaultReveal?: (handleId: string) => Promise<{ password: string }>
  vaultReset?: () => Promise<{ ok: boolean }>
  clearBrowserData?: () => Promise<{ ok: boolean }>
  macHelperStatus?: () => Promise<unknown>
  macHelperRequestPermission?: (permission: string) => Promise<unknown>
  macHelperResetPermission?: (permission: string) => Promise<unknown>
  macHelperReconnect?: () => Promise<unknown>
  browserPairings?: () => Promise<unknown>
  approveBrowserPairing?: (pairingId: string) => Promise<boolean>
  denyBrowserPairing?: (pairingId: string) => Promise<boolean>
  revokeBrowserPairing?: (pairingId: string) => Promise<boolean>
  browserExtensionStatus?: () => Promise<unknown>
  installBrowserExtension?: () => Promise<unknown>
  revealBrowserExtension?: () => Promise<{ ok: boolean }>
  removeBrowserExtension?: () => Promise<unknown>
  onBrowserPairingRequest?: (listener: () => void) => () => void
  browserDownloads?: () => Promise<unknown>
  openBrowserDownload?: (id: string) => Promise<unknown>
  revealBrowserDownload?: (id: string) => Promise<unknown>
  removeBrowserDownload?: (id: string) => Promise<unknown>
  chooseDownloadFolder?: () => Promise<string | null>
  browserImportSources?: () => Promise<unknown>
  runBrowserImport?: (request: Record<string, unknown>) => Promise<unknown>
  onBrowserDownload?: (listener: VisualCoreListener) => () => void
  agentDownloadReveal?: (id: string) => Promise<unknown>
  agentDownloadMove?: (id: string) => Promise<unknown>
  agentDownloadSaveAs?: (id: string) => Promise<unknown>
  prepareDiagnosticsBundle?: () => Promise<unknown>
  exportDiagnosticsBundle?: (id: string) => Promise<unknown>
  revealDiagnosticsBundle?: (id: string) => Promise<unknown>
  discardDiagnosticsBundle?: (id: string) => Promise<unknown>
  planHomeBackup?: () => Promise<unknown>
  exportHomeBackup?: (input: Record<string, unknown>) => Promise<unknown>
  revealHomeBackup?: () => Promise<unknown>
  openHomeBackup?: () => Promise<unknown>
  restoreHomeBackup?: (id: string, passphrase?: string) => Promise<unknown>
  discardHomeBackup?: (id: string) => Promise<unknown>
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

/** The logos shipped with Emperor, as data URLs (the harness has no app:// host). */
function bundledPluginLogos(): Record<string, string> {
  const root = resolve(
    process.cwd(),
    '..',
    'packages',
    'core',
    'bundled-plugins',
  )
  return Object.fromEntries(
    ['github', 'computer-use'].map((name) => [
      name,
      `data:image/png;base64,${readFileSync(resolve(root, name, 'assets', 'logo.png')).toString('base64')}`,
    ]),
  )
}

export async function installVisualCoreBridge(
  page: Page,
  options: { sessionLogs?: VisualSessionLog[] } = {},
) {
  await page.addInitScript(
    ({ projectDir, sessionLogs, replyEvents, pluginLogos }) => {
      const now = '2026-06-26T12:00:00.000Z'
      const visualParams = new URLSearchParams(window.location.search)
      const visualPlanEnabled = visualParams.get('visualPlan') === 'on'
      const visualGoalPhase = visualParams.get('visualGoal')
      const visualTheme = visualParams.get('visualTheme')
      // `?visualQueue=on`: one message queued behind a running turn;
      // `held`: one waiting as 待发送 after the turn before it failed (KRN-02).
      const visualQueueMode = visualParams.get('visualQueue')
      const visualQueueEnabled =
        visualQueueMode === 'on' || visualQueueMode === 'held'
      const visualControlMode = visualParams.get('visualControl')
      const visualProgressMode = visualParams.get('visualProgress')
      // Targets the Agent of chat-main controls: `agent` (one built-in
      // browser tab) or `stack` (two Mac windows and the tab, for the
      // conversation's computer-use preview).
      const visualAgentTab = visualParams.get('visualAgentTab')
      // Settings › 电脑操作 with the switch on and two grants.
      const visualComputerUseOn =
        visualParams.get('visualComputerUse') === 'on' ||
        visualAgentTab !== null
      if (visualTheme === 'light' || visualTheme === 'dark')
        localStorage.setItem('emperor.theme', visualTheme)
      // AGT-12: `?visualExecutors=signed-out|signed-in|api-key|endpoint|
      // missing|notice` gives 设置 › 子智能体 an enabled Claude Code in that
      // state (`notice`: signed out, right after the upgrade that deleted a
      // saved token).
      const visualExecutorsMode = visualParams.get('visualExecutors')
      // FIX-16: `?visualCodexDefault=unavailable` — Codex's own default model
      // is not in the list its ChatGPT login offers.
      const visualCodexDefaultUnavailable =
        visualParams.get('visualCodexDefault') === 'unavailable'
      // AGT-13: `?visualExecutorUpgrade=found|unverified|failed` — versions
      // in 设置 › 子智能体, both executors on and installed with npm:
      // Claude Code 2.1.281 (npm has 2.1.308), Codex 0.153.4 (0.163.0);
      // `unverified`: Emperor has verified only 0.153; `failed`: a Codex
      // upgrade failed without write permission. A spec moves an upgrade on
      // with window.__visualExecutorUpgrade('running' | 'done' | 'failed').
      const visualUpgradeMode = visualParams.get('visualExecutorUpgrade')
      const visualUpgrade = {
        claude: '2.1.281',
        codex: '0.153.4',
        dismissed: false,
        upgrades: [] as Record<string, unknown>[],
      }
      const VISUAL_NPM = '/opt/homebrew/lib/node_modules'
      const VISUAL_CODEX_COMMAND = 'npm install -g @openai/codex@0.163.0'
      // One upgrade: Core keeps its start time in every event.
      const visualRunStarted = Date.now() - 12_000
      const visualCodexRun = (over: Record<string, unknown>) => ({
        profileId: 'codex-default',
        backend: 'codex',
        from: '0.153.4',
        target: '0.163.0',
        command: VISUAL_CODEX_COMMAND,
        state: 'running',
        startedAt: visualRunStarted,
        log: [
          `$ ${VISUAL_CODEX_COMMAND}`,
          'added 1 package, changed 2 packages in 9s',
          '正在重新检测 Codex…',
        ],
        ...over,
      })
      const visualFailedRun = () =>
        visualCodexRun({
          state: 'failed',
          reason: 'permission',
          path: VISUAL_NPM,
          exitCode: 243,
          finishedAt: Date.now(),
          manualCommand: VISUAL_CODEX_COMMAND,
          log: [
            `$ ${VISUAL_CODEX_COMMAND}`,
            'npm error code EACCES',
            'npm error syscall rename',
            `npm error path ${VISUAL_NPM}/@openai/codex`,
            "npm error Error: EACCES: permission denied, rename '/opt/homebrew/lib/node_modules/@openai/codex'",
          ],
        })
      if (visualUpgradeMode === 'failed') {
        visualUpgrade.claude = '2.1.308'
        visualUpgrade.upgrades = [visualFailedRun()]
      }
      const visualVersions = () => {
        const unverified = visualUpgradeMode === 'unverified'
        const claudeTarget =
          visualUpgrade.claude === '2.1.308' ? null : '2.1.308'
        const codexTarget =
          unverified || visualUpgrade.codex === '0.163.0' ? null : '0.163.0'
        return {
          checkedAt: Date.now() - 10 * 60_000,
          checking: false,
          error: null,
          dismissed: visualUpgrade.dismissed,
          upgrades: visualUpgrade.upgrades,
          executors: [
            {
              profileId: 'claude-default',
              backend: 'claude-code',
              enabled: true,
              installed: visualUpgrade.claude,
              install: {
                kind: 'npm',
                location: `${VISUAL_NPM}/@anthropic-ai/claude-code`,
              },
              latest: '2.1.308',
              verified: [],
              target: claudeTarget,
              unverified: null,
              upgrade: claudeTarget
                ? {
                    oneClick: true,
                    command: 'npm install -g @anthropic-ai/claude-code@2.1.308',
                  }
                : null,
              activeRuns: 0,
            },
            {
              profileId: 'codex-default',
              backend: 'codex',
              enabled: true,
              installed: visualUpgrade.codex,
              install: { kind: 'npm', location: `${VISUAL_NPM}/@openai/codex` },
              latest: '0.163.0',
              verified: unverified ? ['0.153'] : ['0.153', '0.163'],
              target: codexTarget,
              unverified:
                unverified && visualUpgrade.codex !== '0.163.0'
                  ? '0.163.0'
                  : null,
              upgrade: codexTarget
                ? { oneClick: true, command: VISUAL_CODEX_COMMAND }
                : null,
              activeRuns: 1,
            },
          ],
        }
      }
      const visualExecutorProfiles = [
        {
          id: 'claude-default',
          backend: 'claude-code',
          enabled: true,
          executablePath: 'claude',
          authRef: { kind: 'managed-cli-login' },
          stateDirectoryId: 'claude-default',
          concurrencyLimit: 1,
        },
        {
          id: 'codex-default',
          backend: 'codex',
          enabled: visualUpgradeMode !== null,
          executablePath: 'codex',
          authRef: { kind: 'managed-cli-login' },
          stateDirectoryId: 'codex-default',
          concurrencyLimit: 1,
        },
      ]
      let visualExecutorConfig: Record<string, unknown> = {
        schemaVersion: 1,
        revision: 3,
        touchedAt: 1,
        profiles: visualExecutorProfiles,
        limits: {
          globalConcurrency: 2,
          maxQueuedMessages: 16,
          maxRunsPerTask: 32,
          maxDepth: 3,
          runTimeoutMs: 1800000,
          questionTimeoutMs: 900000,
          estimatedBudgetUsd: 10,
        },
      }
      const visualClaudeAuth = (mode: string | null) =>
        mode === 'signed-in'
          ? {
              source: null,
              method: 'claude.ai',
              email: 'ada@example.com',
              organization: 'Ada Lab',
              subscription: 'max',
            }
          : mode === 'api-key'
            ? {
                source: 'emperor',
                kind: 'api-key',
                last4: 'c3d4',
                method: 'api_key',
              }
            : mode === 'endpoint'
              ? {
                  source: 'settings',
                  kind: 'auth-token',
                  endpoint: 'api.deepseek.com',
                  method: 'oauth_token',
                }
              : { source: null, method: 'none', problem: 'missing' }
      const visualExecutorProbe = (id: string, mode: string | null) => {
        const base = {
          checkedAt: Date.now(),
          authVerified: false,
          executableVersion:
            id === 'codex-default'
              ? visualUpgrade.codex
              : visualUpgradeMode
                ? visualUpgrade.claude
                : '2.1.300',
          capabilities: {
            persistentSession: true,
            queuedFollowup: true,
            steer: id === 'codex-default',
            interrupt: true,
            questions: true,
            structuredOutput: true,
            processBoundary: 'os',
            usage: 'tokens',
          },
        }
        if (id === 'codex-default')
          return { ...base, status: 'available', localAuthChecked: true }
        if (mode === 'missing')
          return {
            checkedAt: Date.now(),
            authVerified: false,
            capabilities: base.capabilities,
            status: 'missing',
            diagnostic: 'claude is not installed',
          }
        const auth = visualClaudeAuth(mode)
        return auth.method !== 'none'
          ? {
              ...base,
              status: 'available',
              localAuthChecked: true,
              requiredVersion: '>= 2.1.79',
              auth,
            }
          : {
              ...base,
              status: 'needs_auth',
              localAuthChecked: false,
              requiredVersion: '>= 2.1.79',
              diagnostic: 'AUTH_REQUIRED',
              auth,
            }
      }
      let visualSignInNotice = visualExecutorsMode === 'notice'
      let visualClaudeMode = visualExecutorsMode
      /** 登录 Claude Code as Core runs it (FIX-11): running until a spec ends it. */
      let visualSignIn: Record<string, unknown> | null = null
      const visualExecutorList = () => ({
        config: visualExecutorConfig,
        diagnostic: null,
        signInNotice: visualSignInNotice,
        signIn: visualSignIn?.state === 'running' ? visualSignIn : null,
        profiles: visualExecutorProfiles.map((profile) => ({
          profile,
          probe: visualExecutorProbe(profile.id, visualClaudeMode),
          specialties: [],
          runtime: {
            profileId: profile.id,
            reportedModel: null,
            configuredModel: null,
            modelSource: null,
            provider: null,
            advertisedTools: null,
            observedTools: [],
            hostAllowedTools: [],
            nativeCapabilities: {
              search: { status: 'unverified' },
              imageGeneration: {
                status:
                  profile.backend === 'codex' ? 'unverified' : 'unsupported',
              },
            },
          },
          consent: null,
        })),
      })
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
        visualCommand('plan', '模型与执行', '开启计划并生成实施方案', {
          busyPolicy: 'after_turn',
          argumentHint: '[on|off|status|open|description]',
        }),
        visualCommand('goal', '模型与执行', '启动或管理长期目标', {
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
        apiKey: '***a1b2',
        reasoningEffort: 'medium',
        lastTest: {
          ok: false,
          kind: 'text',
          failure: 'auth',
          testedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      }
      const visualHaikuEntry = {
        ...visualSecondaryEntry,
        entryId: 'anthropic-haiku-entry',
        modelId: 'claude-visual-haiku',
        displayName: 'Claude Haiku Visual',
        effectiveDisplayName: 'Claude Haiku Visual',
        contextWindowTokens: 200000,
        resolvedProfile: {
          ...visualModelEntry.resolvedProfile,
          vision: false,
          contextWindowTokens: 200000,
        },
      }
      const visualDeepSeekEntry = {
        ...visualModelEntry,
        entryId: 'deepseek-entry',
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek V4',
        effectiveDisplayName: 'DeepSeek V4',
        apiBase: 'https://api.deepseek.com',
        apiKey: '***c3d4',
        reasoningEffort: null,
        resolvedProfile: {
          ...visualModelEntry.resolvedProfile,
          vision: false,
          contextWindowTokens: 1000000,
        },
        // MOD-05: the catalog knows it is retired; the last test passed.
        lifecycle: {
          status: 'retired',
          retiresAt: '2026-07-24',
          replacement: 'deepseek-flash',
        },
        lastTest: {
          ok: true,
          kind: 'text',
          testedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      }
      const catalogOption = (
        name: string,
        displayName: string,
        region: string,
        apiBase = `https://api.${name}.example/v1`,
      ) => ({
        name,
        displayName,
        protocols: ['openai'],
        defaultProtocol: 'openai',
        apiBases: { openai: apiBase },
        iconId: name,
        region,
        isLocal: region === 'local',
        modelDiscovery: { openai: 'openai_compat' },
      })
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
          : [
              visualModelEntry,
              visualSecondaryEntry,
              visualDeepSeekEntry,
              visualHaikuEntry,
            ],
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
            region: 'foreign',
            isLocal: false,
            modelDiscovery: { anthropic: 'anthropic' },
          },
          catalogOption(
            'deepseek',
            'DeepSeek',
            'cn',
            'https://api.deepseek.com',
          ),
          catalogOption('dashscope', 'Alibaba DashScope (Qwen)', 'cn'),
          catalogOption('moonshot', 'Moonshot Kimi', 'cn'),
          catalogOption('zhipu', 'Zhipu GLM (智谱)', 'cn'),
          catalogOption('volcengine', 'VolcEngine 火山方舟 (含豆包)', 'cn'),
          catalogOption('minimax', 'MiniMax', 'cn'),
          catalogOption('openai', 'OpenAI', 'foreign'),
          catalogOption('gemini', 'Google Gemini', 'foreign'),
          catalogOption('xai', 'xAI Grok', 'foreign'),
          catalogOption('groq', 'Groq', 'foreign'),
          catalogOption('openrouter', 'OpenRouter', 'aggregator'),
          catalogOption('siliconflow', 'SiliconFlow (硅基流动)', 'aggregator'),
          catalogOption(
            'ollama',
            'Ollama',
            'local',
            'http://localhost:11434/v1',
          ),
          catalogOption(
            'lm_studio',
            'LM Studio',
            'local',
            'http://localhost:1234/v1',
          ),
          catalogOption('vllm', 'vLLM', 'local', 'http://localhost:8000/v1'),
          catalogOption(
            'ovms',
            'OpenVINO Model Server',
            'local',
            'http://localhost:8000/v3',
          ),
          catalogOption('custom', 'Custom', 'other', ''),
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
          jobs: 5,
          enabled: 3,
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
          // One-shot (`at`) jobs: one still scheduled, one that already ran
          // (Core disabled it afterwards: the 已完成 tab).
          {
            id: 'job_release_reminder',
            name: '版本发布提醒',
            enabled: true,
            schedule: { kind: 'at', atMs: Date.now() + 2 * 86400000 },
            payload: {
              kind: 'agent_turn',
              message: '检查发布清单是否完成，并提醒我确认发布说明。',
              deliver: true,
            },
            createdAtMs: Date.now() - 86400000,
            updatedAtMs: Date.now() - 86400000,
            state: {
              nextRunAtMs: Date.now() + 2 * 86400000,
              runHistory: [],
            },
          },
          {
            id: 'job_migration_check',
            name: '迁移完成检查',
            enabled: false,
            schedule: { kind: 'at', atMs: Date.now() - 3 * 86400000 },
            payload: {
              kind: 'agent_turn',
              message: '确认数据迁移脚本已跑完，并汇总异常记录。',
              deliver: true,
            },
            createdAtMs: Date.now() - 5 * 86400000,
            updatedAtMs: Date.now() - 3 * 86400000,
            state: {
              nextRunAtMs: null,
              lastRunAtMs: Date.now() - 3 * 86400000,
              lastStatus: 'ok',
              runHistory: [
                {
                  runId: 'run_migration_1',
                  taskId: 'task_77',
                  runAtMs: Date.now() - 3 * 86400000,
                  scheduledForMs: Date.now() - 3 * 86400000,
                  status: 'ok',
                  durationMs: 52000,
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
          // A spec can mark the service as not started or with jobs set
          // aside (KRN-10).
          ...((
            window as unknown as {
              __visualSchedulerStatus?: Record<string, unknown>
            }
          ).__visualSchedulerStatus ?? {}),
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
      // Embedded browser stub: the native view cannot render here, so opens,
      // bounds and actions are recorded on window and specs push page states
      // through __visualEmitBrowserState. `…:9` addresses fail to load.
      const browserListeners = new Set<VisualCoreListener>()
      const visualBrowser = window as unknown as {
        __visualBrowserOpened?: string[]
        __visualBrowserBounds?: unknown[]
        __visualBrowserActions?: string[]
        __visualBrowserClosed?: number
        __visualEmitBrowserState?: (state: unknown) => void
      }
      const emitBrowserState = (state: unknown) => {
        for (const listener of browserListeners) listener(state)
      }
      visualBrowser.__visualEmitBrowserState = emitBrowserState
      // Your downloads as main reports them: specs push one through
      // __visualEmitDownload (the 浏览器 pane's line, the history page).
      const downloadListeners = new Set<VisualCoreListener>()
      ;(
        window as unknown as {
          __visualEmitDownload?: (view: unknown) => void
        }
      ).__visualEmitDownload = (view: unknown) => {
        for (const listener of downloadListeners) listener(view)
      }
      // Computer use: one Agent tab of chat-main whose preview frame is drawn
      // here (a fixture form) and streamed like main's JPEG frames.
      const visualAgentTarget = {
        targetId: 'tab_00000000-0000-4000-8000-00000000a9e1',
        ownerSessionId: 'chat-main',
        kind: 'embedded-tab',
        driver: 'embedded-browser',
        generation: 1,
        revision: 4,
        state: 'attached',
        control: 'agent' as string,
        title: 'Fixture form',
        url: 'http://127.0.0.1:5173/form',
        origin: 'http://127.0.0.1:5173',
        profileId: 'temporary',
        openedAt: now,
        lastActiveAt: new Date(Date.parse(now) - 60_000).toISOString(),
      }
      const visualWindow = (
        targetId: string,
        title: string,
        appId: string,
        ageMs: number,
      ) => ({
        targetId,
        ownerSessionId: 'chat-main',
        kind: 'desktop-window',
        driver: 'desktop',
        generation: 1,
        revision: 3,
        state: 'attached',
        control: 'agent',
        title,
        url: `app:${appId}`,
        origin: null,
        profileId: 'desktop',
        openedAt: now,
        lastActiveAt: new Date(Date.parse(now) - ageMs).toISOString(),
      })
      const visualTargets = () =>
        visualAgentTab === 'stack'
          ? [
              visualWindow(
                't-6F1C2E00-0000-4000-8000-000000000001',
                '季度计划.rtf',
                'com.apple.TextEdit',
                5_000,
              ),
              visualWindow(
                't-6F1C2E00-0000-4000-8000-000000000002',
                '下载',
                'com.apple.finder',
                30_000,
              ),
              visualAgentTarget,
            ]
          : visualAgentTab
            ? [visualAgentTarget]
            : []
      const visualComputerUseState = {
        enabled: visualComputerUseOn,
        drivers: {} as Record<string, boolean>,
        screenshots: { count: 14, bytes: 9 * 1024 * 1024 },
        downloadRetentionDays: 30 as 0 | 7 | 30 | 90,
        // `?visualRetiredApps=1`: apps the retired protected list held.
        retiredProtectedApps:
          visualParams.get('visualRetiredApps') === '1'
            ? ['com.agilebits.onepassword7', 'com.example.Bank']
            : ([] as string[]),
      }
      // 设置 › 浏览器: the user's browser choices, Emperor's sign-in
      // profiles, site permissions and the credential vault.
      const visualBrowserState = {
        preferences: {
          linkTarget: 'system',
          localTarget: 'builtin',
          showFullUrl: true,
          history: true,
          downloadDirectory: null,
          askWhereToSave: false,
        } as Record<string, unknown>,
        // 设置 › 浏览器 › 下载历史记录: yours, and Emperor's inbox.
        downloads: {
          user: [
            {
              id: 'ud_00000000000a',
              name: 'Q3-report.csv',
              site: 'https://news.example.com',
              time: Date.parse(now) - 20 * 60_000,
              state: 'completed',
              bytes: 24_576,
              exists: true,
            },
            {
              id: 'ud_00000000000b',
              name: 'setup.dmg',
              site: 'https://downloads.example.com',
              time: Date.parse(now) - 45 * 60_000,
              state: 'blocked',
              reason: 'executable',
              bytes: 0,
            },
            {
              id: 'ud_00000000000c',
              name: 'dataset-2026.zip',
              site: 'https://data.example.org',
              time: Date.parse(now) - 2 * 60_000,
              state: 'progressing',
              bytes: 42 * 1024 * 1024,
              totalBytes: 100 * 1024 * 1024,
            },
            {
              id: 'ud_00000000000d',
              name: 'slides.pdf',
              site: 'https://talks.example.com',
              time: Date.parse(now) - 26 * 60 * 60_000,
              state: 'completed',
              bytes: 3_400_000,
              exists: false,
            },
          ].sort((a, b) => b.time - a.time) as Array<Record<string, unknown>>,
          agent: [
            {
              id: 'dl_00000000000a',
              name: 'invoice-2026-09.pdf',
              site: 'https://billing.example.com',
              sessionId: 'chat-main',
              time: Date.parse(now) - 3 * 60 * 60_000,
              bytes: 186_000,
              exists: true,
            },
            {
              id: 'dl_00000000000b',
              name: 'export.csv',
              site: '',
              sessionId: null,
              time: Date.parse(now) - 9 * 24 * 60 * 60_000,
              bytes: 5_120,
              exists: false,
            },
          ] as Array<Record<string, unknown>>,
        },
        profiles: [
          {
            profileId: 'temporary',
            name: '临时',
            kind: 'temporary',
            openTargets: 1,
          },
          {
            profileId: 'profile-work',
            name: '工作',
            kind: 'persistent',
            openTargets: 2,
          },
          {
            profileId: 'profile-shop',
            name: '购物',
            kind: 'persistent',
            openTargets: 0,
          },
        ],
        permissions: [
          {
            profileId: 'profile-work',
            origin: 'https://meet.example.com',
            kind: 'camera',
          },
          {
            profileId: 'profile-work',
            origin: 'https://meet.example.com',
            kind: 'microphone',
            expiresAt: '2026-10-01 18:00',
          },
        ] as Array<Record<string, unknown>>,
        vault: [
          {
            handleId: 'cred_visual_github',
            label: 'GitHub',
            bindings: [{ kind: 'origin', origin: 'https://github.com' }],
            fields: ['username', 'password', 'totp'],
            fillMode: 'confirm',
            revealUsername: true,
            username: 'thesyart',
            lastUsedAt: Date.parse('2026-06-26T09:00:00.000Z'),
            lastUsedTarget: 'https://github.com',
          },
          {
            handleId: 'cred_visual_mail',
            label: '公司邮箱',
            bindings: [
              {
                kind: 'app',
                bundleId: 'com.apple.mail',
                teamId: 'APPLECOMPUTER',
              },
            ],
            fields: ['password'],
            fillMode: 'confirm',
            revealUsername: false,
          },
        ] as Array<Record<string, unknown>>,
        // `?visualVault=key-missing|key-invalid`: the local key is unusable.
        vaultProblem: visualParams.get('visualVault'),
      }
      // 设置 › 电脑操作 › Chrome 和 Edge: 智能体权限 and 浏览器权限
      // (PLAN-CAP-001 RV-09). `?visualChromeRules=empty` starts with the
      // default row only.
      let visualExternalBrowser: Record<string, unknown> = {
        defaults: { browse: 'allow', download: 'ask' },
        sites:
          visualParams.get('visualChromeRules') === 'empty'
            ? []
            : [
                {
                  pattern: '*.mybank.example',
                  browse: 'ask',
                  download: 'block',
                },
                { pattern: 'github.com', browse: 'allow', download: 'allow' },
              ],
        history: 'ask',
        siteTools: false,
        // 启用站点工具 (RV-11): not offered by today's browsers.
        siteToolsAvailable: false,
        siteToolsReason:
          'Chrome 和 Edge 正式版还没有向扩展开放（只在试用网站提供，还需打开实验开关）',
      }
      // 下载历史记录 › Emperor 的下载 also lists the Agent's downloads in
      // the user's own Chrome or Edge (no file actions there).
      visualBrowserState.downloads.agent.push(
        {
          id: 'xd_00000000000a',
          name: 'statement-2026-09.pdf',
          site: 'https://files.mybank.example',
          sessionId: null,
          time: Date.parse(now) - 50 * 60_000,
          bytes: 0,
          exists: false,
          browser: 'chrome',
          state: 'refused',
          reason: 'blocked',
        },
        {
          id: 'xd_00000000000b',
          name: 'release-notes.md',
          site: 'https://github.com',
          sessionId: null,
          time: Date.parse(now) - 4 * 60 * 60_000,
          bytes: 12_288,
          exists: false,
          browser: 'edge',
          state: 'completed',
        },
      )
      visualBrowserState.downloads.agent.sort(
        (a, b) => Number(b.time) - Number(a.time),
      )
      const visualComputerUse = () => {
        const on = visualComputerUseState.enabled
        return {
          supported: true,
          enabled: on,
          platform: 'macos',
          drivers: [
            {
              driver: 'embedded-browser',
              platform: 'macos',
              stage: 'experimental',
              label: '内置浏览器（基础）',
              enabled: on,
              available: on,
              actions: [
                'click',
                'fill',
                'typeText',
                'press',
                'select',
                'scroll',
                'navigate',
                'history',
              ],
              missing: [
                '持久 profile 与多标签',
                '跨源 iframe 内的元素',
                '下载与上传',
                '凭据代填',
              ],
            },
            {
              // Paired in the visual bridge (browserPairings: one browser,
              // two attached tabs), like external-browser-driver.ts.
              driver: 'external-browser',
              platform: 'macos',
              stage: 'experimental',
              label: 'Chrome/Edge 连接',
              enabled:
                on &&
                visualComputerUseState.drivers['external-browser'] !== false,
              available:
                on &&
                visualComputerUseState.drivers['external-browser'] !== false,
              actions: ['click', 'fill'],
              missing: ['主框架以外的语义操作', '截图与坐标操作'],
            },
            {
              driver: 'desktop',
              platform: 'macos',
              stage: 'experimental',
              label: 'macOS 桌面',
              enabled: on && visualComputerUseState.drivers.desktop !== false,
              available: on && visualComputerUseState.drivers.desktop !== false,
              actions: ['click', 'fill', 'typeText', 'press', 'select'],
              missing: ['自动用户活动检测'],
            },
          ],
          targets: visualTargets(),
          screenshots: visualComputerUseState.screenshots,
          downloadRetentionDays: visualComputerUseState.downloadRetentionDays,
          ...(visualComputerUseState.retiredProtectedApps.length > 0
            ? {
                retiredProtectedApps: [
                  ...visualComputerUseState.retiredProtectedApps,
                ],
              }
            : {}),
        }
      }
      const previewListeners = new Set<VisualCoreListener>()
      const drawVisualFrame = async (targetId: string) => {
        const canvas = new OffscreenCanvas(1280, 800)
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, 1280, 800)
        ctx.fillStyle = '#1f2937'
        ctx.font = '600 40px -apple-system, sans-serif'
        ctx.fillText(
          targetId.startsWith('t-')
            ? `Window ${targetId.slice(-1)}: quarterly plan`
            : 'Sign up for the fixture newsletter',
          80,
          120,
        )
        ctx.font = '28px -apple-system, sans-serif'
        const fields = ['Name', 'Email', 'Password', 'Country']
        fields.forEach((label, index) => {
          const y = 200 + index * 110
          ctx.fillStyle = '#374151'
          ctx.fillText(label, 80, y)
          ctx.strokeStyle = '#9ca3af'
          ctx.lineWidth = 2
          ctx.strokeRect(80, y + 18, 640, 56)
        })
        ctx.fillStyle = '#2563eb'
        ctx.fillRect(80, 660, 180, 64)
        ctx.fillStyle = '#ffffff'
        ctx.fillText('Submit', 124, 702)
        const blob = await canvas.convertToBlob({
          type: 'image/jpeg',
          quality: 0.8,
        })
        const jpeg = new Uint8Array(await blob.arrayBuffer())
        for (const listener of previewListeners)
          listener({ targetId, seq: 1, width: 1280, height: 800, jpeg })
      }
      // Where the Agent's latest action landed (main's preview-pointer
      // event): specs push `{ targetId, x, y }` through this.
      const pointerListeners = new Set<VisualCoreListener>()
      ;(
        window as unknown as {
          __visualEmitPreviewPointer?: (pointer: unknown) => void
        }
      ).__visualEmitPreviewPointer = (pointer) => {
        for (const listener of pointerListeners) listener(pointer)
      }
      const visualSidebarState = {
        section_order: ['projects', 'chats'],
        project_sort: 'updated_at',
        chat_sort: 'updated_at',
        project_order: [],
        chat_order: [],
        project_session_order: {},
        collapsed_project_ids: [],
        pinned_session_ids: [] as string[],
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
            additions: 12,
            deletions: 4,
          },
          {
            path: 'README.md',
            index: '.',
            worktree: 'M',
            conflict: false,
            untracked: false,
            additions: 2,
            deletions: 0,
          },
          {
            path: 'notes/验收记录.md',
            index: '?',
            worktree: '?',
            conflict: false,
            untracked: true,
            additions: 4,
            deletions: 0,
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
      /**
       * `tasks.list` fixture (environment card 子智能体 / 后台任务): the
       * Build session has five subagents (one running), a running background
       * job, a running Ralph workflow run and a failed job; the plain chat
       * has two finished subagents. Background times follow the real clock
       * (elapsed / finish time read naturally); `tasks.cancel` stops a job
       * or run for good (`visualCancelledTasks`).
       */
      const visualCancelledTasks = new Map<string, number>()
      const visualTaskBudget = {
        maxSteps: 400,
        maxBackgroundSteps: 120,
        maxActiveAgents: 8,
        maxTotalAgents: 64,
        maxNoticeWakes: 32,
      }
      // 设置 › 高级 › 存储 (KRN-12): sizes in bytes; 清理 frees the spill.
      const visualStorage: Record<string, number> = {
        sessions: 186_646_528,
        attachments: 48_234_496,
        spill: 31_457_280,
        memoryVersions: 2_097_152,
        ledger: 1_572_864,
        delegations: 9_437_184,
        other: 412_090_368,
      }
      // REL-02 `updates.*`: `?visualUpdate=` available | downloading |
      // verifying | ready | ready-verified | failed | off | test-feed |
      // outdated (诊断: Electron 3 majors behind the newest release);
      // none: up to date. 下载 / 取消 / 在访达中显示 are recorded.
      const visualUpdateMode = visualParams.get('visualUpdate') ?? ''
      const visualUpdateRelease = {
        version: '0.2.1',
        tag: 'v0.2.1',
        channel: 'stable',
        name: 'Emperor Agent v0.2.1',
        publishedAt: '2026-06-25T08:00:00Z',
        notesUrl:
          'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
        asset: {
          name: 'Emperor-Agent-0.2.1-macos-arm64.dmg',
          size: 231_467_959,
        },
      }
      function visualUpdateDownload(mode: string): Record<string, unknown> {
        const base = {
          version: '0.2.1',
          fileName: 'Emperor-Agent-0.2.1-macos-arm64.dmg',
        }
        if (mode === 'downloading')
          return {
            phase: 'downloading',
            ...base,
            receivedBytes: 96_468_992,
            totalBytes: 231_467_959,
          }
        if (mode === 'verifying')
          return { phase: 'verifying', ...base, step: 'attestation' }
        if (mode === 'ready' || mode === 'ready-verified')
          return {
            phase: 'ready',
            ...base,
            path: '/Users/visual/Downloads/Emperor-Agent-0.2.1-macos-arm64.dmg',
            attestation:
              mode === 'ready-verified'
                ? { status: 'verified' }
                : { status: 'unavailable', reason: 'gh_missing' },
          }
        if (mode === 'failed')
          return {
            phase: 'failed',
            ...base,
            code: 'update_checksum_mismatch',
            message:
              '安装包的 SHA-256 与 SHA256SUMS.txt 不符，已拒绝并删除下载的文件。',
          }
        return { phase: 'idle' }
      }
      const visualUpdate: Record<string, unknown> = {
        supported: true,
        automatic: true,
        disabledReason: null,
        enabled: visualUpdateMode !== 'off',
        currentVersion: '0.2.0',
        channel: 'stable',
        checking: false,
        lastCheckedAt: Date.parse('2026-06-26T11:40:00.000Z'),
        lastError: null,
        available: [
          'available',
          'downloading',
          'verifying',
          'ready',
          'ready-verified',
          'failed',
        ].includes(visualUpdateMode)
          ? visualUpdateRelease
          : null,
        download: visualUpdateDownload(visualUpdateMode),
        electron: {
          current: '42.2.0',
          latest: visualUpdateMode === 'outdated' ? '45.0.1' : '42.2.0',
          behind: visualUpdateMode === 'outdated' ? 3 : 0,
          outdated: visualUpdateMode === 'outdated',
        },
        feedOverride:
          visualUpdateMode === 'test-feed' || visualUpdateMode === 'outdated'
            ? 'http://127.0.0.1:8765/repos/TheSyart/emperor-agent/releases'
            : null,
      }
      function visualUpdateRecord(kind: string): void {
        ;((
          window as unknown as Record<string, string[] | undefined>
        ).__visualUpdateCalls ??= []).push(kind)
      }
      function visualUpdateStatus(): Record<string, unknown> {
        return JSON.parse(JSON.stringify(visualUpdate))
      }
      function visualUpdateDiagnostics(): Record<string, unknown> {
        return {
          enabled: visualUpdate.enabled,
          automatic: true,
          disabledReason: null,
          channel: 'stable',
          lastCheckedAt: visualUpdate.lastCheckedAt,
          lastError: null,
          available: null,
          electron: visualUpdate.electron,
          feedOverride: visualUpdate.feedOverride,
        }
      }
      // REL-03 `storage.versions`: `?visualDataVersions=newer` has two files
      // a newer Emperor wrote; `=downgrade` also ran 0.3.0 last time.
      function visualDataVersions() {
        const mode = visualParams.get('visualDataVersions') ?? ''
        const newer = mode === 'newer' || mode === 'downgrade'
        const file = (
          id: string,
          path: string,
          label: string,
          version: number,
          supported: number,
          owner = 'core',
        ) => ({
          id,
          path,
          label,
          owner,
          version,
          supported,
          state: version > supported ? 'newer' : 'ok',
        })
        return {
          appVersion: '0.2.0',
          lastRunVersion: '0.2.0',
          previousRunVersion: mode === 'downgrade' ? '0.3.0' : '0.2.0',
          downgradedFrom: mode === 'downgrade' ? '0.3.0' : null,
          dataVersion: 1,
          supportedDataVersion: 1,
          files: [
            file('installation', 'installation.json', '安装信息', 1, 1),
            file('settings', 'settings.json', '设置', newer ? 2 : 1, 1),
            file(
              'modelConfig',
              'model_config.json',
              '模型配置',
              newer ? 3 : 2,
              2,
            ),
            file('scheduler', 'scheduler/jobs.json', '定时任务', 1, 1),
            file(
              'vault',
              'computer-use/vault.json',
              '密码管理器',
              3,
              3,
              'desktop',
            ),
          ],
          lastRestore: null,
        }
      }
      function visualStorageUsage() {
        const categories = Object.entries(visualStorage).map(([id, bytes]) => ({
          id,
          bytes,
        }))
        return {
          root: '/Users/visual/.emperor',
          total: categories.reduce((sum, item) => sum + item.bytes, 0),
          categories,
          measuredAt: Date.now(),
        }
      }
      function visualBackgroundTask(
        task: Record<string, unknown> & { id: string; kind: string },
      ) {
        const stoppedAt = visualCancelledTasks.get(task.id)
        if (stoppedAt === undefined || task.status !== 'running') return task
        return {
          ...task,
          status: task.kind === 'job' ? 'killed' : 'cancelled',
          finished_at: stoppedAt,
          ...(task.kind === 'job' ? { exit_code: 143 } : {}),
        }
      }
      /** `tasks.transcript` fixture: job output, or a long workflow record. */
      function visualTaskTranscript(taskId: string) {
        if (taskId === 'job-visual-dev')
          return [
            {
              role: 'output',
              content: [
                '> emperor-agent-desktop@0.1.0 dev',
                '> electron-vite dev',
                '',
                'vite v6.3.5 building SSR bundle for development...',
                '✓ 38 modules transformed.',
                'out/main/index.js  182.40 kB',
                'build the electron main process successfully',
                '',
                'dev server running for the electron renderer process at:',
                '  ➜  Local:   http://localhost:5173/',
                'start electron app...',
              ].join('\n'),
            },
          ]
        if (taskId === 'job-visual-test')
          return [
            {
              role: 'output',
              content:
                ' FAIL  src/renderer/src/components/workspace/environmentModel.test.ts\n' +
                'AssertionError: expected 2 to be 1\n[stderr]\nnpm ERR! Test failed.',
            },
          ]
        if (taskId === 'wf-visual-ralph') {
          const entries: Array<{ role: string; content: string }> = [
            {
              role: 'workflow',
              content: 'ralph 修复视觉回归: 逐轮修到截图检查通过',
            },
          ]
          // 12 rounds × 18 entries: more than one 200-entry page.
          for (let round = 1; round <= 12; round++) {
            entries.push(
              { role: 'phase', content: `第 ${round} 轮` },
              {
                role: 'agent',
                content: `#${round} 修复视觉回归 started (sub-ralph-${round})`,
              },
            )
            for (let check = 1; check <= 15; check++)
              entries.push({
                role: 'log',
                content: `截图 ${check}/15：${check % 4 ? '一致' : '差异 0.4%，继续修复'}`,
              })
            if (round < 12)
              entries.push({ role: 'agent', content: `#${round} completed` })
          }
          return entries
        }
        return []
      }
      function visualTasksFor(sessionId: string) {
        const started = Date.parse(now) - 600_000
        const clock = Date.now()
        const subagent = (
          id: string,
          description: string,
          status: 'running' | 'idle',
          offset: number,
          lastStopReason?: string,
        ) => ({
          id,
          kind: 'subagent',
          label: description,
          description,
          status,
          session_id: sessionId,
          owner_id: sessionId,
          started_at: started + offset,
          finished_at: null,
          depth: 1,
          mode: 'spawn',
          last_stop_reason: lastStopReason ?? null,
        })
        if (sessionId === 'build-ui')
          return [
            subagent('sub-visual-review', '审查 Git 服务', 'running', 50_000),
            subagent('sub-visual-docs', '整理环境卡文档', 'idle', 40_000),
            subagent('sub-visual-tests', '补充视觉测试', 'idle', 30_000),
            subagent(
              'sub-visual-icons',
              '核对图标与配色',
              'idle',
              20_000,
              'error',
            ),
            subagent('sub-visual-perf', '测量首屏体积', 'idle', 10_000),
            ...[
              {
                id: 'job-visual-dev',
                kind: 'job',
                job_kind: 'bash',
                label: 'npm run dev',
                description: 'npm run dev',
                status: 'running',
                session_id: sessionId,
                owner_id: sessionId,
                started_at: clock - 185_000,
                finished_at: null,
              },
              {
                id: 'wf-visual-ralph',
                kind: 'workflow',
                label: '修复视觉回归',
                description: '逐轮修到截图检查通过',
                status: 'running',
                session_id: sessionId,
                owner_id: sessionId,
                started_at: clock - 420_000,
                finished_at: null,
                detail: null,
                workflow_tool: 'ralph',
                rounds: 12,
              },
              {
                id: 'job-visual-test',
                kind: 'job',
                job_kind: 'bash',
                label: 'npm test -- --run environmentModel',
                description: 'npm test -- --run environmentModel',
                status: 'failed',
                session_id: sessionId,
                owner_id: sessionId,
                started_at: clock - 900_000,
                finished_at: clock - 840_000,
                exit_code: 1,
                detail: 'exit code: 1',
              },
            ].map(visualBackgroundTask),
          ]
        if (sessionId === 'chat-main')
          return [
            subagent('sub-chat-research', '调研 Codex 环境卡', 'idle', 20_000),
            subagent('sub-chat-summary', '汇总参考截图', 'idle', 10_000),
          ]
        return []
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
        'active',
        'blocked',
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
            outcome: '让 Composer 的目标生命周期清晰、可控并且可恢复',
            objective: '让 Composer 的目标生命周期清晰、可控并且可恢复',
            revision: 1,
            roundsStarted: 2,
            maxGoalRounds: 8,
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
        // Core's builtin tools (skills.tools) with their category; the
        // Computer Use tools carry their plugin and stay off 能力 › 工具.
        tools: [
          {
            name: 'read',
            description:
              'Read a UTF-8 text file and return line-numbered content.',
            category: 'basic',
            source: 'builtin',
            server: '',
            parameters: {
              type: 'object',
              properties: {
                file_path: {
                  type: 'string',
                  description:
                    'Path to read: absolute, or relative to the session working directory.',
                },
                offset: {
                  type: 'number',
                  description: '1-based first line to return. Defaults to 1.',
                },
                limit: {
                  type: 'number',
                  description:
                    'Maximum number of lines to return. Defaults to 2000.',
                },
              },
              required: ['file_path'],
            },
          },
          {
            name: 'bash',
            description:
              'Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Set `run_in_background: true` for long-running commands.',
            category: 'basic',
            source: 'builtin',
            server: '',
            parameters: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'The command to execute.',
                },
                description: {
                  type: 'string',
                  description:
                    'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
                },
                timeoutMs: {
                  type: 'number',
                  description:
                    'Timeout in milliseconds (default 60000, max 600000).',
                },
                run_in_background: {
                  type: 'boolean',
                  description:
                    'Run in the background and return a job id immediately.',
                },
                sandbox_permissions: {
                  type: 'string',
                  enum: ['workspace-write', 'danger-full-access'],
                  description:
                    'Request a wider sandbox mode for this one call (requires user approval).',
                },
              },
              required: ['command', 'description'],
            },
          },
          ...(
            [
              ['write', 'basic', 'Create or fully replace a UTF-8 text file.'],
              [
                'edit',
                'basic',
                'Edit an existing UTF-8 text file by replacing literal text.',
              ],
              [
                'glob',
                'basic',
                'Find files whose paths match a glob pattern. Returns matching file paths — never directories.',
              ],
              [
                'grep',
                'basic',
                'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file.',
              ],
              [
                'job_output',
                'basic',
                'Read a background job. Stream jobs return only output since the previous read.',
              ],
              [
                'job_list',
                'basic',
                'List your background jobs (running and finished) with their ids, kinds, and statuses.',
              ],
              [
                'job_kill',
                'basic',
                'Request cancellation of a running background job by job id.',
              ],
              [
                'web_search',
                'network',
                'Search the web for current information. Provide 1–4 queries in the required queries array.',
              ],
              [
                'todo_write',
                'planning',
                'Record and update a structured task list for the current work. Send the ENTIRE list every call.',
              ],
              [
                'ask_user_question',
                'planning',
                'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding.',
              ],
              [
                'exit_plan_mode',
                'planning',
                "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode.",
              ],
              [
                'get_goal',
                'planning',
                'Read the current same-session goal, including its exact id/revision, objective, phase and round limit.',
              ],
              [
                'create_goal',
                'planning',
                'Create one persisted same-session completion goal when the current direct human request is a long-running objective.',
              ],
              [
                'update_goal',
                'planning',
                'Update the exact current goal revision. Edit, pause and resume require a direct human request.',
              ],
              [
                'scheduler',
                'planning',
                '管理本地持久定时任务：查看、创建、更新、暂停、恢复、删除或手动运行。只读检查使用 list。',
              ],
              [
                'subagent',
                'agents',
                'Delegate a self-contained task to a subagent that works in its own context. The subagent returns its result, not its intermediate steps.',
              ],
              [
                'subagent_fork',
                'agents',
                'Delegate a task to a subagent that inherits this conversation. It is seeded with all completed turns so far.',
              ],
              [
                'list_agents',
                'agents',
                'List the background agents you started (children) or every agent under you (descendants), with their status.',
              ],
              [
                'send_message',
                'agents',
                'Send a message to a background subagent by its subagent id, continuing the same conversation.',
              ],
              [
                'interrupt_agent',
                'agents',
                "Request cancellation of a background agent's current turn by its agent id.",
              ],
              [
                'workflow',
                'agents',
                'Run a JavaScript workflow script that orchestrates subagents at scale.',
              ],
              [
                'ralph',
                'agents',
                'Run a foreground fresh-agent Ralph loop toward one immutable objective.',
              ],
              [
                'skill',
                'config',
                'Load the full instructions for an available skill.',
              ],
              [
                'skill_manage',
                'config',
                'Manage Emperor Skills. Read-only: list and validate; writes: create, update, delete and import.',
              ],
              [
                'memory_edit',
                'config',
                "Edit the user's long-term memory. Replace an exact unique old_string, or append new text.",
              ],
              [
                'mcp_config',
                'config',
                '管理 Emperor 自己的 MCP server 配置（Emperor Home 下的 mcp_config.json；Emperor 只读取这一个文件）。',
              ],
            ] as const
          ).map(([name, category, description]) => ({
            name,
            description,
            category,
            source: 'builtin',
            server: '',
          })),
          ...(
            [
              [
                'ui_get_capabilities',
                'Report which computer-use drivers are available right now.',
              ],
              [
                'browser_open',
                'Open a URL in a new tab of the built-in browser.',
              ],
              [
                'desktop_click',
                'Click an element from the latest desktop observation.',
              ],
            ] as const
          ).map(([name, description]) => ({
            name,
            description,
            source: 'builtin',
            server: '',
            plugin_id: 'computer-use',
          })),
        ],
        plugins: [
          {
            pluginId: 'emperor/web-research',
            name: 'Web Research',
            displayName: 'Web Research',
            description: '抓取网页并整理来源',
            developerName: 'Emperor Agent',
            format: 'emperor-v1',
            logo: null,
            effective: true,
            toggleable: true,
            uninstallable: true,
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
              apps: 0,
            },
          },
          {
            pluginId: 'acme/release-notes',
            name: 'Release Notes',
            displayName: 'Release Notes',
            description: '根据提交生成发布说明',
            developerName: 'Acme',
            format: 'emperor-v1',
            // Unreachable in the harness: the row must fall back to its monogram.
            logo: 'app://plugin-assets/project/acme%2Frelease-notes/logo?v=cccccccc',
            effective: false,
            toggleable: true,
            uninstallable: true,
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
              apps: 0,
            },
          },
          {
            pluginId: 'emperor/pdf-tools',
            name: 'PDF Tools',
            displayName: 'PDF Tools',
            description: '读取和拆分 PDF',
            developerName: 'Emperor Agent',
            format: 'emperor-v1',
            logo: null,
            effective: false,
            toggleable: true,
            uninstallable: true,
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
              apps: 0,
            },
          },
          {
            pluginId: 'computer-use',
            name: 'Computer Use',
            displayName: 'Computer Use',
            description: '让 Emperor 操作浏览器和 Mac 上的应用',
            developerName: 'Emperor Agent',
            format: 'portable',
            logo: pluginLogos['computer-use'],
            effective: true,
            toggleable: true,
            uninstallable: false,
            scope: 'managed',
            version: '1.0.0',
            digest: 'f'.repeat(64),
            source: { kind: 'managed' },
            signature: { status: 'verified', publisher: 'Emperor' },
            enabled: true,
            materialization: 'installed',
            activation: 'active',
            capabilities: {
              skills: 1,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              lspServers: 0,
              commands: 0,
              apps: 3,
            },
          },
          {
            pluginId: 'github',
            name: 'GitHub',
            displayName: 'GitHub',
            description: '与 GitHub 集成',
            developerName: 'Emperor Agent',
            format: 'portable',
            logo: pluginLogos.github,
            effective: true,
            toggleable: true,
            uninstallable: false,
            scope: 'managed',
            version: '1.0.0',
            digest: '9'.repeat(64),
            source: { kind: 'managed' },
            signature: { status: 'verified', publisher: 'Emperor' },
            enabled: true,
            materialization: 'installed',
            activation: 'active',
            capabilities: {
              skills: 1,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              lspServers: 0,
              commands: 0,
              apps: 1,
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
            logsRoot: '/Users/visual/Library/Logs/Emperor Agent',
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
          sandbox: {
            platform: 'darwin',
            backend: 'macos-seatbelt',
            status: 'available',
            filesystem: 'workspace-write',
            network: 'allowed',
            processTree: true,
          },
          processRuntime: {
            ownership: true,
            leases: true,
            reparent: true,
            orphanReconcile: true,
            processTree: 'process_group',
            terminal: { interactiveStdio: true, pty: true },
            outputQuota: {
              defaultBytes: 65536,
              maximumBytes: 8388608,
              defaultStrategy: 'terminate',
            },
          },
          subagents: [],
          effectiveConfig: {
            entries: [
              {
                key: 'model.executionPolicy',
                source: { kind: 'user', id: 'model_config', trust: 'trusted' },
                trace: [{ source: { kind: 'user' }, status: 'applied' }],
                value: {},
              },
              {
                key: 'sandbox.runtime',
                source: { kind: 'builtin', id: 'defaults', trust: 'trusted' },
                trace: [{ source: { kind: 'builtin' }, status: 'applied' }],
                value: {},
              },
              {
                key: 'mcp.config',
                source: { kind: 'user', id: 'mcp_config', trust: 'trusted' },
                trace: [{ source: { kind: 'user' }, status: 'applied' }],
                value: {},
              },
              ...['release-notes', 'web-research', 'visual-build-project'].map(
                (name) => ({
                  key: `skills.${name}`,
                  source: { kind: 'user', id: name, trust: 'trusted' },
                  trace: [{ source: { kind: 'user' }, status: 'applied' }],
                  value: {},
                }),
              ),
            ],
          },
          commandCatalog: { registeredSkills: 3, conflicts: [] },
          desktopPet: {
            enabled: false,
            running: false,
            autoStartWithWebui: false,
            installCommand: 'npm install',
          },
          dependencies: {
            nodeRuntime: true,
            desktopRenderer: true,
            desktopPetModules: false,
          },
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
      // `?visualPluginSuggestion=on` (SEC-07): the project's
      // .emperor/settings.json suggests a project plugin the user has not
      // decided on, so 能力 › 插件 asks 「该项目建议启用 …」.
      if (visualParams.get('visualPluginSuggestion') === 'on')
        boot.plugins.push({
          pluginId: 'acme/repo-lint',
          name: 'Repo Lint',
          displayName: 'Repo Lint',
          description: '提交前检查改动',
          developerName: 'Acme',
          format: 'portable',
          logo: null,
          effective: false,
          toggleable: true,
          uninstallable: true,
          scope: 'project',
          version: '0.4.0',
          digest: '9'.repeat(64),
          source: { kind: 'local', label: 'repo-lint' },
          signature: { status: 'local_user_source', publisher: null },
          enabled: false,
          materialization: 'installed',
          activation: 'disabled',
          suggested: true,
          capabilities: {
            skills: 1,
            agents: 0,
            hooks: 1,
            mcpServers: 0,
            lspServers: 0,
            commands: 0,
            apps: 0,
          },
        } as (typeof boot.plugins)[number])
      // `?visualGithub=off`: the GitHub plugin is turned off, so its Issue /
      // CI tabs go away and github.* reads are refused.
      if (visualParams.get('visualGithub') === 'off') {
        const github = boot.plugins.find((item) => item.pluginId === 'github')
        if (github) {
          github.enabled = false
          github.activation = 'disabled'
        }
      }
      let visualQueuedPrompts: Array<Record<string, unknown>> =
        visualQueueEnabled
          ? [
              {
                id: 'prompt_visual_queue',
                turnId: 'turn_visual_queue',
                clientMessageId: 'prompt_visual_queue',
                delivery: 'queue',
                state:
                  visualQueueMode === 'held' ? 'failed-previous' : 'queued',
                ...(visualQueueMode === 'held'
                  ? { reason: 'previous-turn-failed' }
                  : {}),
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
      if (visualQueueMode === 'on') {
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
      const visualGrantHighImpact =
        visualParams.get('visualGrant') === 'high-impact'
      // Since 2026-09-29 a card asks only for a high-impact action or a
      // credential fill, and only for that one action.
      const visualGrantInteraction = {
        ...visualAskInteraction,
        id: 'grant_visual_grant',
        context: '填写报名表并提交',
        questions: [
          {
            id: 'grant',
            header: '电脑操作',
            question: visualGrantHighImpact
              ? '允许 Agent 执行高影响操作：https://fixture.test/form?utm=1'
              : '允许 Agent 代填密码：https://fixture.test/form?utm=1',
            options: [
              { id: 'once', label: '仅本次' },
              { id: 'deny', label: '拒绝' },
            ],
          },
        ],
        meta: {
          control_session_id: 'build-ui',
          interaction_type: 'computer_use_grant',
          request_id: 'visual_grant',
          grant: {
            subject: 'session:build-ui',
            driver: 'embedded-browser',
            target_scope: {
              kind: 'browser',
              profileId: 'temporary',
              origins: ['https://fixture.test'],
            },
            actions: visualGrantHighImpact ? ['high-impact'] : ['interact'],
            allowed_scopes: ['once'],
            display: { url: 'https://fixture.test/form?utm=1' },
            tool_name: visualGrantHighImpact
              ? 'browser_click'
              : 'browser_fill_credential',
            reason: '填写报名表并提交',
            reason_unverified: true,
            high_impact: visualGrantHighImpact,
            background: false,
          },
        },
      }
      // 历史记录 (RV-10): `?visualGrant=history` asks before a search.
      if (visualParams.get('visualGrant') === 'history')
        Object.assign(visualGrantInteraction.meta.grant, {
          driver: 'external-browser',
          target_scope: {
            kind: 'browser',
            profileId: 'pair-visual-1',
            origins: [],
          },
          actions: ['observe'],
          display: { url: '浏览历史记录：搜索「季度报告」' },
          tool_name: 'external_history_search',
          reason: '找到上周看过的季度报告',
        })
      if (
        visualControlMode === 'ask' ||
        visualControlMode === 'plan' ||
        visualControlMode === 'ask-multi' ||
        visualControlMode === 'permission' ||
        visualControlMode === 'grant'
      ) {
        const interaction =
          visualControlMode === 'ask'
            ? visualAskInteraction
            : visualControlMode === 'ask-multi'
              ? visualMultiAskInteraction
              : visualControlMode === 'permission'
                ? visualPermissionInteraction
                : visualControlMode === 'grant'
                  ? visualGrantInteraction
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

      // ── Pull Request fixture (pullRequests.* ops) ───────────────────
      // Fictional repositories and logins only. `?visualGh=missing` |
      // `unauthenticated` | `failed` switches the gh status; list / view /
      // diff then reject with the matching coded error.
      const visualGhMode = visualParams.get('visualGh')
      const visualGhStatus: Record<string, unknown> =
        visualGhMode === 'missing'
          ? { available: false, reason: 'gh_missing' }
          : visualGhMode === 'unauthenticated'
            ? {
                available: false,
                reason: 'gh_unauthenticated',
                version: '2.63.2',
              }
            : visualGhMode === 'failed'
              ? {
                  available: false,
                  reason: 'gh_failed',
                  version: '2.63.2',
                  message: 'error connecting to api.github.com: i/o timeout',
                }
              : { available: true, login: 'lin-hai', version: '2.63.2' }
      type VisualPr = {
        repo: string
        number: number
        title: string
        author: string
        draft?: boolean
        reviewing?: boolean
        head: string
        checks: string | null
        review: string | null
        updatedMin: number
        createdMin: number
        commits: number
        body: string
        files: Array<[string, number, number]>
        runs: Array<[string, string, string | null]>
        diff?: string[]
      }
      // Half a minute of slack so ages read whole minutes on screen.
      const visualPrAgo = (minutes: number) =>
        new Date(Date.now() - minutes * 60_000 - 30_000).toISOString()
      const visualPulls: VisualPr[] = [
        {
          repo: 'aurora-labs/orbit-desktop',
          number: 482,
          title: '设置页：重做分区导航与键盘焦点管理',
          author: 'lin-hai',
          head: 'feat/settings-nav',
          checks: 'success',
          review: 'REVIEW_REQUIRED',
          updatedMin: 120,
          createdMin: 3 * 1440,
          commits: 5,
          body: [
            '<!-- 请描述改动的动机和测试方式 -->',
            '## 改动',
            '',
            '- 设置页左侧分区列表支持 ↑ / ↓ 移动焦点，Enter 打开分区',
            '- 新增 `useFocusRing()`，焦点离开列表时回到当前分区',
            '- 删除旧的 `legacyNav()` 查询',
            '',
            '## 测试',
            '',
            '- [x] `npm test`',
            '- [x] 手动验证深色 / 浅色主题',
            '- [ ] Windows 高对比度模式',
            '',
            '![设置页截图](https://example.com/settings-nav.png)',
            '',
            '相关讨论见 https://github.com/aurora-labs/orbit-desktop/issues/470',
          ].join('\n'),
          files: [
            ['src/renderer/settings/SettingsNav.vue', 4, 2],
            ['src/renderer/settings/focusRing.ts', 10, 0],
            ['src/renderer/settings/legacyNav.ts', 0, 3],
            ['docs/settings.md', 2, 1],
          ],
          runs: [
            ['build (macos-14)', 'COMPLETED', 'SUCCESS'],
            ['build (ubuntu-22.04)', 'COMPLETED', 'SUCCESS'],
            ['lint', 'COMPLETED', 'SUCCESS'],
            ['unit-tests', 'COMPLETED', 'SUCCESS'],
            ['docs-preview', 'COMPLETED', 'SKIPPED'],
          ],
          diff: [
            'diff --git a/src/renderer/settings/SettingsNav.vue b/src/renderer/settings/SettingsNav.vue',
            'index 5c1e2a4..9b07d31 100644',
            '--- a/src/renderer/settings/SettingsNav.vue',
            '+++ b/src/renderer/settings/SettingsNav.vue',
            '@@ -12,9 +12,11 @@ const props = defineProps<{',
            '   sections: SettingsSection[]',
            '   active: string',
            ' }>()',
            '-const emit = defineEmits<{ select: [id: string] }>()',
            '+const emit = defineEmits<{ select: [id: string]; focusout: [] }>()',
            '+const ring = useFocusRing()',
            ' ',
            ' function onKeydown(event: KeyboardEvent) {',
            "-  if (event.key !== 'ArrowDown') return",
            "+  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return",
            "+  ring.move(event.key === 'ArrowDown' ? 1 : -1)",
            '   event.preventDefault()',
            ' }',
            'diff --git a/src/renderer/settings/focusRing.ts b/src/renderer/settings/focusRing.ts',
            'new file mode 100644',
            'index 0000000..3fa91c2',
            '--- /dev/null',
            '+++ b/src/renderer/settings/focusRing.ts',
            '@@ -0,0 +1,10 @@',
            "+import { ref } from 'vue'",
            '+',
            '+/** Roving focus over the settings navigation rows. */',
            '+export function useFocusRing() {',
            '+  const index = ref(0)',
            '+  const move = (delta: number) => {',
            '+    index.value = Math.max(0, index.value + delta)',
            '+  }',
            '+  return { index, move }',
            '+}',
            'diff --git a/src/renderer/settings/legacyNav.ts b/src/renderer/settings/legacyNav.ts',
            'deleted file mode 100644',
            'index 7d2c0e1..0000000',
            '--- a/src/renderer/settings/legacyNav.ts',
            '+++ /dev/null',
            '@@ -1,3 +0,0 @@',
            '-export function legacyNav() {',
            "-  return document.querySelector('.settings-nav')",
            '-}',
            'diff --git a/docs/settings.md b/docs/settings.md',
            'index 1a2b3c4..5d6e7f8 100644',
            '--- a/docs/settings.md',
            '+++ b/docs/settings.md',
            '@@ -3,4 +3,5 @@',
            ' ## 键盘导航',
            ' ',
            '-设置页只支持鼠标选择分区。',
            '+在分区列表中用 ↑ / ↓ 移动焦点，Enter 打开分区。',
            '+焦点离开列表时会回到当前分区。',
            ' ',
            '',
          ],
        },
        {
          repo: 'aurora-labs/orbit-core',
          number: 1302,
          title: 'Stream tool results through the projector in batches',
          author: 'dmitri-v',
          reviewing: true,
          head: 'perf/projector-batches',
          checks: 'pending',
          review: 'REVIEW_REQUIRED',
          updatedMin: 20,
          createdMin: 2 * 1440,
          commits: 3,
          body: 'Batches `tool_result` projections so long shell output no longer re-renders the whole turn.\n\n- Flushes every 50 ms or 64 KiB\n- Keeps ordering per call id',
          files: [
            ['packages/core/src/projection/projector.ts', 48, 17],
            ['packages/core/src/projection/projector.test.ts', 66, 4],
          ],
          runs: [
            ['build', 'COMPLETED', 'SUCCESS'],
            ['unit-tests', 'IN_PROGRESS', null],
            ['e2e', 'QUEUED', null],
          ],
        },
        {
          repo: 'aurora-labs/orbit-core',
          number: 1291,
          title: 'Fix race in session log compaction when two writers flush',
          author: 'k-sato',
          reviewing: true,
          head: 'fix/compaction-race',
          checks: 'failure',
          review: 'CHANGES_REQUESTED',
          updatedMin: 1500,
          createdMin: 6 * 1440,
          commits: 4,
          body: 'Two writers could both observe `seq = n` and append a compaction marker twice. This takes the append lock before reading the tail.',
          files: [
            ['packages/core/src/session-log/compaction.ts', 23, 11],
            ['packages/core/src/session-log/compaction.test.ts', 41, 0],
          ],
          runs: [
            ['build', 'COMPLETED', 'SUCCESS'],
            ['unit-tests', 'COMPLETED', 'FAILURE'],
            ['lint', 'COMPLETED', 'SUCCESS'],
          ],
        },
        {
          repo: 'nimbus-io/ledger-sync',
          number: 77,
          title: 'Add retry budget to webhook delivery',
          author: 'ariel-w',
          reviewing: true,
          head: 'feat/webhook-retry-budget',
          checks: 'success',
          review: 'APPROVED',
          updatedMin: 3 * 1440 + 60,
          createdMin: 12 * 1440,
          commits: 7,
          body: 'Caps retries per endpoint with a token bucket so one failing receiver cannot starve the queue.',
          files: [
            ['internal/webhooks/deliver.go', 58, 12],
            ['internal/webhooks/budget.go', 74, 0],
            ['internal/webhooks/deliver_test.go', 96, 8],
          ],
          runs: [
            ['go-test', 'COMPLETED', 'SUCCESS'],
            ['golangci-lint', 'COMPLETED', 'SUCCESS'],
          ],
        },
        {
          repo: 'aurora-labs/orbit-desktop',
          number: 479,
          title: '桌宠动画改用 sprite sheet',
          author: 'lin-hai',
          draft: true,
          head: 'wip/pet-sprites',
          checks: null,
          review: null,
          updatedMin: 9 * 1440,
          createdMin: 15 * 1440,
          commits: 2,
          body: '草稿：先把帧动画迁到单张 sprite sheet，性能数据稍后补充。',
          files: [
            ['desktop/src/pet/sprite.ts', 120, 0],
            ['desktop/src/pet/PetCanvas.vue', 34, 52],
          ],
          runs: [],
        },
        {
          repo: 'aurora-labs/orbit-core',
          number: 1284,
          title: 'chore(deps): bump vitest from 2.1.8 to 2.1.9',
          author: 'dependabot',
          head: 'dependabot/npm_and_yarn/vitest-2.1.9',
          checks: 'success',
          review: null,
          updatedMin: 23 * 1440,
          createdMin: 24 * 1440,
          commits: 1,
          body: 'Bumps vitest from 2.1.8 to 2.1.9.',
          files: [
            ['package.json', 1, 1],
            ['package-lock.json', 18, 18],
          ],
          runs: [
            ['build', 'COMPLETED', 'SUCCESS'],
            ['unit-tests', 'COMPLETED', 'SUCCESS'],
          ],
        },
        {
          repo: 'nimbus-io/ledger-sync',
          number: 71,
          title: '文档：补充离线同步的冲突处理说明',
          author: 'lin-hai',
          head: 'docs/offline-conflicts',
          checks: null,
          review: 'CHANGES_REQUESTED',
          updatedMin: 95 * 1440,
          createdMin: 101 * 1440,
          commits: 3,
          body: '补充三种冲突场景的处理顺序和示例。',
          files: [['docs/offline-sync.md', 64, 9]],
          runs: [],
        },
      ]
      const visualPrTotals = (pr: VisualPr) =>
        pr.files.reduce(
          (sum, [, add, del]) => [sum[0]! + add, sum[1]! + del],
          [0, 0],
        )
      function visualPrItem(pr: VisualPr) {
        const [additions, deletions] = visualPrTotals(pr)
        return {
          repo: pr.repo,
          number: pr.number,
          title: pr.title,
          state: 'OPEN',
          isDraft: Boolean(pr.draft),
          url: `https://github.com/${pr.repo}/pull/${pr.number}`,
          author: pr.author,
          createdAt: visualPrAgo(pr.createdMin),
          updatedAt: visualPrAgo(pr.updatedMin),
          headRefName: pr.head,
          additions,
          deletions,
          checks: pr.checks,
          reviewDecision: pr.review,
        }
      }
      function visualPrDiff(pr: VisualPr): string {
        if (pr.diff) return pr.diff.join('\n')
        return pr.files
          .map(([path, add, del]) =>
            [
              `diff --git a/${path} b/${path}`,
              '--- a/' + path,
              '+++ b/' + path,
              `@@ -1,${del + 1} +1,${add + 1} @@`,
              ' // unchanged',
              ...Array.from({ length: del }, (_, i) => `-old line ${i + 1}`),
              ...Array.from({ length: add }, (_, i) => `+new line ${i + 1}`),
            ].join('\n'),
          )
          .join('\n')
      }
      function visualPrFailure(): unknown {
        const code =
          visualGhMode === 'missing'
            ? 'pull_request_gh_missing'
            : visualGhMode === 'unauthenticated'
              ? 'pull_request_gh_unauthenticated'
              : 'pull_request_gh_failed'
        return { ok: false, error: { message: 'gh unavailable', code } }
      }
      function visualPrLookup(input: unknown): VisualPr | null {
        const ref = (input ?? {}) as { repo?: string; number?: number }
        return (
          visualPulls.find(
            (pr) => pr.repo === ref.repo && pr.number === ref.number,
          ) ?? null
        )
      }
      const visualPrNotFound = {
        ok: false,
        error: {
          message: '找不到该 Pull Request，或当前账户无权访问该仓库。',
          code: 'pull_request_not_found',
        },
      }

      // ── GitHub plugin fixture (github.* ops) ────────────────────────
      // Issues that involve lin-hai and the Actions runs of two fictional
      // repositories. One title is markup on purpose: the page must show it
      // as text. Reads are refused while the plugin is off
      // (`?visualGithub=off`) and follow `?visualGh=` like the PR fixture.
      const visualIssueNow = Date.now()
      const visualAgo = (minutes: number) =>
        new Date(visualIssueNow - minutes * 60_000).toISOString()
      const visualIssues = [
        {
          repo: 'aurora-labs/orbit-desktop',
          number: 511,
          title: 'Sidebar loses its width after the window is restored',
          author: 'mei-chen',
          updated: 25,
          labels: [
            { name: 'bug', color: 'd73a4a' },
            { name: 'ui', color: '1d76db' },
          ],
          comments: 4,
          assignees: ['lin-hai'],
          filters: ['involved', 'assigned', 'owned'],
        },
        {
          repo: 'aurora-labs/orbit-desktop',
          number: 498,
          title:
            '<img src=x onerror=alert(1)> Markdown preview renders raw HTML',
          author: 'lin-hai',
          updated: 180,
          labels: [{ name: 'security', color: 'b60205' }],
          comments: 41,
          assignees: [],
          filters: ['involved', 'created'],
        },
        {
          repo: 'emperor-agent/visual-build-project',
          number: 77,
          title: 'Document the release checklist',
          author: 'ops-bot',
          updated: 60 * 26,
          labels: [{ name: 'docs', color: 'not-a-color' }],
          comments: 0,
          assignees: [],
          filters: ['involved', 'mentioned', 'owned'],
        },
      ]
      function visualIssueItem(issue: (typeof visualIssues)[number]) {
        return {
          repo: issue.repo,
          number: issue.number,
          title: issue.title,
          state: 'OPEN',
          url: `https://github.com/${issue.repo}/issues/${issue.number}`,
          author: issue.author,
          createdAt: visualAgo(issue.updated + 60 * 24 * 3),
          updatedAt: visualAgo(issue.updated),
          labels: issue.labels,
          commentCount: issue.comments,
        }
      }
      const visualRuns = [
        [
          'emperor-agent/visual-build-project',
          9101,
          'ci',
          'Stream tool results in batches',
          'completed',
          'success',
          'push',
          'main',
          212,
          12,
        ],
        [
          'emperor-agent/visual-build-project',
          9100,
          'ci',
          'Retry flaky terminal test',
          'completed',
          'failure',
          'pull_request',
          'fix/terminal',
          211,
          95,
        ],
        [
          'emperor-agent/visual-build-project',
          9099,
          'release',
          'Nightly package',
          'in_progress',
          null,
          'schedule',
          'main',
          58,
          3,
        ],
        [
          'emperor-agent/visual-build-project',
          9098,
          'ci',
          'Update dependencies',
          'completed',
          'cancelled',
          'workflow_dispatch',
          'deps',
          210,
          60 * 30,
        ],
        [
          'aurora-labs/orbit-desktop',
          8001,
          'build',
          'Sidebar width fix',
          'completed',
          'success',
          'push',
          'main',
          40,
          30,
        ],
      ] as const
      function visualRunItem(run: (typeof visualRuns)[number]) {
        const [
          repo,
          id,
          name,
          title,
          status,
          conclusion,
          event,
          branch,
          runNumber,
          minutes,
        ] = run
        return {
          id,
          name,
          title,
          status,
          conclusion,
          event,
          branch,
          runNumber,
          createdAt: visualAgo(minutes),
          updatedAt: visualAgo(Math.max(0, minutes - 9)),
          url: `https://github.com/${repo}/actions/runs/${id}`,
          actor: 'lin-hai',
        }
      }
      function visualGithubRefusal(): unknown | null {
        const github = boot.plugins.find((item) => item.pluginId === 'github')
        if (github?.activation !== 'active')
          return {
            ok: false,
            error: {
              message:
                'GitHub 插件已停用；在「能力 › 插件」里启用后再查看 Issue 与 CI。',
              code: 'github_plugin_disabled',
            },
          }
        return visualGhStatus.available ? null : visualPrFailure()
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
      /**
       * Core's answer to a call that needs a real session and names none
       * (`SESSION_REQUIRED`) or names a draft (`invalid_session`); null when
       * it names a session.
       */
      function visualSessionRefusal(sessionId: unknown) {
        const id = String(sessionId ?? '').trim()
        if (!id)
          return visualSkillError('请先打开一个会话再试。', 'SESSION_REQUIRED')
        if (id.startsWith('draft:'))
          return visualSkillError(`unknown session ${id}`, 'invalid_session')
        return null
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

      const dictationListeners = new Set<VisualCoreListener>()
      const visualDictation = { session: 'visual-dictation-1', seq: 0 }
      const emitDictation = (event: Record<string, unknown>) => {
        visualDictation.seq += 1
        const full = {
          ...event,
          session: visualDictation.session,
          seq: visualDictation.seq,
        }
        for (const listener of dictationListeners) listener(full)
      }

      // Settings › 语音 (VO-02): `?visualDictation=denied|unavailable|unsupported`.
      const visualDictationStatus = () => {
        const mode = visualParams.get('visualDictation')
        const ready = {
          supported: true,
          available: true,
          engine: 'sf-speech',
          permissions: { microphone: 'granted', speech: 'granted' },
          devices: [
            {
              id: 'BuiltInMicrophoneDevice',
              name: 'MacBook Pro麦克风',
              default: true,
            },
            { id: 'USB-Mic-1', name: 'Blue Yeti', default: false },
          ],
          locales: [
            { id: 'en-GB', name: '英语（英国）' },
            { id: 'en-US', name: '英语（美国）' },
            { id: 'yue-CN', name: '粤语（中国大陆）' },
            { id: 'zh-CN', name: '中文（中国大陆）' },
            { id: 'zh-TW', name: '中文（台湾）' },
          ],
          systemLocale: 'zh-Hans-US',
          active: false,
        }
        const gone = {
          available: false,
          engine: null,
          devices: [],
          locales: [],
          systemLocale: null,
          permissions: { microphone: 'unknown', speech: 'unknown' },
        }
        if (mode === 'denied')
          return {
            ...ready,
            permissions: { microphone: 'denied', speech: 'undetermined' },
          }
        if (mode === 'unavailable')
          return {
            ...ready,
            ...gone,
            reason: 'Emperor Dictation Helper 无法启动',
          }
        if (mode === 'unsupported')
          return {
            ...ready,
            ...gone,
            supported: false,
            reason: '听写目前只支持 macOS',
          }
        return ready
      }

      window.emperor = {
        appVersion: async () => '0.2.0-visual',
        // `?visualDictation=live` is a Mac, so the composer shows its mic.
        platform:
          visualParams.get('visualDictation') === 'live' ? 'darwin' : 'visual',
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
        // REL-01 诊断包: main stages the bundle, the user confirms its
        // contents, main asks where to save it (here: always ~/Desktop).
        prepareDiagnosticsBundle: async () => ({
          ok: true,
          bundle: {
            id: 'b_0123456789ab',
            name: 'emperor-diagnostics-20261020-163000',
            entries: [
              {
                path: 'README.txt',
                title: '说明：包含什么、不包含什么',
                bytes: 1180,
              },
              {
                path: 'diagnostics.json',
                title: 'Core 诊断（diagnostics.get）',
                bytes: 48213,
              },
              {
                path: 'app.json',
                title: '版本、fuse、Helper 与扩展状态',
                bytes: 2306,
              },
              {
                path: 'model-config.json',
                title: '模型配置结构（不含 Key）',
                bytes: 1544,
              },
              { path: 'system.json', title: '操作系统信息', bytes: 412 },
              {
                path: 'crashes.json',
                title: '崩溃转储清单（只有文件名）',
                bytes: 96,
              },
              {
                path: 'logs/main.log',
                title: '主进程日志（脱敏）',
                bytes: 1_874_002,
              },
              {
                path: 'logs/core.log',
                title: 'Core 日志（脱敏）',
                bytes: 220_481,
              },
            ],
            excluded: [
              '会话与消息内容',
              '记忆',
              'API Key、令牌等密钥',
              '崩溃转储文件本身（只列出文件名）',
            ],
          },
        }),
        exportDiagnosticsBundle: async (id: string) => {
          ;((
            window as unknown as { __visualDiagnosticsExports?: string[] }
          ).__visualDiagnosticsExports ??= []).push(id)
          return {
            ok: true,
            name: 'emperor-diagnostics-20261020-163000.zip',
            location: '~/Desktop',
          }
        },
        revealDiagnosticsBundle: async () => ({ ok: true }),
        discardDiagnosticsBundle: async (id: string) => {
          ;((
            window as unknown as { __visualDiagnosticsDiscarded?: string[] }
          ).__visualDiagnosticsDiscarded ??= []).push(id)
          return { ok: true }
        },
        // REL-03 备份与恢复: main counts the backup, asks where to save it
        // (here: always ~/Documents), opens a backup the user picked and
        // restarts after a restore. Calls are recorded for the specs.
        planHomeBackup: async () => ({
          ok: true,
          plan: {
            name: 'Emperor 备份 2026-10-20',
            categories: [
              {
                id: 'config',
                title: '设置与配置',
                description: '设置、模型、MCP、Hooks 与子智能体设置',
                files: 7,
                bytes: 48_213,
                optional: false,
              },
              {
                id: 'memory',
                title: '记忆',
                description: '长期记忆、用户档案与版本历史',
                files: 18,
                bytes: 1_204_118,
                optional: false,
              },
              {
                id: 'extensions',
                title: 'Skills、插件与智能体',
                description: '你安装和编写的 Skills、插件与自定义智能体',
                files: 214,
                bytes: 9_437_184,
                optional: false,
              },
              {
                id: 'projects',
                title: '项目与定时任务',
                description: '项目设置和定时任务',
                files: 6,
                bytes: 22_016,
                optional: false,
              },
              {
                id: 'sessions',
                title: '会话',
                description: '会话记录、附件与用量记录',
                files: 1_204,
                bytes: 128_974_848,
                optional: true,
              },
            ],
            excluded: [
              '浏览器登录资料与缓存',
              'Agent 下载的文件',
              '日志',
              '受管环境工具',
              '运行时与临时文件',
            ],
            vault: { state: 'ready', entries: 4 },
          },
        }),
        exportHomeBackup: async (input: Record<string, unknown>) => {
          ;((
            window as unknown as {
              __visualHomeBackupExports?: Array<Record<string, unknown>>
            }
          ).__visualHomeBackupExports ??= []).push({ ...input })
          return {
            ok: true,
            name: 'Emperor 备份 2026-10-20.emperor-backup.zip',
            location: '~/Documents',
            credentials: typeof input.passphrase === 'string',
          }
        },
        revealHomeBackup: async () => ({ ok: true }),
        openHomeBackup: async () => ({
          ok: true,
          backup: {
            id: 'r_0123456789ab',
            name: 'Emperor 备份 2026-10-19.emperor-backup.zip',
            createdAt: '2026-10-19T08:00:00.000Z',
            appVersion: '0.2.0',
            categories: [
              'config',
              'memory',
              'extensions',
              'projects',
              'sessions',
            ],
            credentials: true,
            files: 1_449,
            bytes: 139_685_379,
            newer: false,
          },
        }),
        restoreHomeBackup: async (id: string, passphrase?: string) => {
          ;((
            window as unknown as {
              __visualHomeBackupRestores?: Array<Record<string, unknown>>
            }
          ).__visualHomeBackupRestores ??= []).push({ id, passphrase })
          return { ok: true }
        },
        discardHomeBackup: async (id: string) => {
          ;((
            window as unknown as { __visualHomeBackupDiscarded?: string[] }
          ).__visualHomeBackupDiscarded ??= []).push(id)
          return { ok: true }
        },
        openPath: async (target: VisualOpenPathTarget) => {
          // Main resolves these through Core; the harness records what the
          // renderer asked for (an invalid Skill's folder, a Skill, a row).
          const opened =
            target.kind === 'invalid-skill'
              ? target.path.replace(/\/[^/]+\.md$/i, '')
              : target.kind === 'skill'
                ? `skill:${target.name}`
                : `diagnostic:${target.rowId}`
          ;((
            window as unknown as { __visualOpenedPaths?: string[] }
          ).__visualOpenedPaths ??= []).push(opened)
          return { ok: true }
        },
        // UI-S06: `?visualLinks=record` gives the bridge link routing that
        // records each web link (window.__visualLinks) instead of opening it.
        ...(visualParams.get('visualLinks') === 'record'
          ? {
              openLink: async (url: string) => {
                ;((
                  window as unknown as { __visualLinks?: string[] }
                ).__visualLinks ??= []).push(url)
                return { opened: 'system' }
              },
            }
          : {}),
        openBrowserUrl: async (input: string) => {
          const text = String(input ?? '').trim()
          ;(visualBrowser.__visualBrowserOpened ??= []).push(text)
          if (
            /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) &&
            !/^https?:/i.test(text)
          )
            return { ok: false, error: '只支持 http 和 https 网址' }
          const local = /^(localhost|127\.)/i.test(text)
          const url = new URL(
            /^https?:\/\//i.test(text)
              ? text
              : `${local ? 'http' : 'https'}://${text}`,
          ).href
          const base = { url, title: '', canGoBack: false, canGoForward: false }
          emitBrowserState({ ...base, loading: true })
          if (new URL(url).port === '9')
            setTimeout(
              () =>
                emitBrowserState({
                  ...base,
                  loading: false,
                  error: 'ERR_CONNECTION_REFUSED (-102)',
                }),
              30,
            )
          return { ok: true, url }
        },
        browserBounds: (bounds: unknown) => {
          ;(visualBrowser.__visualBrowserBounds ??= []).push(bounds ?? null)
        },
        browserAction: (action: string) => {
          ;(visualBrowser.__visualBrowserActions ??= []).push(action)
        },
        browserClose: () => {
          visualBrowser.__visualBrowserClosed =
            (visualBrowser.__visualBrowserClosed ?? 0) + 1
        },
        onBrowserState: (listener: VisualCoreListener) => {
          browserListeners.add(listener)
          return () => browserListeners.delete(listener)
        },
        agentPreviewStart: async (targetId: string) => {
          setTimeout(() => void drawVisualFrame(targetId), 20)
          return { ok: true, width: 1280, height: 800 }
        },
        agentPreviewStop: () => {},
        onAgentPreviewFrame: (listener: VisualCoreListener) => {
          previewListeners.add(listener)
          return () => previewListeners.delete(listener)
        },
        onAgentPreviewPointer: (listener: VisualCoreListener) => {
          pointerListeners.add(listener)
          return () => pointerListeners.delete(listener)
        },
        dictationStatus: async () => visualDictationStatus(),
        vaultStatus: async () => ({
          available: !visualBrowserState.vaultProblem,
          backend: 'emperor-local',
          ...(visualBrowserState.vaultProblem
            ? { problem: visualBrowserState.vaultProblem }
            : {}),
          locked: false,
          hasMasterPassword: false,
          handles: visualBrowserState.vault,
        }),
        vaultSave: async (draft: Record<string, unknown>) => {
          const handleId =
            (draft.handleId as string | undefined) ??
            `cred_visual_${visualBrowserState.vault.length + 1}`
          const entry = {
            handleId,
            label: draft.label,
            bindings: draft.bindings,
            fields: ['password'],
            fillMode: 'confirm',
            revealUsername: draft.revealUsername === true,
          }
          visualBrowserState.vault = [
            ...visualBrowserState.vault.filter(
              (item) => item.handleId !== handleId,
            ),
            entry,
          ]
          return entry
        },
        vaultRemove: async (handleId: string) => {
          visualBrowserState.vault = visualBrowserState.vault.filter(
            (item) => item.handleId !== handleId,
          )
          return { ok: true }
        },
        vaultUnlock: async () => ({ unlocked: true }),
        vaultLock: async () => ({ ok: true }),
        vaultSetMaster: async () => ({ ok: true }),
        vaultReveal: async () => ({ password: 'visual-only' }),
        vaultReset: async () => {
          visualBrowserState.vault = []
          visualBrowserState.vaultProblem = null
          return { ok: true }
        },
        clearBrowserData: async () => ({ ok: true }),
        // `?visualDownloads=none`: both lists are empty.
        browserDownloads: async () =>
          visualParams.get('visualDownloads') === 'none'
            ? { user: [], agent: [] }
            : visualBrowserState.downloads,
        openBrowserDownload: async () => ({ ok: true }),
        revealBrowserDownload: async () => ({ ok: true }),
        removeBrowserDownload: async (id: string) => {
          visualBrowserState.downloads.user =
            visualBrowserState.downloads.user.filter((entry) => entry.id !== id)
          return { ok: true }
        },
        chooseDownloadFolder: async () => '/Users/visual/Downloads/Emperor',
        // 从浏览器导入 (ST-06). `?visualImport=running` shows the "close it
        // first" warning; otherwise Chrome/Edge read as closed.
        browserImportSources: async () => ({
          browsers: [
            {
              browser: 'chrome',
              name: 'Google Chrome',
              installed: true,
              running: visualParams.get('visualImport') === 'running',
              profiles: [
                { dir: 'Default', name: '个人' },
                { dir: 'Profile 1', name: '工作' },
              ],
            },
            {
              browser: 'edge',
              name: 'Microsoft Edge',
              installed: true,
              running: false,
              profiles: [{ dir: 'Default', name: '默认' }],
            },
          ],
        }),
        runBrowserImport: async () => ({ ok: true, passwords: 12, sites: 5 }),
        onBrowserDownload: (listener: VisualCoreListener) => {
          downloadListeners.add(listener)
          return () => downloadListeners.delete(listener)
        },
        agentDownloadReveal: async () => ({ ok: true }),
        agentDownloadMove: async () => ({
          ok: true,
          path: `${projectDir}/downloads/invoice-2026-09.pdf`,
        }),
        agentDownloadSaveAs: async () => ({ ok: false, cancelled: true }),
        // 设置 › 电脑操作: `?visualHelper=denied` leaves Accessibility and
        // Screen Recording off; `?visualPairing=pending` has a pairing code
        // waiting.
        macHelperStatus: async () => {
          const denied = visualParams.get('visualHelper') === 'denied'
          return {
            available: true,
            connected: true,
            helperVersion: '0.3.0',
            protocol: 1,
            permissions: {
              accessibility: denied ? 'denied' : 'granted',
              'screen-recording': denied ? 'denied' : 'granted',
            },
            lastErrorCode: null,
          }
        },
        macHelperRequestPermission: async () => ({ opened: true }),
        macHelperResetPermission: async () => ({ reset: true }),
        macHelperReconnect: async () => ({
          available: true,
          connected: true,
          helperVersion: '0.3.0',
          protocol: 1,
          permissions: {
            accessibility: 'granted',
            'screen-recording': 'granted',
          },
          lastErrorCode: null,
        }),
        browserPairings: async () => {
          // Chrome is paired and connected unless `?visualExtension=` says
          // otherwise (`closed`: paired, Chrome not running).
          const extension = visualParams.get('visualExtension')
          const paired = extension === null || extension === 'closed'
          const connected = extension === null
          return {
            bridgeListening: true,
            pendingPairings:
              visualParams.get('visualPairing') === 'pending'
                ? [
                    {
                      pairingId: 'pair-visual-2',
                      extensionId: 'aofcidkmgjlbaidneiodhljmoleejnpe',
                      code: '482913',
                      displayed: true,
                      browser: 'chrome',
                    },
                  ]
                : [],
            pairedConnections: connected ? ['pair-visual-1'] : [],
            attachedTabs: connected ? 2 : 0,
            pairings: paired
              ? [
                  {
                    pairingId: 'pair-visual-1',
                    browser: 'chrome',
                    connected,
                    tabs: connected ? 2 : 0,
                    createdAt: '2026-09-30T08:00:00.000Z',
                  },
                ]
              : [],
          }
        },
        ...(() => {
          // 设置 › 电脑操作 › Chrome 和 Edge, `?visualExtension=`: `none`
          // has no folder yet (安装扩展程序 puts it there), `ready` the
          // folder but no browser has loaded it, `legacy` Chrome loaded it
          // from a checkout; otherwise Chrome runs it. Edge is not installed.
          const mode = visualParams.get('visualExtension')
          let folderReady = mode !== 'none'
          const status = () => ({
            folder: {
              path: '/Users/visual/.emperor/browser-extension',
              displayPath: '~/.emperor/browser-extension',
              ready: folderReady,
              version: folderReady ? '0.2.0' : null,
            },
            bundledVersion: '0.2.0',
            browsers: [
              {
                browser: 'chrome',
                name: 'Google Chrome',
                present: true,
                extension:
                  mode === null || mode === 'closed' ? 'loaded' : 'none',
                ...(mode === 'legacy'
                  ? {
                      loadedFrom:
                        '~/Documents/workspace/emperor-agent/desktop/extension',
                    }
                  : {}),
                developerMode: mode !== 'none' && mode !== 'ready',
                hostRegistered: folderReady,
              },
              {
                browser: 'edge',
                name: 'Microsoft Edge',
                present: false,
                extension: 'none',
                developerMode: false,
                hostRegistered: false,
              },
            ],
          })
          return {
            browserExtensionStatus: async () => status(),
            installBrowserExtension: async () => {
              folderReady = true
              return { ok: true, registered: ['chrome'], status: status() }
            },
            revealBrowserExtension: async () => ({ ok: folderReady }),
            removeBrowserExtension: async () => {
              folderReady = false
              return { ok: true, uninstalled: 1, status: status() }
            },
            onBrowserPairingRequest: () => () => {},
          }
        })(),
        approveBrowserPairing: async () => true,
        denyBrowserPairing: async () => true,
        revokeBrowserPairing: async () => true,
        dictationOpenPrivacy: async (pane: string) => {
          ;((
            window as unknown as { __visualPrivacyOpened?: string[] }
          ).__visualPrivacyOpened ??= []).push(pane)
          return { opened: true }
        },
        // `?visualDictation=live`: a scripted dictation — started and two
        // partial results after a start, the final and the end on stop.
        dictationStart: async () => {
          if (visualParams.get('visualDictation') !== 'live')
            return {
              ok: false,
              code: 'unavailable',
              message: '视觉测试里没有听写组件',
            }
          visualDictation.seq = 0
          const heard = [
            { type: 'started', locale: 'zh-CN' },
            { type: 'partial', text: '帮我看一下' },
            { type: 'partial', text: '帮我看一下今天的构建为什么失败' },
          ]
          heard.forEach((event, index) =>
            setTimeout(() => emitDictation(event), 30 * (index + 1)),
          )
          // RV-06: about 3 seconds of a voice's loudness for the waveform,
          // ending on 0.37, after the last partial result.
          const voice = [
            0.02, 0.03, 0.02, 0.04, 0.03, 0.05, 0.04, 0.12, 0.35, 0.62, 0.48,
            0.71, 0.55, 0.3, 0.06, 0.4, 0.66, 0.82, 0.58, 0.44, 0.27, 0.05,
            0.04, 0.33, 0.52, 0.47, 0.69, 0.6, 0.38, 0.22, 0.09, 0.45, 0.73,
            0.64, 0.5, 0.31, 0.06, 0.03, 0.05, 0.28, 0.56, 0.77, 0.61, 0.48,
            0.37,
          ]
          setTimeout(() => {
            for (const value of voice) emitDictation({ type: 'level', value })
          }, 30 * heard.length)
          return { ok: true, session: visualDictation.session }
        },
        dictationStop: async () => {
          emitDictation({
            type: 'final',
            text: '帮我看一下今天的构建为什么失败。',
          })
          emitDictation({ type: 'ended', reason: 'stopped' })
          return { ok: true }
        },
        dictationCancel: async () => {
          emitDictation({ type: 'ended', reason: 'cancelled' })
          return { ok: true }
        },
        onDictationEvent: (listener: VisualCoreListener) => {
          dictationListeners.add(listener)
          return () => dictationListeners.delete(listener)
        },
        onCoreEvent: (listener: VisualCoreListener) => {
          // Specs push host runtime events (git receipts, scheduler runs …).
          ;(
            window as unknown as {
              __visualEmitCoreEvent?: (event: unknown) => void
            }
          ).__visualEmitCoreEvent = (event) => {
            for (const target of environmentListeners) target(event)
          }
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
          // FIX-05: the workspace panes' Core calls, in order and timed, so
          // specs can count polls and resizes (window.__visualWorkspaceOps).
          if (/^(?:git|terminals|files|workspace)\./.test(operationKey))
            ((
              window as unknown as {
                __visualWorkspaceOps?: Array<{
                  op: string
                  at: number
                  input: unknown
                }>
              }
            ).__visualWorkspaceOps ??= []).push({
              op: operationKey,
              at: performance.now(),
              input: args[0],
            })
          if (
            operationKey === 'references.resolve' ||
            operationKey === 'references.preview' ||
            operationKey === 'references.siteIcon'
          ) {
            const state = window as unknown as {
              __visualResourceOps?: Array<{ operation: string; input: unknown }>
            }
            state.__visualResourceOps ??= []
            state.__visualResourceOps.push({
              operation: operationKey,
              input: args[0],
            })
          }
          switch (operationKey) {
            case 'references.siteIcon': {
              const input = args[0] as { referenceId: string }
              return input.referenceId.includes('offline')
                ? { state: 'unavailable', updatedAt: Date.now() }
                : {
                    state: 'ready',
                    dataUrl:
                      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
                    updatedAt: Date.now(),
                  }
            }
            case 'references.resolve': {
              const input = args[0] as {
                href: string
                label: string
                sourceMessageId: string
                sessionId: string
              }
              const web = /^https?:/.test(input.href)
              const path = input.href.replace(/#L\d+$/, '')
              return {
                id: `ref:${input.href}`,
                kind: web ? 'web' : 'project_file',
                label: input.label,
                tooltip: web ? input.href : `${projectDir}/${path}`,
                available: !path.includes('gone'),
                actions: web ? ['open_external'] : ['open_files'],
                ...(!web ? { relativePath: path } : {}),
                ...(path.endsWith('/') ? { directory: true } : {}),
              }
            }
            case 'references.preview': {
              const input = args[0] as { referenceId: string }
              if (input.referenceId.includes('offline'))
                return {
                  state: 'error',
                  reason: 'network_unavailable',
                  updatedAt: Date.now(),
                }
              return {
                state: 'ready',
                title: input.referenceId.includes('github.com')
                  ? 'Emperor GitHub 资源'
                  : '网页指南',
                description: '这是视觉夹具返回的页面摘要，未进行实际联网。',
                updatedAt: Date.now(),
              }
            }
            case 'bootstrap':
              return boot
            case 'commands.list':
            case 'commands.complete': {
              // Core's schema (FIX-14): a session id, or a draft id that
              // may carry its draftSession; never an empty owner.
              const input = (args[0] ?? {}) as {
                sessionId?: string
                draftSession?: unknown
              }
              const owner = String(input.sessionId ?? '').trim()
              if (
                !owner ||
                (input.draftSession != null && !owner.startsWith('draft:'))
              )
                throw new Error(`Invalid arguments for ${operationKey}`)
              return operationKey === 'commands.list' ? visualCommands : []
            }
            case 'commands.invoke':
              return {
                status: 'rejected',
                code: 'visual_command_not_executed',
                message: '视觉夹具不执行命令副作用。',
              }
            case 'sessions.list':
              return sessions
            case 'sessions.listDeleted':
              return []
            case 'sessions.defaults':
              return { permission: 'workspace-write' }
            case 'sessions.setDefaults':
              return {
                permission: (args[0] as { permission: string }).permission,
              }
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
            case 'sessions.search': {
              // Content search (UI-S02 palette): one canned hit.
              const query = (args[0] as { query: string }).query
              return {
                hits: query.includes('设计稿')
                  ? [
                      {
                        sessionId: 'chat-main',
                        title: '普通对话',
                        role: 'assistant',
                        snippet: '…对照设计稿，侧栏的间距应该收紧到 8px…',
                      },
                    ]
                  : [],
              }
            }
            case 'sessions.lineage':
              return lineageOf((args[0] as { sessionId: string }).sessionId)
            case 'agents.list': {
              // The agent tree (AGT-10): every recorded subagent under the
              // given roots, nested children under their parent.
              const input = (args[0] ?? {}) as { rootSessionIds?: string[] }
              const agents: Array<Record<string, unknown>> = []
              for (const root of input.rootSessionIds ?? []) {
                // A session with a transcript but no recorded subagents
                // falls back to the tasks.list fixture's subagents (the
                // environment card); an empty session stays empty (hero).
                if (!childrenOf(root).length) {
                  if (!rawLogs.get(root)?.events.length) continue
                  for (const task of visualTasksFor(root)) {
                    if (task.kind !== 'subagent') continue
                    agents.push({
                      id: task.id,
                      kind: 'internal',
                      backend: 'internal',
                      rootSessionId: root,
                      parentAgentId: root,
                      title: task.description,
                      phase:
                        task.status === 'running'
                          ? 'running'
                          : task.last_stop_reason === 'error'
                            ? 'failed'
                            : 'completed',
                      createdAt: task.started_at,
                      updatedAt: task.started_at,
                    })
                  }
                  continue
                }
                const queue = [{ session: root, parent: root }]
                while (queue.length) {
                  const { session, parent } = queue.shift()!
                  for (const child of childrenOf(session)) {
                    const id = String(child.subagentId)
                    agents.push({
                      id,
                      kind: 'internal',
                      backend: 'internal',
                      rootSessionId: root,
                      parentAgentId: parent,
                      title: String(child.description || id),
                      phase:
                        child.status === 'running' ? 'running' : 'completed',
                      createdAt: 1782475200000,
                      updatedAt: 1782475200000,
                      ...(child.callId ? { parentCallId: child.callId } : {}),
                    })
                    queue.push({ session: id, parent: id })
                  }
                }
                // Claude Code / Codex runs of the root (UI-S14): the same
                // phases Core's agent list gives them.
                const runs = new Map<string, Record<string, unknown>>()
                for (const event of rawLogs.get(root)?.events ?? []) {
                  if (event.type !== 'delegation/projection') continue
                  const data = event.data ?? {}
                  const task = (data.task ?? {}) as Record<string, unknown>
                  const status = String(task.status ?? 'running')
                  const id = String(data.delegation_id)
                  const createdAt = Number(task.started_at ?? 1782475200000)
                  runs.set(id, {
                    id,
                    kind: 'external',
                    backend: data.backend,
                    rootSessionId: root,
                    parentAgentId: root,
                    title: String(task.description ?? id),
                    phase:
                      status === 'waiting_input'
                        ? 'waiting'
                        : status === 'completed'
                          ? 'completed'
                          : status === 'interrupted'
                            ? 'interrupted'
                            : status === 'failed' || status === 'cancelled'
                              ? 'failed'
                              : status === 'outcome_unknown'
                                ? 'unknown'
                                : 'running',
                    createdAt,
                    updatedAt: Number(task.finished_at ?? createdAt),
                    ...(data.parent_call_id
                      ? { parentCallId: data.parent_call_id }
                      : {}),
                  })
                }
                agents.push(...runs.values())
              }
              return { agents }
            }
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
                __visualPromotionDelayMs?: number
              }
              ;(record.__visualSubmits ??= []).push({ ...input })
              // Core promotes a draft on its first message and announces the
              // real session before the turn starts; the renderer has to
              // follow. Mirror that here or the draft path goes untested.
              const target = String(input.sessionId || '')
              if (!target.startsWith('draft:'))
                return streamVisualReply(target, input)
              // FIX-13: `__visualPromotionDelayMs` holds the announcement
              // back, for what the user does in the meantime.
              if (record.__visualPromotionDelayMs)
                await new Promise((resolve) =>
                  setTimeout(resolve, record.__visualPromotionDelayMs),
                )
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
            // 设置 › 高级 › 任务预算 (KRN-03): the defaults, saved in memory.
            case 'storage.usage':
              return visualStorageUsage()
            case 'updates.status':
              return visualUpdateStatus()
            case 'updates.setEnabled':
              visualUpdate.enabled = Boolean(args[0])
              if (!visualUpdate.enabled) visualUpdate.available = null
              visualUpdateRecord(`switch:${visualUpdate.enabled}`)
              return visualUpdateStatus()
            case 'updates.check':
              visualUpdateRecord('check')
              return visualUpdateStatus()
            case 'updates.download':
              visualUpdateRecord('download')
              visualUpdate.download = visualUpdateDownload('downloading')
              return visualUpdateStatus()
            case 'updates.cancelDownload':
              visualUpdateRecord('cancel')
              visualUpdate.download = { phase: 'idle' }
              return visualUpdateStatus()
            case 'updates.reveal':
              visualUpdateRecord('reveal')
              return visualUpdateStatus()
            case 'storage.versions':
              return visualDataVersions()
            case 'storage.clean': {
              const freed = visualStorage.spill - 4_194_304
              visualStorage.spill = 4_194_304
              const none = { removed: 0, bytes: 0 }
              return {
                report: {
                  sessions: none,
                  spill: {
                    removed: freed > 0 ? 12 : 0,
                    bytes: Math.max(0, freed),
                  },
                  memoryVersions: none,
                  delegations: none,
                  freedBytes: Math.max(0, freed),
                  errors: [],
                },
                usage: visualStorageUsage(),
              }
            }
            case 'tasks.budget':
              return { ...visualTaskBudget }
            case 'tasks.setBudget':
              Object.assign(visualTaskBudget, args[0] ?? {})
              return { ...visualTaskBudget }
            case 'tasks.cancel': {
              const id = String(args[0] ?? '')
              if (!visualCancelledTasks.has(id))
                visualCancelledTasks.set(id, Date.now())
              return { id }
            }
            case 'tasks.transcript': {
              const taskId = String(args[0] ?? '')
              const options = (args[1] ?? {}) as {
                offset?: number
                limit?: number
              }
              const entries = visualTaskTranscript(taskId)
              const offset = options.offset ?? 0
              const limit = options.limit ?? 200
              return {
                taskId,
                entries: entries.slice(offset, offset + limit),
                offset,
                total: entries.length,
                eof: offset + limit >= entries.length,
              }
            }
            case 'tasks.list':
              return visualTasksFor(
                String(
                  ((args[0] ?? {}) as { sessionId?: string }).sessionId || '',
                ),
              )
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
            // The status bar's queue actions (UI-S04): recorded on
            // `window.__visualQueueActions`, and the message leaves the list.
            case 'chat.manageQueuedPrompt': {
              const body = (args[0] || {}) as {
                promptId?: string
                action?: string
              }
              const record = window as unknown as {
                __visualQueueActions?: Array<{
                  promptId?: string
                  action?: string
                }>
              }
              record.__visualQueueActions = [
                ...(record.__visualQueueActions ?? []),
                { promptId: body.promptId, action: body.action },
              ]
              const known = visualQueuedPrompts.some(
                (item) => item.id === body.promptId,
              )
              visualQueuedPrompts = visualQueuedPrompts.filter(
                (item) => item.id !== body.promptId,
              )
              return known
                ? { ok: true }
                : { ok: false, reason: 'prompt_not_queued' }
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
                worktrees: { worktrees: [], owned: [] },
                gitReceipts: [],
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
            case 'git.remote':
              return {
                name: 'origin',
                webUrl: 'https://github.com/emperor-agent/visual-build-project',
                provider: 'github',
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
              // UI-S06: `?visualGitPr=open` — the branch has a draft PR;
              // `?visualGitPr=gh-missing` — the GitHub CLI is unavailable.
              if (visualParams.get('visualGitPr') === 'gh-missing')
                throw new Error('git_gh_unavailable: GitHub CLI unavailable')
              return visualParams.get('visualGitPr') === 'open'
                ? {
                    number: 128,
                    url: 'https://github.com/emperor-agent/visual-build-project/pull/128',
                    state: 'OPEN',
                    draft: true,
                    mergeable: 'MERGEABLE',
                    headRefName: 'main',
                    baseRefName: 'release',
                    checks: [],
                  }
                : null
            case 'git.enterWorktree':
            case 'git.exitWorktree':
              return { status: visualGitStatus }
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
            case 'git.commit':
              // `?visualGitCommit=reject`: the pre-commit hook says no.
              if (visualParams.get('visualGitCommit') === 'reject')
                throw new Error(
                  'pre-commit hook failed: eslint found 2 problems in src/app.ts',
                )
              return visualGitStatus
            case 'git.stage':
            case 'git.unstage':
            case 'git.discard':
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
            case 'files.stat':
            case 'files.read':
            case 'files.preview': {
              const input = (args[0] || {}) as {
                path?: string
                relativePath?: string
              }
              const path = input.path || input.relativePath || 'README.md'
              // FIX-05: `window.__visualFileVersion` (default 1) stands for
              // edits on disk; `src/long.ts` is 240 lines for scrolling.
              const version =
                (window as unknown as { __visualFileVersion?: number })
                  .__visualFileVersion ?? 1
              const content = path.includes('long')
                ? Array.from(
                    { length: 240 },
                    (_, index) =>
                      `export const line${index + 1} = ${index + 1} // v${version}`,
                  ).join('\n') + '\n'
                : version > 1
                  ? `# Visual Build Project\n\nA project workspace visual fixture.\n\nEdited on disk (v${version}).\n`
                  : '# Visual Build Project\n\nA project workspace visual fixture.\n'
              const bytes = new TextEncoder().encode(content).length
              const modifiedAt = Date.parse(now) + version
              if (operationKey === 'files.stat') return { bytes, modifiedAt }
              return {
                id: `file:${projectDir}/${path}`,
                path: `${projectDir}/${path}`,
                projectRoot: projectDir,
                relativePath: path,
                name: path.split('/').pop(),
                kind: 'text',
                mimeType: path.endsWith('.md') ? 'text/markdown' : 'text/plain',
                bytes,
                modifiedAt,
                truncated: false,
                content,
              }
            }
            case 'terminals.list':
              return [visualTerminal]
            case 'terminals.create':
              return visualTerminal
            case 'terminals.read':
              // Core's shape: the terminal's summary with the chunks.
              return {
                terminal: visualTerminal,
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
                source: 'vendor_api',
                truncated: false,
                totalCount: 3,
                models: [
                  {
                    id: 'visual-main',
                    name: 'Visual Main',
                    ownedBy: 'Visual Labs',
                    kind: 'chat',
                    family: 'visual',
                    releaseDate: '2026-09-01',
                    contextWindowTokens: 1_048_576,
                    maxOutputTokens: 131_072,
                    capabilities: {
                      toolCall: true,
                      vision: true,
                      reasoning: true,
                    },
                    reasoning: {
                      efforts: ['none', 'low', 'high'],
                      defaultEffort: 'high',
                      control: 'effort',
                    },
                    source: 'vendor_api',
                    fieldSources: {},
                  },
                  {
                    id: 'visual-secondary',
                    ownedBy: 'Visual Labs',
                    kind: 'chat',
                    family: 'visual',
                    releaseDate: '2026-03-01',
                    contextWindowTokens: 128_000,
                    maxOutputTokens: 16_384,
                    capabilities: { toolCall: true },
                    lifecycle: {
                      status: 'deprecated',
                      retiresAt: '2026-12-01',
                    },
                    source: 'catalog',
                    fieldSources: {},
                  },
                  {
                    id: 'visual-pro',
                    ownedBy: 'Visual Research',
                    kind: 'chat',
                    family: 'visual-pro',
                    releaseDate: '2026-08-15',
                    contextWindowTokens: 262_144,
                    maxOutputTokens: 131_072,
                    capabilities: { toolCall: true, reasoning: true },
                    reasoning: {
                      efforts: ['low', 'high', 'max'],
                      defaultEffort: 'max',
                      control: 'always',
                    },
                    acceptsTemperature: false,
                    source: 'catalog',
                    fieldSources: {},
                  },
                ],
              }
            case 'model.probeConnection': {
              const input = (args[0] || {}) as any
              if (input.provider === 'lm_studio')
                return { ok: false, code: 'NETWORK', message: 'refused' }
              return {
                ok: true,
                latencyMs: 42,
                modelCount: input.provider === 'ollama' ? 2 : 3,
                method: 'list',
              }
            }
            case 'model.updateConnection': {
              const input = (args[0] || {}) as any
              const lead = modelConfig.models.find(
                (entry: any) => entry.entryId === input.entryId,
              )
              let updated = 0
              for (const entry of modelConfig.models)
                if (lead && entry.provider === lead.provider) {
                  if (input.apiKey)
                    entry.apiKey = `***${String(input.apiKey).slice(-4)}`
                  if (input.apiBase) entry.apiBase = input.apiBase
                  updated += 1
                }
              // Real IPC structured-clones results (see model.saveEntry).
              return JSON.parse(JSON.stringify({ ...modelConfig, updated }))
            }
            case 'model.refreshMetadata': {
              const input = (args[0] || {}) as any
              const diffs = (input.entryIds || []).map((entryId: string) => {
                const entry = modelConfig.models.find(
                  (item: any) => item.entryId === entryId,
                )
                return {
                  entryId,
                  modelId: entry?.modelId ?? entryId,
                  source: 'catalog',
                  changes:
                    entry?.provider === 'anthropic'
                      ? [
                          {
                            field: 'contextWindowTokens',
                            from: entry.contextWindowTokens,
                            to: 1_000_000,
                          },
                          {
                            field: 'maxTokens',
                            from: entry.maxTokens,
                            to: 32_000,
                          },
                        ]
                      : [],
                }
              })
              if (input.apply)
                for (const diff of diffs)
                  for (const change of diff.changes) {
                    const entry = modelConfig.models.find(
                      (item: any) => item.entryId === diff.entryId,
                    )
                    if (entry) entry[change.field] = change.to
                  }
              return { diffs, applied: Boolean(input.apply) }
            }
            case 'model.replaceEntry': {
              const input = (args[0] || {}) as any
              const index = modelConfig.models.findIndex(
                (entry: any) => entry.entryId === input.entryId,
              )
              const old = modelConfig.models[index]
              const next = {
                ...old,
                entryId: `${input.modelId}-entry`,
                modelId: input.modelId,
                displayName: '',
                effectiveDisplayName: 'DeepSeek V4.1 Flash',
                contextWindowTokens: 1_048_576,
                maxTokens: 32_000,
                lifecycle: undefined,
                resolvedProfile: {
                  ...old.resolvedProfile,
                  vision: true,
                  contextWindowTokens: 1_048_576,
                  maxTokens: 32_000,
                },
              }
              modelConfig.models = modelConfig.models.map((entry: any) =>
                entry === old ? next : entry,
              )
              if (modelConfig.activeModelId === old.entryId)
                modelConfig.activeModelId = next.entryId
              return JSON.parse(
                JSON.stringify({
                  ...modelConfig,
                  replacedEntryId: next.entryId,
                }),
              )
            }
            case 'model.lookupDefaults':
              return {
                facts: {
                  key: 'fallback',
                  kind: 'chat',
                  capabilities: {},
                  source: 'fallback',
                },
                source: 'fallback',
              }
            case 'model.saveEntries': {
              const input = (args[0] || {}) as any
              const savedEntryIds: string[] = []
              for (const entry of input.entries || []) {
                const entryId =
                  entry.entryId ||
                  `visual-entry-${modelConfig.models.length + 1}`
                const overrides = entry.capabilityOverrides || {}
                modelConfig.models.push({
                  ...visualModelEntry,
                  ...entry,
                  provider: input.connection.provider,
                  protocol: input.connection.protocol,
                  apiBase: input.connection.apiBase,
                  entryId,
                  apiKey: '',
                  effectiveDisplayName: entry.displayName || entry.modelId,
                  resolvedProfile: {
                    ...visualModelEntry.resolvedProfile,
                    toolCall:
                      overrides.toolCall ?? entry.detected?.toolCall ?? true,
                    vision: overrides.vision ?? entry.detected?.vision ?? false,
                    reasoning:
                      overrides.reasoning ?? entry.detected?.reasoning ?? false,
                    contextWindowTokens: entry.contextWindowTokens,
                    maxTokens: entry.maxTokens,
                  },
                })
                savedEntryIds.push(entryId)
              }
              if (input.activateEntryId) {
                modelConfig.activeModelId = input.activateEntryId
                const active = modelConfig.models.find(
                  (item: any) => item.entryId === input.activateEntryId,
                )
                modelConfig.current = active ? currentForEntry(active) : null
              }
              return {
                ...JSON.parse(JSON.stringify(modelConfig)),
                savedEntryIds,
              }
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
            case 'mcp.serverLog': {
              const name = String((args[0] as { name?: string })?.name)
              return {
                name,
                text: visualMcpServers[name]
                  ? [
                      'GitHub MCP Server running on stdio',
                      'Using token sk-***',
                      'tools/list: 3 tools',
                      'GET https://api.github.com/search/repositories?q=emperor&token=*** 200 (182 ms)',
                    ].join('\n')
                  : null,
              }
            }
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
              return visualUpdateMode
                ? { ...boot.diagnostics, updates: visualUpdateDiagnostics() }
                : boot.diagnostics
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
                format: 'portable',
                capabilities: {
                  skills: ['visual'],
                  agents: [],
                  hooks: ['PreToolUse#1'],
                  mcpServers: [],
                  lspServers: [],
                  commands: [],
                  apps: [],
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
                displayName: 'Visual Kit',
                description: null,
                developerName: null,
                format: 'portable',
                logo: null,
                effective: true,
                toggleable: true,
                uninstallable: true,
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
                  apps: 0,
                },
              }
              if (local) boot.plugins.push(plugin)
              return { changed: true, plugin }
            }
            case 'plugins.getDetail': {
              const input = (args[0] ?? {}) as {
                pluginId?: string
                scope?: string
              }
              const plugin = boot.plugins.find(
                (item) =>
                  item.pluginId === input.pluginId &&
                  item.scope === input.scope,
              )
              if (!plugin) throw new Error('找不到这个插件')
              const members: Record<string, Array<Record<string, unknown>>> = {
                // The drivers as a Mac without the Helper's permissions and
                // without a paired Chrome would show them.
                'computer-use': [
                  {
                    kind: 'skill',
                    id: 'computer-use',
                    title: 'computer-use',
                    description:
                      'Operate web pages in the built-in browser and macOS app windows',
                    state: 'available',
                    reason: null,
                  },
                  {
                    kind: 'app',
                    id: 'desktop',
                    title: 'macOS 桌面',
                    description:
                      '通过 Emperor Computer Helper 操作 Mac 上的应用窗口',
                    state: 'needs_connection',
                    reason: '请在电脑操作设置中连接 helper 并授予辅助功能权限',
                  },
                  {
                    kind: 'app',
                    id: 'embedded-browser',
                    title: '内置浏览器',
                    description:
                      'Emperor 自带的浏览器标签页，与你自己的浏览器分开',
                    state: 'available',
                    reason: null,
                  },
                  {
                    kind: 'app',
                    id: 'external-browser',
                    title: 'Chrome/Edge 连接',
                    description:
                      '通过扩展操作你在 Chrome 或 Edge 里连接的标签页',
                    state: 'needs_connection',
                    reason: '请在扩展中完成配对并连接标签页',
                  },
                ],
                github: [
                  {
                    kind: 'skill',
                    id: 'github',
                    title: 'github',
                    description: '用本机已登录的 GitHub CLI（gh）只读地查询',
                    state: 'available',
                    reason: null,
                  },
                  {
                    kind: 'app',
                    id: 'github',
                    title: 'GitHub（本机 gh）',
                    description:
                      '用本机已登录的 gh 读取 Issue、CI 运行记录和 PR 检查',
                    state: 'available',
                    reason: '已登录 lin-hai',
                  },
                ],
                'emperor/web-research': [
                  {
                    kind: 'skill',
                    id: 'web-research',
                    title: 'web-research',
                    description: '搜索网页并整理来源',
                    state: 'available',
                    reason: null,
                  },
                  {
                    kind: 'skill',
                    id: 'cite-sources',
                    title: 'cite-sources',
                    description: '为结论附上可点击的来源',
                    state: 'failed',
                    reason: '与个人的同名 Skill 冲突，未生效',
                  },
                  {
                    kind: 'mcp',
                    id: 'search',
                    title: 'search',
                    description: 'http · search.example.com',
                    state: 'running',
                    reason: null,
                  },
                  {
                    kind: 'app',
                    id: 'drive',
                    title: 'drive',
                    description: '',
                    state: 'unsupported',
                    reason: 'Emperor 还不支持这个应用连接',
                  },
                  // `?visualHookFailure=on` (SEC-07): the guard failed for
                  // want of a variable its manifest does not declare.
                  visualParams.get('visualHookFailure') === 'on'
                    ? {
                        kind: 'hook',
                        id: 'PreToolUse#1',
                        title: 'PreToolUse · bash',
                        description: 'python3 "$PLUGIN_ROOT/hooks/guard.py"',
                        state: 'failed',
                        reason:
                          '最近一次运行失败（退出码 1）：KeyError: SEARCH_API_KEY',
                        variables: [
                          { name: 'SEARCH_API_KEY', state: 'undeclared' },
                          { name: 'SEARCH_REGION', state: 'unset' },
                        ],
                      }
                    : {
                        kind: 'hook',
                        id: 'PreToolUse#1',
                        title: 'PreToolUse · bash',
                        description: 'python3 "$PLUGIN_ROOT/hooks/guard.py"',
                        state: 'available',
                        reason: null,
                      },
                  {
                    kind: 'hook',
                    id: 'PostToolUse#1',
                    title: 'PostToolUse · WebFetch',
                    description: 'log.sh',
                    state: 'unsupported',
                    reason: 'Emperor 没有与「WebFetch」对应的工具',
                  },
                  {
                    kind: 'agent',
                    id: 'agents/reviewer.md',
                    title: 'reviewer',
                    description: '',
                    state: 'unsupported',
                    reason: 'Emperor 不支持插件里的子代理',
                  },
                ],
              }
              const prompts: Record<string, string[]> = {
                'emperor/web-research': [
                  '帮我查一下这周 Electron 的安全公告，并列出来源',
                ],
                github: [
                  '看看我名下还开着的 Pull Request',
                  '最近一次 CI 为什么失败',
                ],
              }
              // 工具 (ST-09): Computer Use's GUI tools by driver as Core
              // lists them (listed while it is off too), and the MCP
              // member's tools while its server runs.
              const toolRows = (
                rows: ReadonlyArray<readonly [string, string, boolean]>,
              ) =>
                rows.map(([name, description, readOnly]) => ({
                  name,
                  description,
                  parameters: { type: 'object', properties: {} },
                  readOnly,
                }))
              const running = plugin.activation === 'active'
              const pluginTools: Record<
                string,
                { note: string | null; groups: Array<Record<string, unknown>> }
              > = {
                'computer-use': {
                  note: plugin.enabled ? null : '打开电脑操作后可用',
                  groups: [
                    {
                      id: 'ui',
                      kind: 'computer-use',
                      title: '通用',
                      note: null,
                      tools: toolRows([
                        [
                          'ui_get_capabilities',
                          'Report which computer-use drivers are available right now, what each can do and what is missing.',
                          true,
                        ],
                        [
                          'ui_list_targets',
                          'List the tabs and windows this conversation currently controls, with their ids, state and which one is current.',
                          true,
                        ],
                        [
                          'ui_release_control',
                          'Release a window or tab before the task ends, when you are done with it.',
                          false,
                        ],
                        [
                          'ui_credential_list',
                          'List the user’s saved credentials as handles (label, registered sites and apps, and username when allowed).',
                          true,
                        ],
                        [
                          'ui_action_status',
                          'Look up what happened to an earlier GUI action by operationId or callId.',
                          true,
                        ],
                        [
                          'ui_cancel_action',
                          'Cancel a GUI action that is still running.',
                          false,
                        ],
                      ]),
                    },
                    {
                      id: 'embedded-browser',
                      kind: 'computer-use',
                      title: '内置浏览器',
                      note: null,
                      tools: [
                        {
                          name: 'browser_open',
                          description:
                            'Open a URL in a new tab of the built-in browser, which the user can watch in the Browser pane. By default the tab uses a private temporary profile that is wiped when it closes.',
                          parameters: {
                            type: 'object',
                            properties: {
                              url: {
                                type: 'string',
                                description:
                                  'http(s) URL to open in a new agent tab.',
                              },
                              profile: {
                                type: 'string',
                                description:
                                  'Browser profile id from browser_profile_list (default: temporary, cleared when the tab closes).',
                              },
                              reason: { type: 'string' },
                            },
                            required: ['url'],
                            additionalProperties: false,
                          },
                          readOnly: false,
                        },
                        ...toolRows([
                          [
                            'browser_tab_list',
                            'List the browser tabs of this conversation: the ones you control, and built-in tabs released when an earlier task ended.',
                            true,
                          ],
                          [
                            'browser_download',
                            'Download one file into the download inbox by clicking a download link (ref) or fetching a URL.',
                            false,
                          ],
                          [
                            'browser_fill_credential',
                            'Fill a username, password or one-time code from the user’s credential vault into a field, by handle.',
                            false,
                          ],
                          [
                            'browser_upload',
                            'Upload files through a page’s file input.',
                            false,
                          ],
                          [
                            'browser_profile_list',
                            'List browser profiles: the temporary one and persistent ones that keep cookies and logins between tasks.',
                            true,
                          ],
                          [
                            'browser_profile_manage',
                            'Create a persistent browser profile (a separate cookie jar that keeps logins between tasks).',
                            false,
                          ],
                          [
                            'browser_tab_select',
                            'Make one of your tabs the current tab for later browser_* calls.',
                            false,
                          ],
                          [
                            'browser_close',
                            'Close one of your built-in browser tabs (the current one by default).',
                            false,
                          ],
                          [
                            'browser_observe',
                            'Read the current page as a list of interactive elements with refs, their roles, names, values and states, plus a text excerpt.',
                            true,
                          ],
                          [
                            'browser_screenshot',
                            'Capture the visible part of the current tab.',
                            true,
                          ],
                          [
                            'browser_click',
                            'Click an element by its ref from the latest observation.',
                            false,
                          ],
                          [
                            'browser_fill',
                            'Replace the text of an input field.',
                            false,
                          ],
                          [
                            'browser_type',
                            'Type text into the focused element (or the element ref).',
                            false,
                          ],
                          [
                            'browser_press',
                            'Press a key or key combination, e.g. Enter, Tab, Escape, Meta+A.',
                            false,
                          ],
                          [
                            'browser_select',
                            'Choose an option of a drop-down list (select element) by its label.',
                            false,
                          ],
                          [
                            'browser_scroll',
                            'Scroll the page or a scrollable element by pages or lines.',
                            false,
                          ],
                          [
                            'browser_navigate',
                            'Go to a URL in the current tab, or move back / forward / reload.',
                            false,
                          ],
                          [
                            'browser_wait',
                            'Wait until a condition holds: navigation, an element present / absent / enabled, page text, or network idle.',
                            true,
                          ],
                        ]),
                      ],
                    },
                    {
                      id: 'external-browser',
                      kind: 'computer-use',
                      title: 'Chrome 和 Edge',
                      note: null,
                      tools: toolRows([
                        [
                          'external_tab_list',
                          'List Chrome tabs the user explicitly attached in the Emperor extension.',
                          true,
                        ],
                        [
                          'external_tab_attach',
                          'Claim one Chrome tab that the user connected from the Emperor extension.',
                          false,
                        ],
                        [
                          'external_tab_open',
                          'Open an http(s) URL in a new tab of the user’s own Chrome or Edge (in the tab group “Emperor”) and work in it.',
                          false,
                        ],
                        [
                          'external_history_search',
                          'Search the browsing history of the user’s own Chrome or Edge, as the user’s setting allows.',
                          true,
                        ],
                      ]),
                    },
                    {
                      id: 'desktop',
                      kind: 'computer-use',
                      title: 'Mac 应用',
                      note: null,
                      tools: toolRows([
                        [
                          'desktop_list_apps',
                          'List running desktop applications.',
                          true,
                        ],
                        [
                          'desktop_list_windows',
                          'List currently addressable desktop windows, optionally for one appId.',
                          true,
                        ],
                        [
                          'desktop_bind',
                          'Bind one recently listed desktop window as a target for observation.',
                          false,
                        ],
                        [
                          'desktop_observe',
                          'Read a bound desktop window as semantic elements.',
                          true,
                        ],
                        [
                          'desktop_screenshot',
                          'Capture a bound desktop window.',
                          true,
                        ],
                        [
                          'desktop_click',
                          'Click an element from the latest desktop observation, or a point from a current screenshot when image vision is available.',
                          false,
                        ],
                        [
                          'desktop_fill',
                          "Set an input field's text with non-secret text, in the background.",
                          false,
                        ],
                        [
                          'desktop_select',
                          'Choose one non-secret option from an observed desktop drop-down by its exact label.',
                          false,
                        ],
                        [
                          'desktop_fill_credential',
                          'Fill a saved credential into an observed desktop field by handle.',
                          false,
                        ],
                        [
                          'desktop_type',
                          'Type non-secret text into a text field of the bound app.',
                          false,
                        ],
                        [
                          'desktop_press',
                          'Press a key or key combination in the bound app.',
                          false,
                        ],
                        [
                          'desktop_scroll',
                          'Scroll the desktop window or an element by pages or lines.',
                          false,
                        ],
                        [
                          'desktop_drag',
                          'Drag from one observed element or screenshot point to another with the real pointer.',
                          false,
                        ],
                        [
                          'desktop_menu',
                          "List the bound app's menu bar, or the menu under path.",
                          true,
                        ],
                        [
                          'desktop_menu_select',
                          'Run a menu command of the bound app by its exact titles from desktop_menu.',
                          false,
                        ],
                        [
                          'desktop_activate',
                          "Bring the bound window's app to the front, restoring a minimized window.",
                          false,
                        ],
                        [
                          'desktop_secondary',
                          'Perform an action explicitly listed for an element in the latest desktop observation.',
                          false,
                        ],
                      ]),
                    },
                  ],
                },
                'emperor/web-research': {
                  note: null,
                  groups: [
                    {
                      id: 'search',
                      kind: 'mcp',
                      title: 'search',
                      note: running ? null : '服务器没有运行',
                      tools: running
                        ? toolRows([
                            [
                              'mcp_web-research-search_search',
                              '[MCP:web-research-search] Search the web and return ranked results with snippets.',
                              true,
                            ],
                            [
                              'mcp_web-research-search_fetch_page',
                              '[MCP:web-research-search] Fetch one page as readable text.',
                              true,
                            ],
                          ])
                        : [],
                    },
                  ],
                },
              }
              return {
                pluginId: plugin.pluginId,
                scope: plugin.scope,
                format: plugin.format,
                version: plugin.version,
                displayName: plugin.displayName,
                description: plugin.description,
                longDescription:
                  plugin.pluginId === 'computer-use'
                    ? '开启后，Emperor 可以在内置浏览器、Chrome 和 Mac 应用里观察和操作。开关与「设置 › 电脑操作」的总开关是同一个。'
                    : null,
                developerName: plugin.developerName,
                category: plugin.scope === 'managed' ? '效率' : null,
                homepage: null,
                license: null,
                logo: plugin.logo ?? null,
                logoIssue: null,
                prompts: prompts[String(plugin.pluginId)] ?? [],
                enabled: plugin.enabled,
                effective: plugin.effective,
                activation: plugin.activation,
                materialization: plugin.materialization,
                toggleable: plugin.toggleable,
                uninstallable: plugin.uninstallable,
                source: plugin.source,
                signature: plugin.signature,
                digest: plugin.digest,
                installedAt:
                  plugin.scope === 'managed'
                    ? null
                    : '2026-09-28T09:30:00.000Z',
                permissions: {
                  runsCommands: plugin.pluginId === 'emperor/web-research',
                  // Remote MCP or app members (GitHub's gh, Computer Use's drivers).
                  network:
                    plugin.scope === 'managed' ||
                    plugin.pluginId === 'emperor/web-research',
                  // What its manifest's env lets its hooks read (SEC-07).
                  env:
                    plugin.pluginId === 'emperor/web-research'
                      ? ['SEARCH_REGION']
                      : [],
                },
                components: (members[String(plugin.pluginId)] ?? []).map(
                  (member) =>
                    plugin.activation === 'disabled'
                      ? { ...member, state: 'disabled', reason: '插件已停用' }
                      : member,
                ),
                tools: pluginTools[String(plugin.pluginId)] ?? {
                  note: null,
                  groups: [],
                },
              }
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
                // The user's choice ends a project's suggestion (SEC-07).
                if ('suggested' in plugin) plugin.suggested = false
                if (plugin.scope === 'project' && plugin.enabled)
                  plugin.effective = true
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
            // Like Core (FIX-13): no session (a draft) gets the defaults,
            // and a change needs a real session. A draft keeps plan mode
            // and the preset itself, so a call here with none is a bug.
            case 'control.get':
              return args[0]
                ? { ...boot.control }
                : {
                    ...boot.control,
                    mode:
                      boot.control.mode === 'plan'
                        ? String(boot.control.previous_mode || 'auto')
                        : boot.control.mode,
                    plan: false,
                    pending: null,
                  }
            case 'control.setPermissionMode': {
              const refused = visualSessionRefusal(args[1])
              if (refused) return refused
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
              const refused = visualSessionRefusal(args[1])
              if (refused) return refused
              const nextMode = String(args[0] || 'ask_before_edit')
              if (nextMode === 'plan') {
                boot.control.previous_mode =
                  boot.control.mode === 'plan'
                    ? boot.control.previous_mode
                    : boot.control.mode
                boot.control.mode = 'plan'
              } else {
                boot.control.mode =
                  nextMode === 'default'
                    ? String(boot.control.previous_mode || 'ask_before_edit')
                    : nextMode
                boot.control.previous_mode = null
              }
              // Like Core: `{ control }`, with the Plan flag.
              boot.control.plan = nextMode === 'plan'
              return { control: { ...boot.control } }
            }
            case 'goals.pause':
            case 'goals.resume': {
              const activeGoal = boot.goals.active as Record<
                string,
                unknown
              > | null
              if (!activeGoal) throw new Error('Goal is not active')
              const nextGoal = {
                ...activeGoal,
                phase: operationKey === 'goals.pause' ? 'paused' : 'active',
                revision: Number(activeGoal.revision ?? 0) + 1,
              }
              boot.goals.active = nextGoal as typeof boot.goals.active
              return { accepted: true, goal: nextGoal }
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
            case 'pullRequests.status':
              return { ...visualGhStatus }
            case 'pullRequests.list': {
              if (!visualGhStatus.available) return visualPrFailure()
              const input = (args[0] ?? {}) as {
                filter?: string
                query?: string
              }
              const text = (input.query ?? '').trim().toLowerCase()
              const items = visualPulls
                .filter((pr) =>
                  input.filter === 'mine'
                    ? pr.author === visualGhStatus.login
                    : input.filter === 'reviewing'
                      ? Boolean(pr.reviewing)
                      : true,
                )
                .filter(
                  (pr) =>
                    !text ||
                    `${pr.title} ${pr.repo} ${pr.head}`
                      .toLowerCase()
                      .includes(text),
                )
                .map(visualPrItem)
              return { items, total: items.length }
            }
            case 'pullRequests.view': {
              if (!visualGhStatus.available) return visualPrFailure()
              const pr = visualPrLookup(args[0])
              if (!pr) return visualPrNotFound
              const [additions, deletions] = visualPrTotals(pr)
              return {
                ...visualPrItem(pr),
                body: pr.body,
                headRefName: pr.head,
                baseRefName: 'main',
                additions,
                deletions,
                changedFiles: pr.files.length,
                files: pr.files.map(([path, add, del]) => ({
                  path,
                  additions: add,
                  deletions: del,
                })),
                commits: pr.commits,
                checks: pr.runs.map(([name, status, conclusion]) => ({
                  name,
                  status,
                  conclusion,
                })),
              }
            }
            case 'pullRequests.diff': {
              if (!visualGhStatus.available) return visualPrFailure()
              const pr = visualPrLookup(args[0])
              if (!pr) return visualPrNotFound
              return { diff: visualPrDiff(pr), truncated: false }
            }
            case 'github.listIssues': {
              const refused = visualGithubRefusal()
              if (refused) return refused
              const input = (args[0] ?? {}) as {
                filter?: string
                query?: string
              }
              const text = (input.query ?? '').trim().toLowerCase()
              const items = visualIssues
                .filter((issue) =>
                  issue.filters.includes(input.filter ?? 'involved'),
                )
                .filter(
                  (issue) =>
                    !text ||
                    `${issue.title} ${issue.repo}`.toLowerCase().includes(text),
                )
                .map(visualIssueItem)
              return { items, total: items.length }
            }
            case 'github.viewIssue': {
              const refused = visualGithubRefusal()
              if (refused) return refused
              const ref = (args[0] ?? {}) as { repo?: string; number?: number }
              const issue = visualIssues.find(
                (item) => item.repo === ref.repo && item.number === ref.number,
              )
              if (!issue)
                return {
                  ok: false,
                  error: {
                    message: `找不到 Issue ${ref.repo}#${ref.number}，或当前账户无权访问。`,
                    code: 'pull_request_not_found',
                  },
                }
              const shownComments =
                issue.comments > 2
                  ? [
                      {
                        author: 'mei-chen',
                        body: 'Reproduced on a second display. Restoring from the Dock keeps the width; restoring with ⌘⇧M does not.',
                        createdAt: visualAgo(issue.updated + 40),
                      },
                      {
                        author: 'lin-hai',
                        body: 'The saved width is read before the window has its final size. See `restoreBounds()`.',
                        createdAt: visualAgo(issue.updated),
                      },
                    ]
                  : []
              return {
                ...visualIssueItem(issue),
                body:
                  issue.number === 498
                    ? 'The preview shows `<script>` blocks as HTML.\n\n<img src=x onerror=alert(1)>\n\n- [x] Found in 2.3\n- [ ] Fixed'
                    : 'After minimizing and restoring the window, the sidebar goes back to its default width.\n\n**Steps**\n1. Drag the sidebar wider\n2. Minimize the window\n3. Restore it',
                stateReason: null,
                closedAt: null,
                assignees: issue.assignees,
                comments: shownComments,
              }
            }
            case 'github.listRuns': {
              const refused = visualGithubRefusal()
              if (refused) return refused
              const input = (args[0] ?? {}) as { repo?: string }
              const items = visualRuns
                .filter((run) => run[0] === input.repo)
                .map(visualRunItem)
              return { items, total: items.length }
            }
            case 'github.viewRun': {
              const refused = visualGithubRefusal()
              if (refused) return refused
              const ref = (args[0] ?? {}) as { repo?: string; runId?: number }
              const run = visualRuns.find(
                (item) => item[0] === ref.repo && item[1] === ref.runId,
              )
              if (!run)
                return {
                  ok: false,
                  error: {
                    message: `找不到运行记录 ${ref.runId}，或当前账户无权访问。`,
                    code: 'pull_request_not_found',
                  },
                }
              const item = visualRunItem(run)
              const failed = item.conclusion === 'failure'
              const job = (
                id: number,
                name: string,
                conclusion: string | null,
                seconds: number,
                steps: Array<[string, string | null]>,
              ) => ({
                id,
                name,
                status: conclusion === null ? 'in_progress' : 'completed',
                conclusion,
                startedAt: item.createdAt,
                completedAt:
                  conclusion === null
                    ? null
                    : new Date(
                        Date.parse(item.createdAt) + seconds * 1000,
                      ).toISOString(),
                url: `${item.url}/job/${id}`,
                steps: steps.map(([stepName, stepConclusion], index) => ({
                  number: index + 1,
                  name: stepName,
                  status: stepConclusion === null ? 'in_progress' : 'completed',
                  conclusion: stepConclusion,
                })),
              })
              return {
                run: item,
                jobs: [
                  job(run[1] * 10 + 1, 'lint', 'success', 42, [
                    ['Set up job', 'success'],
                    ['Checkout', 'success'],
                    ['npm run lint', 'success'],
                  ]),
                  job(
                    run[1] * 10 + 2,
                    'test (macos-latest)',
                    failed ? 'failure' : item.conclusion,
                    9 * 60,
                    [
                      ['Set up job', 'success'],
                      ['Checkout', 'success'],
                      ['make check', failed ? 'failure' : item.conclusion],
                      ['Upload report', failed ? 'skipped' : item.conclusion],
                    ],
                  ),
                ],
              }
            }
            case 'chat.stopRuntime': {
              // Recorded (FIX-13), and refused without a session like Core.
              const input = (args[0] ?? {}) as {
                taskId?: string | null
                sessionId?: string | null
              }
              const record = window as unknown as {
                __visualStops?: Array<Record<string, unknown>>
              }
              ;(record.__visualStops ??= []).push({ ...input })
              if (!input.taskId) {
                const refused = visualSessionRefusal(input.sessionId)
                if (refused) return refused
              }
              return { cancelled: false }
            }
            case 'computerUse.status':
              return visualComputerUse()
            case 'browser.preferences':
              return visualBrowserState.preferences
            case 'browser.setPreferences':
              visualBrowserState.preferences = {
                ...visualBrowserState.preferences,
                ...((args[0] || {}) as Record<string, unknown>),
              }
              return visualBrowserState.preferences
            case 'computerUse.listProfiles':
              return visualBrowserState.profiles
            case 'computerUse.manageProfile': {
              const input = (args[0] || {}) as {
                action?: string
                profileId?: string
                name?: string
              }
              if (input.action === 'create' && input.name)
                visualBrowserState.profiles.push({
                  profileId: `profile-${visualBrowserState.profiles.length}`,
                  name: input.name,
                  kind: 'persistent',
                  openTargets: 0,
                })
              if (input.action === 'delete')
                visualBrowserState.profiles =
                  visualBrowserState.profiles.filter(
                    (item) => item.profileId !== input.profileId,
                  )
              return {}
            }
            case 'computerUse.listSitePermissions':
              return visualBrowserState.permissions
            case 'computerUse.setSitePermission': {
              const input = (args[0] || {}) as Record<string, unknown>
              visualBrowserState.permissions = input.allow
                ? [...visualBrowserState.permissions, input]
                : visualBrowserState.permissions.filter(
                    (item) =>
                      item.origin !== input.origin || item.kind !== input.kind,
                  )
              return {}
            }
            case 'computerUse.setEnabled':
              visualComputerUseState.enabled = args[0] === true
              return visualComputerUse()
            case 'computerUse.setDriverEnabled': {
              const input = (args[0] || {}) as {
                driver?: string
                enabled?: boolean
              }
              if (input.driver)
                visualComputerUseState.drivers[input.driver] =
                  input.enabled === true
              return visualComputerUse()
            }
            case 'computerUse.acknowledgeRetiredApps':
              visualComputerUseState.retiredProtectedApps = []
              return visualComputerUse()
            case 'computerUse.setDownloadRetention': {
              const input = (args[0] || {}) as { days?: 0 | 7 | 30 | 90 }
              visualComputerUseState.downloadRetentionDays = input.days ?? 30
              return visualComputerUse()
            }
            case 'computerUse.clearScreenshots': {
              const removed = visualComputerUseState.screenshots.count
              visualComputerUseState.screenshots = { count: 0, bytes: 0 }
              return { removed, bytes: 0 }
            }
            // Chrome/Edge 智能体权限 and 浏览器权限 (RV-09).
            case 'computerUse.externalBrowserSettings':
              return visualExternalBrowser
            case 'computerUse.setExternalBrowserSettings': {
              const patch = (args[0] || {}) as Record<string, unknown>
              const sites = Array.isArray(patch.sites)
                ? (patch.sites as Array<Record<string, unknown>>).map(
                    (rule) => ({
                      ...rule,
                      pattern: String(rule.pattern).trim().toLowerCase(),
                    }),
                  )
                : visualExternalBrowser.sites
              visualExternalBrowser = {
                ...visualExternalBrowser,
                ...patch,
                defaults: {
                  ...(visualExternalBrowser.defaults as object),
                  ...((patch.defaults as object | undefined) ?? {}),
                },
                sites,
              }
              return visualExternalBrowser
            }
            case 'executors.list':
              return visualExecutorsMode ? visualExecutorList() : {}
            case 'executors.probe': {
              if (!visualExecutorsMode) return {}
              const input = (args[0] || {}) as { profileId?: string }
              return visualExecutorProbe(
                String(input.profileId),
                visualClaudeMode,
              )
            }
            case 'executors.models': {
              if (!visualExecutorsMode) return {}
              const input = (args[0] || {}) as { profileId?: string }
              if (
                visualCodexDefaultUnavailable &&
                input.profileId === 'codex-default'
              )
                return {
                  profileId: input.profileId,
                  models: [
                    {
                      id: 'gpt-6.1-sol',
                      name: 'gpt-6.1-sol',
                      source: 'configuration',
                    },
                    ...['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'].map(
                      (id) => ({ id, name: id, source: 'cli' }),
                    ),
                  ],
                  configuredModel: 'gpt-6.1-sol',
                  provider: 'openai',
                  checkedAt: Date.now(),
                  diagnostic: null,
                  defaultUnavailable: {
                    model: 'gpt-6.1-sol',
                    replacement: 'gpt-5.6-sol',
                  },
                }
              return {
                profileId: input.profileId,
                models: [],
                configuredModel: null,
                provider: 'anthropic',
                checkedAt: Date.now(),
                diagnostic: null,
              }
            }
            case 'executors.configure': {
              if (!visualExecutorsMode) return {}
              const input = (args[0] || {}) as { config?: object }
              visualExecutorConfig = {
                ...(input.config as Record<string, unknown>),
                revision: Number(visualExecutorConfig.revision) + 1,
              }
              return visualExecutorConfig
            }
            case 'executors.setCredential':
            case 'executors.clearCredential':
            case 'executors.signOut': {
              if (!visualExecutorsMode) return {}
              visualClaudeMode =
                operationKey === 'executors.setCredential'
                  ? 'api-key'
                  : 'signed-out'
              return {
                probe: visualExecutorProbe('claude-default', visualClaudeMode),
              }
            }
            case 'executors.signIn': {
              if (!visualExecutorsMode) return {}
              const input = (args[0] || {}) as {
                profileId?: string
                method?: string
              }
              // One at a time, as in Core: a second click joins the first.
              if (visualSignIn?.state !== 'running')
                visualSignIn = {
                  profileId: String(input.profileId),
                  method: input.method === 'console' ? 'console' : 'claude-ai',
                  state: 'running',
                  startedAt: Date.now(),
                }
              // A spec ends it the way Core pushes the end of claude auth
              // login: window.__visualClaudeSignIn('signed-in' | 'exit' |
              // 'timeout').
              ;(
                window as unknown as {
                  __visualClaudeSignIn?: (outcome: string) => void
                }
              ).__visualClaudeSignIn = (outcome) => {
                if (!visualSignIn) return
                const command =
                  "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR='/Users/ada/.emperor/delegations/claude-code/config' HOME='/Users/ada/.emperor/delegations/claude-code/home' XDG_CONFIG_HOME='/Users/ada/.emperor/delegations/claude-code/home/.config' XDG_CACHE_HOME='/Users/ada/.emperor/delegations/claude-code/home/.cache' '/Users/ada/.local/bin/claude' auth login" +
                  (visualSignIn.method === 'console' ? ' --console' : '')
                if (outcome === 'signed-in') visualClaudeMode = 'signed-in'
                visualSignIn = {
                  ...visualSignIn,
                  finishedAt: Date.now(),
                  ...(outcome === 'signed-in'
                    ? { state: 'signed-in' }
                    : outcome === 'timeout'
                      ? { state: 'failed', reason: 'timeout', command }
                      : {
                          state: 'failed',
                          reason: 'exit',
                          exitCode: 1,
                          command,
                        }),
                }
                const event = {
                  event: 'executor_sign_in',
                  seq: 0,
                  signIn: visualSignIn,
                  ...(outcome === 'signed-in'
                    ? {
                        probe: visualExecutorProbe(
                          String(visualSignIn.profileId),
                          visualClaudeMode,
                        ),
                      }
                    : {}),
                }
                for (const target of environmentListeners) target(event)
              }
              return { signIn: visualSignIn }
            }
            case 'executors.cancelSignIn': {
              if (!visualExecutorsMode) return {}
              if (visualSignIn?.state !== 'running') return { signIn: null }
              visualSignIn = {
                ...visualSignIn,
                state: 'cancelled',
                finishedAt: Date.now(),
              }
              return { signIn: visualSignIn }
            }
            case 'executors.dismissNotice':
              visualSignInNotice = false
              return {}
            case 'executors.versions': {
              if (!visualUpgradeMode) return {}
              // A spec moves an upgrade on the way Core pushes it.
              ;(
                window as unknown as {
                  __visualExecutorUpgrade?: (step: string) => void
                }
              ).__visualExecutorUpgrade = (step) => {
                const emit = (event: Record<string, unknown>) => {
                  for (const target of environmentListeners)
                    target({ seq: 0, ...event })
                }
                visualUpgrade.claude = '2.1.308'
                const run =
                  step === 'running'
                    ? visualCodexRun({})
                    : step === 'done'
                      ? visualCodexRun({
                          state: 'succeeded',
                          installed: '0.163.0',
                          finishedAt: Date.now(),
                        })
                      : visualFailedRun()
                if (step === 'done') visualUpgrade.codex = '0.163.0'
                visualUpgrade.upgrades = [run]
                emit({
                  event: 'executor_upgrade',
                  upgrade: run,
                  ...(step === 'done'
                    ? { probe: visualExecutorProbe('codex-default', null) }
                    : {}),
                })
                emit({ event: 'executor_upgrade', versions: visualVersions() })
              }
              return visualVersions()
            }
            case 'executors.upgrade': {
              const input = (args[0] || {}) as { profileId?: string }
              return {
                upgrade: visualCodexRun({
                  profileId: String(input.profileId),
                  state: 'waiting',
                }),
              }
            }
            case 'executors.cancelUpgrade':
              return {
                upgrade: visualCodexRun({
                  state: 'cancelled',
                  finishedAt: Date.now(),
                }),
              }
            case 'executors.dismissUpgrades':
              visualUpgrade.dismissed = true
              return visualVersions()
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
      pluginLogos: bundledPluginLogos(),
    },
  )
}
