// @vitest-environment jsdom
import { createApp, h, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolChatData } from '../../../conversation/types'
import ResourceToolView from './ResourceToolView.vue'

let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  root?.remove()
})
function mount(
  name: string,
  meta: object,
  text: string,
  isError = false,
): HTMLDivElement {
  const data = {
    callId: 'resource-1',
    name,
    argsRaw: '{"url":"https://request.test/"}',
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
  app = createApp({ render: () => h(ResourceToolView, { data }) })
  app.mount(root)
  return root
}
describe('ResourceToolView', () => {
  it('shows the fetched URL and status while preserving raw text under disclosure', () => {
    const element = mount(
      'web_fetch',
      {
        url: 'https://example.com/final',
        title: 'Fetched page',
        statusCode: 200,
        truncated: true,
      },
      'Original fetched text',
    )
    expect(
      element.querySelector('.resource-card a')?.getAttribute('href'),
    ).toBe('https://example.com/final')
    expect(element.textContent).toContain('Fetched page')
    expect(element.textContent).toContain('HTTP 200')
    expect(element.textContent).toContain('内容已截断')
    expect(element.querySelector('details summary')?.textContent).toContain(
      '原始结果',
    )
    expect(element.querySelector('details')?.textContent).toContain(
      'Original fetched text',
    )
  })
  it('identifies a structured GitHub pull request without replacing its raw result', () => {
    const element = mount(
      'mcp_github_pull_request_read',
      { server: 'github', tool: 'pull_request_read' },
      '{"html_url":"https://github.com/a/b/pull/42","title":"Resource support","number":42}',
    )
    expect(
      element.querySelector('[data-resource-kind="github"]'),
    ).not.toBeNull()
    expect(element.textContent).toContain('Pull Request')
    expect(element.textContent).toContain('Resource support')
    expect(element.querySelector('details')?.textContent).toContain('html_url')
  })
  it('falls back to generic raw output for an unknown result or failed fetch', () => {
    const element = mount(
      'web_fetch',
      { url: 'https://example.com/failure' },
      'Access denied',
      true,
    )
    expect(element.querySelector('.resource-card')).toBeNull()
    expect(element.querySelector('[data-error]')?.textContent).toContain(
      'Access denied',
    )
    expect(element.textContent).toContain('https://request.test/')
  })
})
