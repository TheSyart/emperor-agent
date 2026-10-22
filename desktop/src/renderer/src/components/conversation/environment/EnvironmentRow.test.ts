// @vitest-environment jsdom
// UI-S14: which part of an environment-card row gives way when it is too
// narrow. A plain label (「子智能体」) stays whole and the value ends in an
// ellipsis with its full text as the tooltip; a mono label (the branch) and
// a data label (`shrinkLabel`: a plan's title, a file name) shrink instead.
// The layout itself is checked in the browser (tests/visual/subagents.spec.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import EnvironmentRow from './EnvironmentRow.vue'

let app: App | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

function mount(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(EnvironmentRow, props) })
  app.mount(host)
  return host
}

const VALUE = '5 运行 · 1 等待 · 2 失败 · 1 待确认'

describe('EnvironmentRow (UI-S14)', () => {
  it('keeps a plain label whole; its value gives way with the full text as tooltip', () => {
    const root = mount({ label: '子智能体', value: VALUE })
    const label = root.querySelector('.label')!
    expect(label.textContent).toBe('子智能体')
    expect(label.hasAttribute('data-shrink')).toBe(false)
    expect(root.querySelector('.value')?.getAttribute('title')).toBe(VALUE)
  })

  it('lets a mono label and a data label shrink, the value staying whole', () => {
    for (const props of [
      { label: 'feature/a-very-long-branch-name', mono: true, value: '2↑' },
      {
        label: '十代理并行写小说 + codex 生图封面',
        shrinkLabel: true,
        value: '已完成',
      },
    ]) {
      const root = mount(props)
      expect(root.querySelector('.label')?.hasAttribute('data-shrink')).toBe(
        true,
      )
      expect(root.querySelector('.value')?.hasAttribute('title')).toBe(false)
      app?.unmount()
      host?.remove()
      app = null
      host = null
    }
  })

  it('styles the two cases: a whole label never shrinks, a shrinking one does', () => {
    const css = readFileSync(join(__dirname, 'EnvironmentRow.vue'), 'utf8')
    expect(css).toMatch(/\.label \{\s*flex: 1 0 auto;\s*white-space: nowrap;/)
    expect(css).toMatch(
      /\.label\[data-shrink\] \{\s*flex: 1;\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;/,
    )
    expect(css).toMatch(
      /\.value \{\s*flex: 0 1 auto;\s*min-width: 0;\s*overflow: hidden;[\s\S]*?text-overflow: ellipsis;/,
    )
    expect(css).toMatch(/\.label\[data-shrink\] ~ \.value \{\s*flex: none;/)
  })
})
