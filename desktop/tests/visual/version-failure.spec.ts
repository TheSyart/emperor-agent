import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import {
  VERSION_FAILURE_FIXTURE,
  versionFailureScenario,
} from '../../src/renderer/src/components/conversation/gallery/scenarios'
import {
  BASELINE_NOW,
  BASELINE_TAG,
  expect,
  expectBaseline,
  test,
} from './baseline'
import { installVisualCoreBridge, type VisualSessionLog } from './visualBridge'

// VER-06 (preview § 8): a Claude Code task that failed because 2.1.315 is
// incompatible. In the conversation its row says why and the last good
// version, with 退回 2.1.310 and 打开设置; the subagent's own page shows the
// same as a banner. Baselines conversation/version-failure-card and
// conversation/version-failure-banner; screenshots in
// screenshots/version-failure/.
const screenshotDir = resolve(process.cwd(), 'screenshots', 'version-failure')

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true })
})

function logs(now: number): VisualSessionLog[] {
  const [session] = versionFailureScenario(now).sessions
  return [
    {
      id: 'build-ui',
      header: { version: 0, id: 'build-ui', createdAt: now },
      events: [...session!.events] as VisualSessionLog['events'],
    },
  ]
}

const DELEGATION = {
  state: {
    record: {
      id: 'dlg-readme',
      backend: 'claude-code',
      profileId: 'claude-default',
      owner: { rootSessionId: 'build-ui', parentAgentId: 'build-ui' },
      currentRunId: 'run-dlg-readme',
      startSpec: { description: '读一下 README 总结三点' },
      createdAt: BASELINE_NOW - 30_000,
    },
    runs: {
      'run-dlg-readme': {
        id: 'run-dlg-readme',
        phase: 'failed',
        failureCode: 'EXECUTOR_SELF_CHECK_FAILED',
        startedAt: BASELINE_NOW - 30_000,
        finishedAt: BASELINE_NOW - 28_000,
        versionFailure: VERSION_FAILURE_FIXTURE,
      },
    },
    messages: {},
    interactions: {},
    outbox: {},
    lastSeq: 2,
  },
  history: {
    entries: [],
    before: null,
    after: null,
    hasBefore: false,
    hasAfter: false,
  },
}

async function open(page: Page, path: string, theme: 'dark' | 'light') {
  await installVisualCoreBridge(page, {
    sessionLogs: logs(BASELINE_NOW),
    delegations: { 'dlg-readme': DELEGATION },
  })
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(`${path}?visualTheme=${theme}`)
  await expect(page.locator('.app-frame')).toBeVisible()
}

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  await page.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    animations: 'disabled',
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(
    `the failure card: why, the last good version, 退回 and 打开设置 (${theme})`,
    { tag: BASELINE_TAG },
    async ({ page }) => {
      await open(page, '/chat/build-ui', theme)
      const row = page.locator(
        '[data-subagent-row][data-agent-id="dlg-readme"]',
      )
      await expect(row).toBeVisible()
      await expect(row.locator('[data-agent-status]')).toContainText('失败')
      await expect(row.locator('[data-version-failure-reason]')).toHaveText(
        'Claude Code 2.1.315 自检不兼容：加载了 MCP server「x」，子智能体不允许使用 MCP。上次正常的版本：2.1.310。',
      )
      await expect(row.locator('[data-version-failure] button')).toHaveText([
        '退回 2.1.310',
        '打开设置',
      ])
      await shot(page, `card-${theme}`)
      await expectBaseline(
        page,
        'conversation',
        `version-failure-card-${theme}`,
      )
      // 打开设置 goes to Claude Code's page in 设置 › 子智能体.
      await row.locator('[data-version-failure-action="open_settings"]').click()
      await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
      await expect(
        page.locator('[data-executor-detail="claude-code"]'),
      ).toBeVisible()
    },
  )

  test(
    `the subagent page's banner (${theme})`,
    { tag: BASELINE_TAG },
    async ({ page }) => {
      await open(page, '/chat/build-ui/agents/dlg-readme', theme)
      const banner = page.locator('[data-version-failure-banner]')
      await expect(banner).toBeVisible()
      await expect(banner.locator('[data-version-failure-reason]')).toHaveText(
        'Claude Code 2.1.315 自检不兼容：加载了 MCP server「x」，子智能体不允许使用 MCP。上次正常的版本：2.1.310。',
      )
      await expect(banner.locator('button')).toHaveText([
        '退回 2.1.310',
        '打开设置',
      ])
      await shot(page, `banner-${theme}`)
      await expectBaseline(
        page,
        'conversation',
        `version-failure-banner-${theme}`,
      )
    },
  )
}
