import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  onCoreEvent: (listener: VisualCoreListener) => () => void
  invokeCore: (operationKey: string, ...args: unknown[]) => Promise<unknown>
}

declare global {
  interface Window {
    emperor?: VisualBridge
  }
}

const screenshotDir = resolve(process.cwd(), 'screenshots', 'codex-v2')
const visualProjectDir = resolve(process.cwd(), 'screenshots', 'fixtures', 'visual-build-project')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(visualProjectDir, { recursive: true })
  writeFileSync(resolve(visualProjectDir, 'README.md'), '# Visual Build Project\n', 'utf8')
})

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

const scenarios = [
  { name: 'chat-empty-desktop', path: '/chat', width: 1440, height: 900, selector: '.composer' },
  { name: 'chat-empty-mobile', path: '/chat', width: 390, height: 844, selector: '.composer' },
  { name: 'build-project-sidebar', path: '/chat', width: 1440, height: 900, selector: '.project-row' },
  { name: 'model-panel', path: '/model', width: 1024, height: 768, selector: '.view-body' },
  { name: 'tokens-panel', path: '/tokens', width: 1024, height: 768, selector: '.tokens-body' },
  { name: 'memory-context-panel', path: '/memory', width: 1024, height: 768, selector: '.memory-context-strip' },
  { name: 'scheduler-panel', path: '/scheduler', width: 1280, height: 820, selector: '.scheduler-panel' },
  { name: 'plugins-panel', path: '/plugins/skills', width: 1024, height: 768, selector: '.segmented-control' },
  { name: 'settings-panel', path: '/settings/general', width: 1024, height: 768, selector: '.settings-shell' },
  { name: 'settings-model', path: '/settings/model', width: 1024, height: 768, selector: '.model-panel-shell' },
  { name: 'settings-model-mobile', path: '/settings/model', width: 390, height: 844, selector: '.model-panel-shell' },
  { name: 'settings-hooks', path: '/settings/hooks', width: 1280, height: 820, selector: '.hooks-panel' },
  { name: 'settings-hooks-mobile', path: '/settings/hooks', width: 390, height: 844, selector: '.hooks-panel' },
  { name: 'settings-diagnostics', path: '/settings/diagnostics', width: 1280, height: 820, selector: '.diagnostics-list' },
  { name: 'settings-diagnostics-mobile', path: '/settings/diagnostics', width: 390, height: 844, selector: '.diagnostics-list' },
  { name: 'settings-appearance', path: '/settings/appearance', width: 1024, height: 768, selector: '.settings-shell' },
] as const

for (const scenario of scenarios) {
  test(`captures ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(scenario.path)
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator(scenario.selector).first()).toBeVisible()
    if (scenario.path.startsWith('/settings')) {
      await expect(page.locator('.codex-sidebar')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Team/i })).toHaveCount(0)
    }
    if (scenario.path === '/settings/model') {
      await expect(page.locator('.advanced-panel')).toBeVisible()
      await expect(page.getByText('Context Window').first()).toBeAttached()
      await expect(page.getByText('Max Tokens').first()).toBeAttached()
    }
    await expect(page.locator('body')).not.toContainText('Web UI 启动失败')
    await page.waitForTimeout(650)
    await page.screenshot({
      path: resolve(screenshotDir, `${scenario.name}.png`),
      fullPage: false,
    })
  })
}

test('model pickers select, reopen all candidates, and retain custom ids', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/model')
  await page.getByRole('button', { name: '获取模型' }).click()
  await expect(page.getByText('已获取 3 个模型')).toBeVisible()

  const main = page.getByRole('combobox', { name: 'Main Model ID' })
  await main.click()
  await expect(page.getByRole('listbox', { name: 'Main Model ID候选模型' })).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-pro/ })).toBeVisible()
  await page.getByRole('option', { name: /visual-pro/ }).click()
  await expect(main).toHaveValue('visual-pro')

  await main.click()
  await expect(page.getByRole('option', { name: /visual-main/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-secondary/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-pro/ })).toBeVisible()
  await main.press('Escape')

  const secondary = page.getByRole('combobox', { name: 'Secondary Model ID' })
  await secondary.click()
  await secondary.press('ArrowDown')
  await secondary.press('Enter')
  await expect(secondary).toHaveValue('visual-main')
  await expect(main).toHaveValue('visual-pro')

  await secondary.fill('private-model-v2')
  await secondary.press('Escape')
  await expect(secondary).toHaveValue('private-model-v2')
  await secondary.click()
  await expect(page.getByRole('option', { name: /private-model-v2.*自定义/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /visual-main/ })).toBeVisible()
})

test('settings pages keep their scroll contract without horizontal overflow', async ({ page }) => {
  const routes = ['general', 'model', 'memory', 'tokens', 'configs', 'hooks', 'diagnostics', 'appearance', 'archived']
  for (const viewport of [{ width: 1280, height: 820 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    for (const route of routes) {
      await page.goto(`/settings/${route}`)
      await expect(page.locator('.settings-shell')).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)

      const scrollResult = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('.settings-content *'))
        const scrollHost = candidates.find((element) => {
          const style = window.getComputedStyle(element)
          return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
        })
        if (!scrollHost) return { found: false, scrolled: false }
        scrollHost.scrollTop = Math.min(80, scrollHost.scrollHeight - scrollHost.clientHeight)
        return { found: true, scrolled: scrollHost.scrollTop > 0 }
      })

      if (route === 'diagnostics' || (route === 'model' && viewport.width < 980)) expect(scrollResult.found).toBe(true)
      if (scrollResult.found) expect(scrollResult.scrolled).toBe(true)
    }
  }
})

test('hooks workspace exposes effective, test, audit, and advanced views', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/settings/hooks')
  await expect(page.locator('.hooks-panel')).toBeVisible()
  await expect(page.getByText('project_trust_stale')).toBeVisible()
  await expect(page.getByText('guard-write').first()).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '信任' }).click()
  await expect(page.getByText('已信任项目 Hooks')).toBeVisible()

  await page.getByRole('tab', { name: '测试' }).click()
  await expect(page.getByText('Dry Run')).toBeVisible()
  await expect(page.locator('.test-form select')).toHaveValue('PreToolUse')
  await page.getByRole('button', { name: '匹配' }).click()
  await expect(page.getByText('无匹配 handler')).toBeVisible()

  await page.getByRole('tab', { name: '审计' }).click()
  await expect(page.getByText('audit-command')).toBeVisible()

  await page.getByRole('tab', { name: 'Advanced' }).click()
  await expect(page.getByText('Global hooks_config.json')).toBeVisible()
  const editor = page.locator('.advanced-editor textarea')
  await expect(editor).toHaveValue(/"version": 2/)
  await page.getByRole('button', { name: '校验' }).click()
  await expect(page.getByText('配置有效')).toBeVisible()
  await editor.fill(`${await editor.inputValue()}\n`)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(/stale hooks revision/)).toBeVisible()
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible()
})

test('captures sidebar search overlay', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: '搜索' }).click()
  await page.getByPlaceholder('搜索对话').fill('Visual')
  await expect(page.locator('.sidebar-search-panel')).toBeVisible()
  await page.screenshot({
    path: resolve(screenshotDir, 'sidebar-search-overlay.png'),
    fullPage: false,
  })
})

test('sidebar primary navigation buttons route to their panels', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.app-shell')).toBeVisible()

  await page.getByRole('button', { name: '插件' }).click()
  await expect(page).toHaveURL(/\/plugins\/skills$/)
  await expect(page.locator('.segmented-control')).toBeVisible()

  await page.goto('/chat')
  await page.getByRole('button', { name: '定时任务' }).click()
  await expect(page).toHaveURL(/\/scheduler$/)
  await expect(page.locator('.scheduler-panel')).toBeVisible()

  await page.goto('/chat')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(page.locator('.settings-shell')).toBeVisible()
})

test('sidebar chrome buttons have visible effects', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.project-row')).toHaveCount(2)
  await expect(page.locator('.session-row:not(.build-row)')).toHaveCount(1)

  await page.getByRole('button', { name: '侧边栏' }).click()
  await expect(page.locator('.codex-sidebar')).toHaveClass(/collapsed/)
  await page.getByRole('button', { name: '侧边栏' }).click()
  await expect(page.locator('.codex-sidebar')).not.toHaveClass(/collapsed/)

  await page.getByRole('button', { name: '项目', exact: true }).click()
  await expect(page.locator('.project-row')).toHaveCount(0)
  await page.getByRole('button', { name: '项目', exact: true }).click()
  await expect(page.locator('.project-row')).toHaveCount(2)

  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect(page.locator('.session-row:not(.build-row)')).toHaveCount(0)
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect(page.locator('.session-row:not(.build-row)')).toHaveCount(1)
})

test('captures composer mode menu on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.mode-button').click()
  await assertFloatingModeMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-mode-menu-desktop.png'),
    fullPage: false,
  })
})

test('captures composer add menu on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await assertComposerShellTrimmed(page)
  await page.locator('.attach-button').click()
  await assertComposerAddMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-add-menu-desktop.png'),
    fullPage: false,
  })
})

test('captures composer add menu on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await assertComposerShellTrimmed(page)
  await page.locator('.attach-button').click()
  await assertComposerAddMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-add-menu-mobile.png'),
    fullPage: false,
  })
})

test('captures composer mode menu on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.mode-button').click()
  await assertFloatingModeMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-mode-menu-mobile.png'),
    fullPage: false,
  })
})

test('captures composer model menu on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.model-button').click()
  await assertFloatingModelMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-model-menu-desktop.png'),
    fullPage: false,
  })
})

test('captures composer model menu on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/chat')
  await expect(page.locator('.composer')).toBeVisible()
  await page.locator('.model-button').click()
  await assertFloatingModelMenu(page)
  await page.screenshot({
    path: resolve(screenshotDir, 'composer-model-menu-mobile.png'),
    fullPage: false,
  })
})

async function installVisualCoreBridge(page: Page) {
  await page.addInitScript(({ projectDir }) => {
    const now = '2026-06-26T12:00:00.000Z'
    const project = {
      project_id: 'visual_project',
      project_path: projectDir,
      project_name: 'Visual Build Project',
      summary: 'Fixture project for renderer visual tests.',
    }
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
    const modelConfig = {
      current: {
        provider: 'visual',
        providerLabel: 'Visual Provider',
        model: 'visual-main',
        mainModelId: 'visual-main',
        secondaryModelId: 'visual-secondary',
        entryName: 'visual',
        entryLabel: 'Visual Local',
        supportsVision: true,
        contextWindowTokens: 128000,
        maxTokens: 4096,
      },
      secondary: {
        provider: 'visual',
        providerLabel: 'Visual Provider',
        model: 'visual-secondary',
        entryName: 'visual',
        entryLabel: 'Visual Local',
      },
      routing: {
        secondaryEnabled: true,
        fallbackToMain: true,
        mainEntry: 'visual',
        mainModel: 'visual-main',
        secondaryModel: 'visual-secondary',
      },
      config: {
        agents: { defaults: { provider: 'visual', model: 'visual' } },
        models: [
          {
            name: 'visual',
            label: 'Visual Local',
            provider: 'visual',
            mainModelId: 'visual-main',
            secondaryModelId: 'visual-secondary',
            contextWindowTokens: 128000,
            maxTokens: 4096,
            supportsVision: true,
          },
        ],
        providers: { visual: { apiKey: '' } },
      },
      providerOptions: [
        { name: 'visual', displayName: 'Visual Provider', backend: 'openai-compatible', region: 'local', isLocal: true, modelDiscovery: 'supported' },
      ],
    }
    const memory = {
      long_term: '偏好：保持界面紧凑，优先展示可操作状态。',
      today_episode: '今天完成 TypeScript 迁移视觉检查。',
      episodes: ['2026-06-26'],
      context: {
        mode: 'build',
        session: sessions[0],
        project,
        projectMemory: '项目记忆：视觉测试使用固定 Core bridge fixture。',
        projectIndexSummary: 'README.md: Visual Build Project',
        sources: ['MEMORY.local.md', 'project/index.json'],
      },
      history: { active_lines: 4, active_bytes: 2048, archive_files: 1, archive_bytes: 8192 },
      runtime: { events: 0, latestSeq: 1, archiveFiles: 0 },
      schedulerMaintenance: { jobs: 1, enabled: 1, nextRunAtMs: Date.now() + 3600000 },
      watchlist: {
        content: '- [ ] 检查发布产物',
        lastDecision: { action: 'skip', reason: 'visual fixture', checkedAt: Date.now() },
      },
      versions: { versions: [], count: 0 },
      tokenTotals: { input: 1200, output: 640, total: 1840, calls: 3 },
      tokensByModel: { 'visual-main': { input: 1200, output: 640, total: 1840, calls: 3 } },
      tokensByUsageType: { chat: { input: 1200, output: 640, total: 1840, calls: 3 } },
    }
    const scheduler = {
      status: { running: true, jobs: 1, enabled: 1, nextRunAtMs: Date.now() + 3600000, lastError: null },
      jobs: [
        {
          id: 'memory-maintenance',
          name: 'Memory maintenance',
          enabled: true,
          protected: true,
          schedule: { kind: 'every', everyMs: 3600000 },
          payload: { kind: 'system_event', message: 'memory-maintenance' },
          state: { nextRunAtMs: Date.now() + 3600000, lastStatus: 'ok', lastRunAtMs: Date.now() - 3600000 },
          purpose: 'Visual fixture',
        },
      ],
      diagnostics: {},
    }
    const team = {
      members: [
        { name: 'reviewer', role: 'reviewer', agent_type: 'reviewer', status: 'idle', unread: 0, tools: ['read_file'] },
      ],
      leadUnread: 0,
      leadInbox: [],
      config: { version: 1, team_name: 'Visual Team', members: [] },
    }
    const hooksPayload = {
      revision: 'visual-hooks-revision-20260710',
      config: { version: 2, enabled: true, projectHooks: { enabled: true }, hooks: {} },
      globalConfig: {
        version: 2,
        enabled: true,
        projectHooks: { enabled: true },
        hooks: {
          PreToolUse: [{
            id: 'guard-write', enabled: true, matcher: 'write_file', if: '', failureMode: 'closed',
            handlers: [{ id: 'guard-command', type: 'command', enabled: true, command: 'node', args: ['guard.mjs'], timeoutMs: 10000 }],
          }],
        },
      },
      effectiveGroups: [
        {
          eventName: 'PreToolUse',
          group: {
            id: 'guard-write', enabled: true, matcher: 'write_file', if: '', failureMode: 'closed',
            handlers: [{ id: 'guard-command', type: 'command', enabled: true, command: 'node', args: ['guard.mjs'], timeoutMs: 10000 }],
          },
          source: { id: 'global', kind: 'global', path: '/Users/visual/.emperor-agent/hooks_config.json', readonly: false, active: true },
        },
        {
          eventName: 'Stop',
          group: {
            id: 'project-finish', enabled: true, matcher: '*', if: '', failureMode: 'open',
            handlers: [{ id: 'finish-prompt', type: 'prompt', enabled: true, prompt: 'Check completion.', timeoutMs: 30000 }],
          },
          source: { id: 'project', kind: 'project', path: `${projectDir}/.emperor/settings.json`, readonly: true, active: false, blockedReason: 'project_trust_stale' },
        },
      ],
      sources: [
        { id: 'global', kind: 'global', path: '/Users/visual/.emperor-agent/hooks_config.json', readonly: false, active: true },
        { id: 'project', kind: 'project', path: `${projectDir}/.emperor/settings.json`, readonly: true, active: false, blockedReason: 'project_trust_stale' },
      ],
      projectTrust: { canonicalRoot: projectDir, digest: 'visual-digest', status: 'stale' },
      diagnostics: [{ code: 'candidate_rejected', path: `${projectDir}/.emperor/settings.json`, message: 'Project hook digest changed.' }],
      summary: { total: 2, groups: 2, events: [{ eventName: 'PreToolUse', groups: 1, count: 1 }, { eventName: 'Stop', groups: 1, count: 1 }] },
    }
    const hooksMetadata = {
      version: 2,
      events: [
        { eventName: 'PreToolUse', matcherField: 'tool_name', mode: 'transform', allowedHandlers: ['command', 'http', 'prompt'] },
        { eventName: 'Stop', matcherField: null, mode: 'continue', allowedHandlers: ['command', 'http', 'prompt', 'agent'] },
        { eventName: 'ConfigChange', matcherField: 'source', mode: 'block', allowedHandlers: ['command', 'http'] },
      ],
      handlers: { command: {}, http: {}, prompt: {}, agent: {} },
    }
    const hooksAudit = {
      cursor: '0', nextCursor: null, total: 1, badLines: [],
      records: [{
        hookRunId: 'hook_run_visual', eventName: 'PreToolUse', groupId: 'guard-write', handlerId: 'audit-command', handlerType: 'command',
        source: { id: 'global', kind: 'global' }, snapshotRevision: hooksPayload.revision, startedAt: now,
        durationMs: 18, status: 'completed', outcome: 'deny', reason: 'visual fixture', inputHash: 'input-hash', outputHash: 'output-hash',
      }],
    }
    const boot = {
      app: 'Emperor Agent',
      model: 'visual-main',
      provider: 'visual',
      providerLabel: 'Visual Provider',
      tools: [
        { name: 'read_file', description: 'Read a file', read_only: true, source: 'builtin' },
        { name: 'run_command', description: 'Run a command', read_only: false, source: 'builtin' },
      ],
      skills: [{ name: 'visual-fixture', description: 'Fixture skill', path: 'skills/visual-fixture/SKILL.md' }],
      memory,
      modelConfig,
      scheduler,
      team,
      control: { mode: 'ask_before_edit', pending: null },
      desktopPet: { enabled: false, autoStartWithWebui: false, running: false, installCommand: 'npm install' },
      diagnostics: {
        root: projectDir,
        modelConfig: { status: 'ok', exists: true, models: 1 },
        localConfig: { status: 'ok', exists: true },
        scheduler: { jobsFile: 'memory/scheduler/jobs.json' },
        runtime: { events: 0, latestSeq: 1 },
        desktopPet: { enabled: false, running: false, autoStartWithWebui: false, installCommand: 'npm install' },
        dependencies: { nodeRuntime: true, desktopRenderer: true },
      },
      projects: [project],
      runtime: { latestSeq: 1, scope: 'unarchived', events: [] },
      unarchivedHistory: [],
      context_used: 12000,
    }

    function session(id: string, title: string, mode: VisualSessionMode, projectInfo?: VisualProjectInfo) {
      return {
        id,
        title,
        created_at: now,
        updated_at: now,
        preview: mode === 'build' ? 'Visual build session' : 'Visual chat session',
        mode,
        project_id: projectInfo?.project_id ?? null,
        project_path: projectInfo?.project_path ?? null,
        project_name: projectInfo?.project_name ?? null,
        message_count: 2,
        title_status: 'ready',
        archived_at: null,
        version: 1,
      }
    }

    window.emperor = {
      version: '0.1.0-visual',
      platform: 'visual',
      selectDirectory: async () => projectDir,
      onCoreEvent: (listener: VisualCoreListener) => {
        queueMicrotask(() => listener({ event: 'ready', seq: 1, latest_seq: 1, model: 'visual-main', provider: 'visual', control: boot.control }))
        return () => {}
      },
      invokeCore: async (operationKey: string, ...args: unknown[]) => {
        switch (operationKey) {
          case 'bootstrap':
            return boot
          case 'sessions.list':
            return sessions
          case 'sessions.activate':
            return { active: args[0], complete: true }
          case 'sessions.create': {
            const body = (args[0] ?? {}) as {
              title?: string
              mode?: VisualSessionMode
              project?: VisualProjectInfo
            }
            const created = session(`created-${sessions.length}`, body.title || '新会话', body.mode || 'chat', body.project)
            sessions.unshift(created)
            return created
          }
          case 'projects.resolve':
            return project
          case 'projects.list':
            return [project]
          case 'memory.get':
            return memory
          case 'memory.tokens':
            return {
              totals: { input: 1200, output: 640, total: 1840, calls: 3 },
              byDate: {},
              byModel: { 'visual-main': { input: 1200, output: 640, total: 1840, calls: 3 } },
              byUsageType: { chat: { input: 1200, output: 640, total: 1840, calls: 3 } },
              byDateModel: {},
              byHour: {},
              streak: { active_days: 1, current_streak: 1, longest_streak: 1 },
              sessions: sessions.length,
              messages: 8,
              generatedAt: now,
            }
          case 'model.getConfig':
            return modelConfig
          case 'model.discoverModels':
            return {
              ok: true,
              provider: 'visual',
              source: 'visual-fixture',
              models: [
                { id: 'visual-main', ownedBy: 'Visual Labs' },
                { id: 'visual-secondary', ownedBy: 'Visual Labs' },
                { id: 'visual-pro', ownedBy: 'Visual Research' },
              ],
            }
          case 'config.get':
            return { path: 'emperor.local.json', content: '{\\n  "webui": {}\\n}\\n' }
          case 'mcp.getConfig':
            return { servers: {} }
          case 'scheduler.get':
            return scheduler
          case 'team.get':
            return team
          case 'team.getMember':
            return { member: team.members[0], inbox: [], leadInbox: [], thread: [] }
          case 'sidebar.get':
            return {
              section_order: ['projects', 'chats'],
              project_sort: 'updated_at',
              chat_sort: 'updated_at',
              project_order: [],
              chat_order: [],
              project_session_order: {},
              collapsed_project_ids: [],
            }
          case 'desktopPet.get':
            return boot.desktopPet
          case 'diagnostics.get':
            return boot.diagnostics
          case 'skills.list':
            return boot.skills
          case 'skills.tools':
            return boot.tools
          case 'control.get':
            return boot.control
          case 'control.setMode':
            boot.control = { mode: String(args[0] || 'ask_before_edit'), pending: null }
            return boot.control
          case 'hooks.getConfig':
            return hooksPayload
          case 'hooks.getMetadata':
            return hooksMetadata
          case 'hooks.getAudit':
            return hooksAudit
          case 'hooks.testMatch':
            return { revision: hooksPayload.revision, eventName: 'PreToolUse', items: [], diagnostics: [] }
          case 'hooks.validateConfig':
            return { valid: true, config: (args[0] as { config?: unknown } | undefined)?.config, diagnostics: [] }
          case 'hooks.setProjectTrust': {
            const body = (args[0] as { trusted?: boolean } | undefined) ?? {}
            hooksPayload.projectTrust.status = body.trusted ? 'trusted' : 'untrusted'
            hooksPayload.sources[1].active = Boolean(body.trusted)
            hooksPayload.sources[1].blockedReason = body.trusted ? undefined : 'project_untrusted'
            hooksPayload.effectiveGroups[1].source.active = Boolean(body.trusted)
            hooksPayload.effectiveGroups[1].source.blockedReason = body.trusted ? undefined : 'project_untrusted'
            return hooksPayload.projectTrust
          }
          case 'hooks.saveConfig':
            return {
              ok: false,
              error: {
                message: `stale hooks revision: expected ${(args[0] as { revision?: string } | undefined)?.revision}, current visual-new-revision`,
              },
            }
          case 'chat.stopRuntime':
            return { cancelled: false }
          default:
            return {}
        }
      },
    }
  }, { projectDir: visualProjectDir })
}

async function assertComposerShellTrimmed(page: Page) {
  await expect(page.locator('.slash-hint-button')).toHaveCount(0)

  const actionRowBorderTop = await page.locator('.composer-action-row').evaluate((el) =>
    window.getComputedStyle(el).borderTopWidth,
  )
  expect(actionRowBorderTop).toBe('0px')

  const contextRing = page.locator('.context-ring')
  if (await contextRing.count()) {
    const box = await contextRing.first().boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(19)
      expect(box.width).toBeLessThanOrEqual(21)
      expect(box.height).toBeGreaterThanOrEqual(19)
      expect(box.height).toBeLessThanOrEqual(21)
    }
    await expect(contextRing.locator('.ring-arc')).toHaveAttribute('stroke', 'currentColor')
  }

  const modelButton = page.locator('.model-button')
  if (await modelButton.count()) {
    await expect(modelButton.locator('.model-button-label')).toBeVisible()
    await expect(modelButton.locator('.model-button-meta')).toHaveCount(1)
    const viewport = page.viewportSize()
    if ((viewport?.width || 0) > 820) {
      await expect(modelButton.locator('.model-button-meta').first()).toBeVisible()
      await expect(modelButton).toContainText('·')
      await expect(modelButton).not.toContainText(/\b\d+k\b|1M|输出上限/)
    }
    if (await contextRing.count()) {
      const contextBox = await contextRing.first().boundingBox()
      const modelBox = await modelButton.first().boundingBox()
      expect(contextBox).not.toBeNull()
      expect(modelBox).not.toBeNull()
      if (contextBox && modelBox) {
        expect(contextBox.x).toBeLessThan(modelBox.x)
      }
    }
  }
}

async function assertFloatingModeMenu(page: Page) {
  const menu = page.locator('.mode-menu')
  await expect(menu).toBeVisible()
  await expect(page.locator('.mode-option')).toHaveCount(4)
  for (const label of ['询问确认', '接受编辑', '自动执行', '计划预览']) {
    await expect(menu.getByText(label, { exact: true })).toBeVisible()
  }

  const position = await menu.evaluate((el) => window.getComputedStyle(el).position)
  expect(position).toBe('fixed')

  const menuBox = await menu.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!menuBox || !viewport) return

  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.y).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height - 8)

  const hit = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.mode-menu')),
    {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height / 2,
    },
  )
  expect(hit).toBeTruthy()
}

async function assertFloatingModelMenu(page: Page) {
  const menu = page.locator('.model-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.model-menu-head')).toContainText('模型与思考')
  await expect(menu).not.toContainText('上下文窗口')
  await expect(menu).not.toContainText('输出上限')
  await expect(menu).not.toContainText(/\b\d+k\b|1M/)
  await expect(menu.locator('.reasoning-control')).toBeVisible()
  await expect(menu.locator('.reasoning-choice')).toHaveCount(5)
  await expect(menu.locator('.model-option').first()).toBeVisible()
  await expect(menu.locator('.model-option').first().locator('.model-option-meta')).toBeVisible()

  const position = await menu.evaluate((el) => window.getComputedStyle(el).position)
  expect(position).toBe('fixed')

  const menuBox = await menu.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!menuBox || !viewport) return

  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.y).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height - 8)

  const hit = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.model-menu')),
    {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height / 2,
    },
  )
  expect(hit).toBeTruthy()
}

async function assertComposerAddMenu(page: Page) {
  const menu = page.locator('.composer-palette')
  const composer = page.locator('.composer')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.composer-palette-item').first()).toContainText('文件与图片')
  await expect(menu.locator('.composer-palette-item-icon').first()).toBeVisible()

  const menuBox = await menu.boundingBox()
  const composerBox = await composer.boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(composerBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!menuBox || !composerBox || !viewport) return

  expect(menuBox.x).toBeGreaterThanOrEqual(8)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(Math.abs(menuBox.width - composerBox.width)).toBeLessThanOrEqual(24)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(composerBox.y - 6)
}
