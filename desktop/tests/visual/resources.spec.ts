import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ShowcaseLog } from '../../src/renderer/src/components/conversation/gallery/showcaseLog'
import { installVisualCoreBridge, type VisualSessionLog } from './visualBridge'
const shots = resolve(process.cwd(), 'screenshots', 'resources')
const now = Date.parse('2026-10-15T12:00:00Z')
function log(): VisualSessionLog {
  const log = new ShowcaseLog(now)
  log.user('用 @github 查看这个项目：https://github.com/TheSyart/emperor-agent')
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [{ text: '先查看网页与项目文档。' }],
    [
      {
        id: 'res-search',
        name: 'web_search',
        args: { queries: ['Emperor 使用说明'] },
        result: 'Search results',
        extra: {
          meta: {
            sources: [
              {
                url: 'https://docs.example.com/guide',
                title: '网页指南',
                snippet: '安装与使用方式。',
              },
              {
                url: 'https://github.com/TheSyart/emperor-agent',
                title: 'Emperor 仓库',
              },
            ],
          },
        },
      },
      {
        id: 'res-write',
        name: 'write',
        args: { file_path: 'docs/发布说明.md', content: '# 发布说明' },
        result: 'Created docs/发布说明.md',
        extra: { meta: { path: 'docs/发布说明.md', operation: 'create' } },
      },
    ],
  )
  log.stepStart(1, 2)
  log.stream(1, 2, [
    {
      text: '说明整理好了。参考 [网页指南](https://docs.example.com/guide)，对应 [PR #42](https://github.com/TheSyart/emperor-agent/pull/42)。\n\nhttps://github.com/TheSyart/emperor-agent\n\n[发布说明](docs/发布说明.md)\n\n文件类型：[config.yaml](config.yaml)、[app.ts](src/app.ts)、[数据.json](data.json)、[不存在的文件](docs/gone.md)。\n\n[离线示例](https://offline.example.com)',
    },
  ])
  log.stepEnd(1, 2)
  log.turnEnd(1)
  return {
    id: 'build-ui',
    header: { version: 0, id: 'build-ui', createdAt: now },
    events: log.events as unknown as VisualSessionLog['events'],
  }
}
// Site icons are on by default and asked of the icon service by hostname
// (BUG-01); the case that turns them off sets the preference itself.
test.beforeEach(async ({ page }, info) => {
  if (!info.title.includes('turned off')) return
  await page.addInitScript(() => {
    localStorage.setItem(
      'emperor.ui.prefs.v1',
      JSON.stringify({ siteIconService: false }),
    )
  })
})

test.beforeAll(() => mkdirSync(shots, { recursive: true }))
for (const theme of ['dark', 'light'] as const) {
  for (const width of [1700, 780]) {
    test(`website links have readable icon spacing (${theme}, ${width})`, async ({
      page,
    }) => {
      const records = new ShowcaseLog(now)
      records.user('整理这些 AI 网站，名称和来源清楚显示。')
      records.turnStart(1)
      records.stepStart(1, 1)
      records.stream(1, 1, [
        {
          text: '## 平台与工具\n\n开发时可以参考这些网站：[Hugging Face](https://huggingface.co)、[ModelScope](https://modelscope.cn)、[OpenRouter](https://openrouter.ai)、[Replicate](https://replicate.com)。\n\n也可以配合 [n8n](https://n8n.io) 与 [LangChain](https://www.langchain.com) 编排工作流。\n\n网站图标与完整名称保持清楚的距离，正文读起来更加舒展。\n\n较长网址也完整显示：https://docs.example.com/resources/a-very-long-reference-name-a-very-long-reference-name-a-very-long-reference-name-a-very-long-reference-name-a-very-long-reference-name',
        },
      ])
      records.stepEnd(1, 1)
      records.turnEnd(1)
      await installVisualCoreBridge(page, {
        sessionLogs: [
          {
            id: 'build-ui',
            header: { version: 0, id: 'build-ui', createdAt: now },
            events: records.events as unknown as VisualSessionLog['events'],
          },
        ],
      })
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/chat/build-ui?visualTheme=${theme}`)
      const link = page.locator(
        '.assistant-step a.md-link-chip[href="https://huggingface.co"]',
      )
      await expect(link.locator('img.site-icon')).toBeVisible()
      const geometry = await link.evaluate((anchor) => {
        const image = anchor.querySelector('img')!
        const text = [...anchor.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE,
        )!
        const range = document.createRange()
        range.selectNodeContents(text)
        const label = range.getClientRects()[0]!
        const icon = image.getBoundingClientRect()
        const style = getComputedStyle(anchor)
        return {
          gap: label.left - icon.right,
          icon: icon.width,
          background: style.backgroundColor,
          outside: parseFloat(style.marginLeft) + parseFloat(style.marginRight),
        }
      })
      expect(geometry.gap).toBeGreaterThanOrEqual(5.9)
      expect(geometry.gap).toBeLessThanOrEqual(10)
      // UI-S03: the source icon in front of a link is 12px.
      expect(geometry.icon).toBe(12)
      expect(geometry.background).toBe('rgba(0, 0, 0, 0)')
      expect(geometry.outside).toBeGreaterThanOrEqual(7.9)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(0)
      await page.screenshot({
        path: resolve(shots, `website-spacing-${theme}-${width}.png`),
      })
    })
  }
}
test('site icons turned off request nothing', async ({ page }) => {
  const records = new ShowcaseLog(now)
  records.user('看看这些网站。')
  records.turnStart(1)
  records.stepStart(1, 1)
  records.stream(1, 1, [
    {
      text: '[文档](https://docs.example.com/a) 和 [博客](https://blog.example.org/b)',
    },
  ])
  records.stepEnd(1, 1)
  records.turnEnd(1)
  await installVisualCoreBridge(page, {
    sessionLogs: [
      {
        id: 'build-ui',
        header: { version: 0, id: 'build-ui', createdAt: now },
        events: records.events as unknown as VisualSessionLog['events'],
      },
    ],
  })
  await page.goto('/chat/build-ui')
  await expect(page.locator('.assistant-step a.md-link-chip')).toHaveCount(2)
  await page.waitForTimeout(500)
  const iconCalls = await page.evaluate(
    () =>
      (
        (
          window as unknown as {
            __visualResourceOps?: Array<{ operation: string }>
          }
        ).__visualResourceOps ?? []
      ).filter((op) => op.operation === 'references.siteIcon').length,
  )
  expect(iconCalls).toBe(0)
  await expect(
    page.locator('.assistant-step a.md-link-chip img.site-icon'),
  ).toHaveCount(0)
})

test('a hundred links render without starting metadata requests', async ({
  page,
}) => {
  const records = new ShowcaseLog(now)
  records.user('整理这些来源。')
  records.turnStart(1)
  records.stepStart(1, 1)
  records.stream(1, 1, [
    {
      text: Array.from(
        { length: 100 },
        (_, i) => `[来源 ${i}](https://docs.example.com/page-${i})`,
      ).join('、'),
    },
  ])
  records.stepEnd(1, 1)
  records.turnEnd(1)
  await installVisualCoreBridge(page, {
    sessionLogs: [
      {
        id: 'build-ui',
        header: { version: 0, id: 'build-ui', createdAt: now },
        events: records.events as unknown as VisualSessionLog['events'],
      },
    ],
  })
  await page.setViewportSize({ width: 1600, height: 1050 })
  await page.goto('/chat/build-ui')
  await expect(page.locator('.assistant-step a.md-link-chip')).toHaveCount(100)
  const previews = await page.evaluate(() =>
    (
      (
        window as unknown as {
          __visualResourceOps?: Array<{ operation: string }>
        }
      ).__visualResourceOps ?? []
    ).filter((op) => op.operation === 'references.preview'),
  )
  expect(previews).toEqual([])
  await expect(
    page.locator('.assistant-step a.md-link-chip img.site-icon').first(),
  ).toBeVisible()
  const iconCalls = await page.evaluate(
    () =>
      (
        (
          window as unknown as {
            __visualResourceOps?: Array<{ operation: string }>
          }
        ).__visualResourceOps ?? []
      ).filter((op) => op.operation === 'references.siteIcon').length,
  )
  expect(iconCalls).toBe(1)
  await expect(
    page.locator('.environment-card [data-section="sources"] .sources-head'),
  ).toContainText('来源')
})
for (const theme of ['dark', 'light'] as const) {
  test(`resources: real components and lazy details (${theme})`, async ({
    page,
  }) => {
    await installVisualCoreBridge(page, { sessionLogs: [log()] })
    await page.setViewportSize({ width: 1600, height: 1050 })
    await page.goto(`/chat/build-ui?visualTheme=${theme}`)
    const sidebar = page.locator('.environment-card')
    // UI-S05: the 子智能体 row stacks three faces.
    const portraits = sidebar.locator('[data-row="agents"] [data-avatar]')
    await expect(portraits).toHaveCount(3)
    const characters = await portraits.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-avatar')),
    )
    expect(new Set(characters).size).toBeGreaterThan(1)
    await expect(
      page.locator('.md-link-detail, .resource-inline button'),
    ).toHaveCount(0)
    // UI-S13: no 输出 row (a turn's files are in its files card); 来源 is
    // a section of its own.
    await expect(sidebar.locator('[data-row="outputs"]')).toHaveCount(0)
    await expect(sidebar.locator('[data-section="sources"]')).toBeVisible()
    await expect(
      page.locator('.resource-card[data-resource-kind="github"]').first(),
    ).toBeVisible()
    await expect(page.locator('a[data-md-custom-icon="yaml"]')).toBeVisible()
    const previews = () =>
      page.evaluate(
        () =>
          (
            (
              window as unknown as {
                __visualResourceOps?: Array<{ operation: string }>
              }
            ).__visualResourceOps ?? []
          ).filter((op) => op.operation === 'references.preview').length,
      )
    expect(await previews()).toBe(0)
    await page.screenshot({
      path: resolve(shots, `conversation-${theme}.png`),
      animations: 'disabled',
    })
    const details = page
      .locator(
        '.resource-card[data-resource-kind="github"] [data-resource-detail]',
      )
      .first()
    await details.click()
    await expect(page.locator('[data-resource-dialog] h2')).toHaveText(
      'Emperor GitHub 资源',
    )
    expect(await previews()).toBe(1)
    await page.screenshot({
      path: resolve(shots, `detail-${theme}.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-resource-dialog]')).toHaveCount(0)
    await expect(details).toBeFocused()
    await page
      .getByRole('button', { name: '查看详情：离线示例', exact: true })
      .click()
    await expect(page.locator('[data-resource-dialog]')).toContainText(
      '当前无法联网补充详情',
    )
    await expect(
      page.getByRole('button', { name: '打开', exact: true }),
    ).toBeEnabled()
    await page.keyboard.press('Escape')
    const editor = page.getByLabel('消息输入框')
    await editor.fill('看看 https://github.com/a/b 和中文')
    await expect(editor.locator('.composer-url-decoration')).toHaveText(
      'https://github.com/a/b',
    )
    await page.setViewportSize({ width: 780, height: 900 })
    await page.screenshot({
      path: resolve(shots, `narrow-${theme}.png`),
      animations: 'disabled',
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(0)
  })
}

test('long resource names wrap completely in cards and the 来源 view', async ({
  page,
}) => {
  const title =
    '浏览器扩展与本机连接的完整实现说明，包含目标生命周期、凭据代填、权限检查以及应用重启后的恢复流程'
  const records = new ShowcaseLog(now)
  records.user('请把这份长名称的文档完整显示。')
  records.turnStart(1)
  records.stepStart(1, 1)
  records.stream(1, 1, [
    {
      text: [
        `[${title}](https://docs.example.com/a-very-long-resource-name-without-ellipsis?view=full#details)`,
        '[一](https://one.example.com)、[二](https://two.example.com)、[三](https://three.example.com)',
      ].join('\n\n'),
    },
  ])
  records.stepEnd(1, 1)
  records.turnEnd(1)
  await installVisualCoreBridge(page, {
    sessionLogs: [
      {
        id: 'build-ui',
        header: { version: 0, id: 'build-ui', createdAt: now },
        events: records.events as unknown as VisualSessionLog['events'],
      },
    ],
  })
  await page.setViewportSize({ width: 1600, height: 1050 })
  await page.goto('/chat/build-ui')
  const label = page.locator('.resource-card .resource-title')
  await expect(label).toHaveText(title)
  // UI-S13: a card row is one line (the full name on hover); the 来源 view
  // shows every name in full.
  const row = page
    .locator('.environment-card [data-source-item]')
    .filter({ hasText: title.slice(0, 8) })
  await expect(row).toHaveAttribute('title', title)
  await page.locator('.environment-card [data-row="sources-all"]').click()
  const source = page
    .locator('[data-sources-view] [data-source-entry] .title')
    .filter({ hasText: title.slice(0, 8) })
  await expect(source).toHaveText(title)
  for (const locator of [label, source]) {
    const style = await locator.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        clamp: style.webkitLineClamp,
        overflow: style.textOverflow,
        nowrap: style.whiteSpace,
      }
    })
    expect(style.clamp).toBe('none')
    expect(style.overflow).not.toBe('ellipsis')
    expect(style.nowrap).not.toBe('nowrap')
  }
  await page.setViewportSize({ width: 780, height: 900 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0)
})
