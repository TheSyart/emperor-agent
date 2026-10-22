import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'

const shots = resolve(process.cwd(), 'screenshots', 'file-lightbox')
test.beforeAll(() => mkdirSync(shots, { recursive: true }))
for (const theme of ['dark', 'light'] as const) {
  for (const width of [1440, 560]) {
    test(`image lightbox: layout, keyboard, zoom, drag and rotation (${theme}, ${width})`, async ({
      page,
    }) => {
      await installVisualCoreBridge(page)
      await page.setViewportSize({ width, height: 960 })
      await page.goto(`/chat/build-ui?visualTheme=${theme}`)
      await expect(page.locator('.app-frame')).toBeVisible()
      await page.evaluate(async () => {
        const modulePath = '/src/components/ui/imageViewer.ts'
        const { openImageViewer } = await import(modulePath)
        const canvas = document.createElement('canvas')
        canvas.width = 1600
        canvas.height = 1100
        const ctx = canvas.getContext('2d')!
        const gradient = ctx.createLinearGradient(0, 0, 1600, 1100)
        gradient.addColorStop(0, '#ded9c7')
        gradient.addColorStop(1, '#6f8b83')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 1600, 1100)
        ctx.fillStyle = '#f4f0e8'
        ctx.beginPath()
        ctx.arc(1180, 280, 140, 0, Math.PI * 2)
        ctx.fill()
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = ['#69837b', '#3c5d57', '#213f3a'][i]!
          ctx.beginPath()
          ctx.moveTo(0, 600 + i * 150)
          ctx.bezierCurveTo(
            500,
            250 + i * 200,
            700,
            1000 - i * 100,
            1600,
            480 + i * 200,
          )
          ctx.lineTo(1600, 1100)
          ctx.lineTo(0, 1100)
          ctx.fill()
        }
        const landscape = canvas.toDataURL('image/png')
        canvas.width = 500
        canvas.height = 1500
        ctx.fillStyle = '#f4f0e8'
        ctx.fillRect(0, 0, 500, 1500)
        ctx.fillStyle = '#c8a35d'
        for (let i = 0; i < 8; i++) ctx.fillRect(40, 40 + i * 180, 420, 100)
        openImageViewer({
          owner: 'build-ui',
          items: [
            {
              id: 'landscape',
              name: '山间日落 · 完整图片文件名.png',
              src: landscape,
            },
            {
              id: 'portrait',
              name: '竖版长截图.png',
              src: canvas.toDataURL('image/png'),
            },
          ],
        })
      })
      const viewer = page.locator('.image-lightbox')
      await expect(viewer).toBeVisible()
      await expect(viewer.locator('.viewer-image')).toBeVisible()
      await expect(viewer.locator('.viewer-status')).toHaveCount(0)
      // Invalid CSS can silently remove the safe inset without failing a
      // build: keep the title, close control and toolbar clear of the edges.
      const insets = await viewer.evaluate((element) => {
        const header = getComputedStyle(
          element.querySelector('.viewer-header')!,
        )
        const footer = getComputedStyle(
          element.querySelector('.viewer-footer')!,
        )
        return [
          header.paddingTop,
          header.paddingLeft,
          footer.paddingBottom,
        ].map(Number.parseFloat)
      })
      for (const inset of insets) expect(inset).toBeGreaterThanOrEqual(12)
      await page.screenshot({
        path: resolve(shots, `viewer-${theme}-${width}.png`),
        animations: 'disabled',
      })
      const before = await viewer.locator('.viewer-scale').innerText()
      await viewer.getByRole('button', { name: '放大', exact: true }).click()
      await expect(viewer.locator('.viewer-scale')).not.toHaveText(before)
      await viewer
        .getByRole('button', { name: '向右旋转', exact: true })
        .click()
      await expect(viewer.locator('.viewer-image')).toHaveAttribute(
        'style',
        /rotate\(90deg\)/,
      )
      await viewer
        .getByRole('button', { name: '原始大小', exact: true })
        .click()
      const image = viewer.locator('.viewer-image')
      const bounds = await image.boundingBox()
      if (bounds) {
        await page.mouse.move(width / 2, 450)
        await page.mouse.down()
        await page.mouse.move(width / 2 + 80, 470)
        await page.mouse.up()
        await expect(viewer).toBeVisible()
      }
      await viewer.getByRole('button', { name: '下一张', exact: true }).click()
      await expect(viewer.locator('.viewer-title')).toContainText(
        '竖版长截图.png',
      )
      await expect(viewer.locator('.viewer-status')).toHaveCount(0)
      await expect(viewer.locator('.viewer-counter')).toHaveText('2 / 2')
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
      await page.keyboard.press('Tab')
      expect(
        await viewer.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true)
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      expect(
        await page
          .locator('#app')
          .evaluate((element) => (element as HTMLElement).inert),
      ).toBe(false)
    })
  }
}

test('child session files and images follow the viewed owner without activating the parent', async ({
  page,
}) => {
  await installVisualCoreBridge(page)
  await page.goto('/chat/showcase-child?visualTheme=dark')
  await expect(page.locator('.conversation-root')).toBeVisible()
  const owners = await page.evaluate(async () => {
    const path = '/src/components/workspace/useWorkspaceSnapshot.ts'
    const view = (await import(path)).useWorkspaceSnapshot({ active: false })
    return { polled: view.sessionId.value, viewed: view.viewedSessionId.value }
  })
  // The workspace stays on the active parent; Files accepts the child's files.
  expect(owners.viewed).toBe('showcase-child')
  expect(owners.polled).not.toBe('showcase-child')
  await page.evaluate(async () => {
    const viewerPath = '/src/components/ui/imageViewer.ts'
    const filesPath = '/src/components/workspace/workspaceState.ts'
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 80
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#c8a35d'
    ctx.fillRect(0, 0, 80, 80)
    ;(await import(viewerPath)).openImageViewer({
      owner: 'showcase-child',
      items: [
        {
          id: 'child-image',
          name: '子智能体图片.png',
          src: canvas.toDataURL('image/png'),
        },
      ],
    })
    ;(await import(filesPath)).requestWorkspace({
      pane: 'files',
      file: {
        owner: 'showcase-child',
        target: { source: 'attachment', attachmentId: 'att_2026-10_12345678' },
      },
    })
  })
  await expect(page.locator('.image-lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  // The child's attachment opens as a tab in the parent's Files pane.
  await expect(
    page.locator('.files-pane .workspace-tab-bar .tab-item[data-active]'),
  ).toBeVisible()
})
