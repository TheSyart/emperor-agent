// @vitest-environment jsdom
// MOD-04 2–3: the search results by mode — the current mode's results
// under its name, the rest under 「其他模式」, every row tagged Chat /
// Build / Group.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import SidebarSearchResults from './SidebarSearchResults.vue'
import type { SearchSection } from '../../runtime/sidebarModel'

let app: App | undefined
let root: HTMLDivElement | undefined
const opened: string[] = []

const sections: SearchSection[] = [
  {
    key: 'current',
    mode: 'build',
    results: [
      { id: 'b1', title: '构建 一', subtitle: 'Alpha · 2 天', mode: 'build' },
    ],
  },
  {
    key: 'other',
    mode: null,
    results: [
      { id: 'g1', title: '设置页评审', subtitle: '1 小时', mode: 'group' },
      {
        id: 'c1',
        title: '普通对话',
        subtitle: '你：…提到了方案…',
        mode: 'chat',
        group: 'content',
      },
      { id: 'x1', title: '归档的', subtitle: '你：…', mode: null },
    ],
  },
]

async function mount(selectedIndex = 0, input = sections) {
  opened.length = 0
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(SidebarSearchResults, {
        sections: input,
        selectedIndex,
        onOpen: (id: string) => opened.push(id),
      }),
  })
  app.mount(root)
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

const labels = () =>
  [...root!.querySelectorAll<HTMLElement>('.group-label')].map((el) =>
    el.textContent?.trim(),
  )
const rows = () => [
  ...root!.querySelectorAll<HTMLElement>('[data-search-result]'),
]
const tag = (id: string) =>
  root!
    .querySelector(`[data-search-result="${id}"] [data-mode-tag]`)
    ?.textContent?.trim() ?? null

it('2 · heads the current mode by its name, the rest 「其他模式」', async () => {
  await mount()
  expect(labels()).toEqual(['Build', '其他模式'])
  expect(rows().map((el) => el.dataset.searchResult)).toEqual([
    'b1',
    'g1',
    'c1',
    'x1',
  ])
})

it('3 · tags every row with its mode, an unknown one with none', async () => {
  await mount()
  expect(tag('b1')).toBe('Build')
  expect(tag('g1')).toBe('Group')
  expect(tag('c1')).toBe('Chat')
  expect(tag('x1')).toBeNull()
  expect(
    root!.querySelector('[data-search-result="c1"]')?.textContent,
  ).toContain('提到了方案')
})

it('selects across sections by one running index and opens the clicked row', async () => {
  await mount(2)
  expect(
    rows()
      .filter((el) => el.hasAttribute('data-selected'))
      .map((el) => el.dataset.searchResult),
  ).toEqual(['c1'])
  rows()[1]!.click()
  expect(opened).toEqual(['g1'])
})

it('says when nothing matched', async () => {
  await mount(0, [])
  expect(root!.textContent).toContain('没有匹配的会话')
})
