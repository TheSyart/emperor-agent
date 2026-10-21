import { expect, test } from '@playwright/test'
import { installVisualCoreBridge } from './visualBridge'

// UI-S13 · 1: the subagent portraits are cut out of their sheets. In the
// browser that decodes them: every sheet is clear at its corners and solid
// at the middle of each of the 36 frames, and a portrait avatar paints no
// tile behind the character.

test.beforeEach(async ({ page }) => {
  await installVisualCoreBridge(page)
})

test('UI-S13 · 1 · every portrait is cut out: clear around, solid in the middle', async ({
  page,
}) => {
  await page.goto('/chat/build-ui?visualTheme=dark')
  const result = await page.evaluate(async () => {
    const base = '/src/assets/subagent-avatars/'
    const frames = (await (await fetch(`${base}frames.json`)).json()) as {
      id: string
      group: string
      rect: [number, number, number, number]
    }[]
    const corners: Record<string, number[]> = {}
    const centres: Record<string, number> = {}
    for (const group of ['A', 'B', 'C', 'D']) {
      const blob = await (await fetch(`${base}${group}-sheet.webp`)).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const alpha = (x: number, y: number) =>
        context.getImageData(x, y, 1, 1).data[3]!
      const w = bitmap.width - 2
      const h = bitmap.height - 2
      corners[group] = [alpha(1, 1), alpha(w, 1), alpha(1, h), alpha(w, h)]
      for (const frame of frames.filter((f) => f.group === group)) {
        const [x, y, fw, fh] = frame.rect
        centres[frame.id] = alpha(
          Math.round(x + fw / 2),
          Math.round(y + fh / 2),
        )
      }
    }
    return { corners, centres }
  })
  for (const [group, values] of Object.entries(result.corners))
    expect(values, group).toEqual([0, 0, 0, 0])
  expect(Object.keys(result.centres)).toHaveLength(36)
  for (const [id, value] of Object.entries(result.centres))
    expect(value, id).toBe(255)
})

test('UI-S13 · 1 · a portrait avatar paints no tile behind the character', async ({
  page,
}) => {
  await page.goto(
    '/chat/build-ui?settings=executors&visualTheme=dark&visualExecutors=token',
  )
  const avatar = page
    .getByRole('dialog', { name: '设置' })
    .locator('.ds-avatar[data-shown="sprite"]')
    .first()
  await expect(avatar).toBeVisible()
  const look = await avatar.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      border: style.borderTopWidth,
    }
  })
  expect(look).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    shadow: 'none',
    border: '0px',
  })
})
