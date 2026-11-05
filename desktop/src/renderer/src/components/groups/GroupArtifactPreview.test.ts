// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeImageViewer, imageViewer } from '../ui/imageViewer'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const { default: GroupArtifactPreview } =
  await import('./GroupArtifactPreview.vue')

let app: App | null = null
let container: HTMLDivElement | null = null
const state = reactive({ open: true })

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(artifact: {
  ref: string
  name: string
  mimeType: string
}): Promise<void> {
  state.open = true
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(GroupArtifactPreview, {
      groupId: 'grp-1',
      artifact,
      open: state.open,
      'onUpdate:open': (value: boolean) => (state.open = value),
    }),
  )
  app.mount(container)
  await flush()
}

beforeEach(() => {
  core.mockReset()
  core.mockImplementation(async (operation: string) => {
    if (operation === 'references.resolve')
      return { available: true, id: 'ref-1' }
    if (operation === 'references.image')
      return { kind: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }
    if (operation === 'files.preview')
      return { content: '没有人被点名时结束。' }
    throw new Error(`unexpected ${operation}`)
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  closeImageViewer()
  document.body.innerHTML = ''
})

describe('GroupArtifactPreview', () => {
  it('opens an authorized image in the shared viewer, not a second modal', async () => {
    await mount({
      ref: 'artifact://grp-1/art-1/site.png',
      name: 'site.png',
      mimeType: 'image/png',
    })
    expect(core).toHaveBeenCalledWith('references.image', {
      sessionId: 'grp-1',
      referenceId: 'ref-1',
    })
    expect(imageViewer.value).toMatchObject({
      owner: 'grp-1',
      items: [
        {
          id: 'artifact://grp-1/art-1/site.png',
          name: 'site.png',
          src: 'data:image/png;base64,AAAA',
          file: {
            owner: 'grp-1',
            target: {
              source: 'reference',
              sessionId: 'grp-1',
              referenceId: 'ref-1',
            },
          },
        },
      ],
    })
    expect(state.open).toBe(false)
  })

  it('keeps text in the Group preview and never opens the image viewer', async () => {
    await mount({
      ref: 'artifact://grp-1/art-2/report.md',
      name: 'report.md',
      mimeType: 'text/markdown',
    })
    expect(imageViewer.value).toBeNull()
    expect(state.open).toBe(true)
    expect(
      document.querySelector('[data-artifact-preview-content]')?.textContent,
    ).toContain('没有人被点名时结束。')
  })
})
