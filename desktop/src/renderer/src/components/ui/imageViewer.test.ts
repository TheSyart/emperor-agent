// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, h, ref, type App } from 'vue'
import { closeImageViewer, imageViewer, openImageViewer } from './imageViewer'
import { fitScale, panBounds, zoomAt } from './imageViewerGeometry'
import ImageLightbox from './ImageLightbox.vue'
import ImageViewerHost from './ImageViewerHost.vue'

let app: App | null = null
afterEach(() => {
  app?.unmount()
  app = null
  closeImageViewer()
  document.body.innerHTML = ''
})
describe('image viewer', () => {
  it('fits portrait and wide images, and bounds panning after rotation', () => {
    expect(fitScale(1000, 2000, 800, 600)).toBe(0.3)
    expect(fitScale(200, 100, 800, 600)).toBe(1)
    expect(panBounds(1000, 2000, 1, 90, 800, 600)).toEqual({ x: 600, y: 200 })
  })
  it('keeps the point under the pointer stationary when zooming', () => {
    expect(zoomAt({ x: 10, y: 20 }, 1, 2, { x: 100, y: 100 })).toEqual({
      x: -80,
      y: -60,
    })
  })
  it('rejects unsafe sources and clears the old image on an invalid request', () => {
    openImageViewer({
      owner: 's1',
      items: [{ id: '1', name: 'photo', src: 'data:image/png;base64,AAAA' }],
    })
    expect(imageViewer.value?.owner).toBe('s1')
    openImageViewer({
      owner: 's2',
      items: [{ id: '2', name: 'unsafe', src: 'javascript:alert(1)' }],
    })
    expect(imageViewer.value).toBeNull()
  })
  it('closes on owner changes and releases its layer and background inertness', async () => {
    const owner = ref('s1')
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const host = document.createElement('div')
    document.body.append(host)
    openImageViewer({
      owner: 's1',
      items: [{ id: '1', name: 'photo', src: 'data:image/png;base64,AAAA' }],
    })
    app = createApp(() => h(ImageViewerHost, { owner: owner.value }))
    app.mount(host)
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await nextTick()
    }
    expect(document.querySelector('.image-lightbox')).not.toBeNull()
    owner.value = 's2'
    await nextTick()
    await nextTick()
    expect(imageViewer.value).toBeNull()
    expect(document.querySelector('.image-lightbox')).toBeNull()
    expect(host.inert).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('provides rotation, grouped navigation and restores focus when closed', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    openImageViewer({
      owner: 's1',
      items: [
        {
          id: '1',
          name: '第一张完整文件名.png',
          src: 'data:image/png;base64,AAAA',
        },
        { id: '2', name: '第二张.png', src: 'data:image/png;base64,AAAA' },
      ],
    })
    const host = document.createElement('div')
    document.body.append(host)
    app = createApp(ImageLightbox)
    app.mount(host)
    await nextTick()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '第一张完整文件名.png',
    )
    document
      .querySelector<HTMLButtonElement>('[aria-label="向右旋转"]')!
      .click()
    document.querySelector<HTMLButtonElement>('[aria-label="下一张"]')!.click()
    await nextTick()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '第二张.png',
    )
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await nextTick()
    await nextTick()
    expect(imageViewer.value).toBeNull()
  })
})

describe('image click target', () => {
  it('keeps viewer sources in Emperor and sends remote images to the browser', async () => {
    const { imageClickTarget } = await import('./imageViewer')
    expect(imageClickTarget('data:image/png;base64,aGVsbG8=')).toBe('viewer')
    expect(imageClickTarget('https://example.com/a.svg')).toBe('external')
    expect(imageClickTarget('http://example.com/a.png')).toBe('external')
    expect(imageClickTarget('javascript:alert(1)')).toBe('none')
    expect(imageClickTarget('data:image/svg+xml;base64,PHN2Zy8+')).toBe('none')
  })
})
