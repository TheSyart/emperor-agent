// @vitest-environment jsdom
import { createApp, h, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolChatData } from '../../../conversation/types'
import WebSearchView from './WebSearchView.vue'

let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  root?.remove()
})
function mount(
  meta: object,
  text = 'Raw search result',
  isError = false,
): HTMLDivElement {
  const data = {
    callId: 'search-1',
    name: 'web_search',
    argsRaw: '{"queries":["Vue"]}',
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
    result: {
      seq: 2,
      time: 1,
      content: [{ type: 'text', text }],
      isError,
      meta,
    },
  } as ToolChatData
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(WebSearchView, { data }) })
  app.mount(root)
  return root
}
describe('WebSearchView resources', () => {
  it('renders actual sources as resource cards with answer, date and snippet intact', () => {
    const element = mount({
      answer: 'Search answer',
      sources: [
        {
          url: 'https://vuejs.org/guide/',
          title: 'Vue guide',
          snippet: 'Official guide',
          publishedAt: '2026-10-15',
        },
        {
          url: 'https://github.com/vuejs/core',
          title: 'Vue source',
          snippet: 'Repository',
        },
      ],
    })
    expect(element.querySelectorAll('.resource-card')).toHaveLength(2)
    expect(
      element.querySelector('[data-resource-kind="github"]'),
    ).not.toBeNull()
    expect(element.textContent).toContain('Search answer')
    expect(element.textContent).toContain('Official guide')
    expect(element.textContent).toContain('2026-10-15')
    expect(element.querySelector('details summary')?.textContent).toContain(
      '原始结果',
    )
    expect(element.querySelector('details')?.textContent).toContain(
      'Raw search result',
    )
  })
  it('rejects unsafe source URLs without hiding the raw result', () => {
    const element = mount(
      { sources: [{ url: 'javascript:alert(1)', title: 'unsafe' }] },
      'Raw unsafe result',
    )
    expect(element.querySelector('.resource-card')).toBeNull()
    expect(element.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(element.textContent).toContain('Raw unsafe result')
  })
})
