// @vitest-environment jsdom
// UI-S01 (PLAN-V020): the shell frame — a permanent rail column, the
// sidebar on the canvas, and the conversation and the workspace as two
// panels; the sidebar folds below 1024px and columns never animate width.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AppFrame from './AppFrame.vue'
import {
  frameActions,
  resetFrameStateForTest,
  useFrameState,
} from './frameState'

let app: App | undefined
let root: HTMLDivElement

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
}

async function mount(width = 1440): Promise<HTMLElement> {
  setViewport(width)
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(
        AppFrame,
        { workspaceAvailable: true },
        {
          rail: () => h('nav', { class: 'test-rail' }, 'rail'),
          sidebar: ({ collapsed }: { collapsed: boolean }) =>
            h('aside', { class: 'test-sidebar', 'data-collapsed': collapsed }),
          default: () => h('div', { class: 'test-center' }),
          workspace: () => h('div', { class: 'test-workspace' }),
        },
      ),
  })
  app.mount(root)
  await nextTick()
  return root.querySelector<HTMLElement>('.app-frame')!
}

beforeEach(() => {
  localStorage.clear()
  resetFrameStateForTest()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

describe('AppFrame', () => {
  it('keeps the rail column when the sidebar is collapsed (test 4)', async () => {
    const frame = await mount()
    expect(frame.querySelector('.rail-col .test-rail')).not.toBeNull()
    expect(frame.style.gridTemplateColumns).toMatch(/^56px 236px /)
    frameActions.toggleSidebar(useFrameState())
    await nextTick()
    expect(frame.dataset.sidebarCollapsed).toBe('true')
    expect(frame.querySelector('.rail-col .test-rail')).not.toBeNull()
    expect(frame.style.gridTemplateColumns).toMatch(/^56px 0px /)
    // The folded sidebar is out of the tab order and the accessibility tree.
    const sidebar = frame.querySelector<HTMLElement>('.sidebar-col')!
    expect(sidebar.hasAttribute('inert')).toBe(true)
    expect(sidebar.getAttribute('aria-hidden')).toBe('true')
  })

  it('folds the sidebar below 1024px and keeps it at 1024 (test 7)', async () => {
    let frame = await mount(1000)
    expect(frame.dataset.sidebarCollapsed).toBe('true')
    expect(frame.dataset.narrow).toBe('true')
    expect(frame.querySelector('.rail-col .test-rail')).not.toBeNull()
    app?.unmount()
    root.remove()
    resetFrameStateForTest()
    frame = await mount(1024)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })

  it('puts the conversation and the workspace on two panels', async () => {
    const frame = await mount()
    const center = frame.querySelector('.center-col > .shell-panel')
    expect(center?.getAttribute('data-panel')).toBe('center')
    expect(center?.querySelector('.test-center')).not.toBeNull()
    const workspace = frame.querySelector('.workspace-col > .shell-panel')
    expect(workspace?.getAttribute('data-panel')).toBe('workspace')
    expect(workspace?.querySelector('.test-workspace')).not.toBeNull()
  })

  it('never animates column widths (test 9)', async () => {
    const source = (await import('./AppFrame.vue?raw')).default
    const style = source.slice(source.indexOf('<style'))
    expect(style).not.toMatch(/transition[^;]*grid-template-columns/)
    expect(style).not.toMatch(/transition:[^;]*\b(width|padding)/)
    // The shell measures panels with tokens: gutter 8, radius 12, bars 46.
    const tokens = readFileSync(
      join(__dirname, '../../theme/components.css'),
      'utf8',
    )
    expect(tokens).toMatch(/--rail-w:\s*56px;/)
    expect(tokens).toMatch(/--shell-gutter:\s*8px;/)
    expect(tokens).toMatch(/--shell-bar-h:\s*46px;/)
    expect(tokens).toMatch(/--panel-radius:\s*var\(--r-md\);/)
    expect(style).toMatch(/border-radius:\s*var\(--panel-radius\)/)
    expect(style).toMatch(/background:\s*rgb\(var\(--surface-base\)\)/)
    // No column borders on the canvas.
    expect(style).not.toMatch(/border-(left|right):\s*1px/)
  })
})
