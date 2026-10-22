// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import ResourceCard from './ResourceCard.vue'
import { displayResource } from './resourceModel'
import { LINK_STATUS_KEY } from '../parts/linkStatus'

describe('ResourceCard', () => {
  it('uses authored text safely and keeps open separate from details', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const resource = displayResource(
      'https://github.com/a/b/pull/42',
      '<script>title</script>',
      'message-12',
    )!
    const events: Array<{ type: string; source: string }> = []
    const listener = (e: Event) => {
      const d = (e as CustomEvent).detail
      events.push({ type: e.type, source: d.resource.sourceMessageId })
    }
    window.addEventListener('emperor:resource-detail', listener)
    window.addEventListener('emperor:resource-open', listener)
    const app = createApp({ render: () => h(ResourceCard, { resource }) })
    app.mount(element)
    await nextTick()
    expect(element.querySelector('script')).toBeNull()
    expect(element.textContent).toContain('<script>title</script>')
    expect(events).toEqual([])
    element.querySelector<HTMLButtonElement>('[data-resource-detail]')!.click()
    element.querySelector<HTMLAnchorElement>('a')!.click()
    expect(events).toEqual([
      { type: 'emperor:resource-detail', source: 'message-12' },
      { type: 'emperor:resource-open', source: 'message-12' },
    ])
    app.unmount()
    element.remove()
    window.removeEventListener('emperor:resource-detail', listener)
    window.removeEventListener('emperor:resource-open', listener)
  })

  it('makes a missing file inert without losing its path or icon', async () => {
    const element = document.createElement('div')
    const resource = {
      ...displayResource('docs/gone.md', '', 'm1')!,
      available: false,
    }
    const app = createApp({ render: () => h(ResourceCard, { resource }) })
    app.mount(element)
    await nextTick()
    expect(element.querySelector('a')?.getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(element.querySelector('[data-icon-id]')).not.toBeNull()
    expect(element.textContent).toContain('gone.md')
    app.unmount()
  })

  it('refreshes the actual file status and directory icon without loading web metadata', async () => {
    const element = document.createElement('div')
    const resource = displayResource('/project/docs', '文档目录', 'm2')!
    const version = ref(0)
    let state: 'directory' | 'missing' = 'directory'
    const app = createApp({ render: () => h(ResourceCard, { resource }) })
    app.provide(LINK_STATUS_KEY, {
      version,
      status: async () => ({ state, path: '/project/docs' }),
    })
    app.mount(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(element.querySelector('[data-icon-id="folder"]')).not.toBeNull()
    state = 'missing'
    version.value++
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(element.querySelector('a')?.getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(element.textContent).toContain('文件不存在')
    app.unmount()
  })
})
