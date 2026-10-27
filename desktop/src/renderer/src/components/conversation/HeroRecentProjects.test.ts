// @vitest-environment jsdom
// MOD-03: the Build home's 「最近的项目」 cards, 「打开文件夹…」 and the
// folder drop.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import HeroRecentProjects from './HeroRecentProjects.vue'
import type { RecentProject } from './heroProjects'

let app: App | undefined
let root: HTMLDivElement | undefined
const events: Array<[string, unknown]> = []

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const card = (id: string, extra: Partial<RecentProject> = {}) => ({
  id,
  name: id,
  path: `/work/${id}`,
  sessionCount: 2,
  running: 0,
  updatedAt: '2026-10-26T12:00:00.000Z',
  ...extra,
})

async function mount(
  projects: RecentProject[],
  currentId: string | null = null,
) {
  events.length = 0
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(HeroRecentProjects, {
        projects,
        currentId,
        now: NOW,
        onPick: (project: RecentProject) => events.push(['pick', project.id]),
        onOpenFolder: () => events.push(['open-folder', null]),
        onDropFolder: (file: File) => events.push(['drop-folder', file.name]),
        onDropRejected: () => events.push(['drop-rejected', null]),
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

const cards = () =>
  [...root!.querySelectorAll<HTMLElement>('[data-project-id]')].map(
    (el) => el.dataset.projectId,
  )
const openFolder = () =>
  root!.querySelector<HTMLButtonElement>('[data-open-folder]')!

function drop(items: Array<{ directory: boolean; name: string }>) {
  const files = items.map((item) => new File([''], item.name))
  const dataTransfer = {
    files,
    types: ['Files'],
    items: items.map((item, index) => ({
      kind: 'file',
      getAsFile: () => files[index]!,
      webkitGetAsEntry: () => ({
        isDirectory: item.directory,
        isFile: !item.directory,
      }),
    })),
  }
  const zone = root!.querySelector<HTMLElement>('.hero-recent-projects')!
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    zone.dispatchEvent(event)
  }
}

it('4 · shows the projects it is given, then 打开文件夹…', async () => {
  await mount([card('alpha', { running: 1 }), card('beta')], 'alpha')
  expect(cards()).toEqual(['alpha', 'beta'])
  expect(root!.textContent).toContain('最近的项目')
  expect(root!.textContent).toContain('2 个会话 · 1 个在运行')
  expect(
    root!
      .querySelector('[data-project-id="alpha"]')!
      .getAttribute('aria-current'),
  ).toBe('true')
  expect(
    root!
      .querySelector('[data-project-id="beta"]')!
      .hasAttribute('aria-current'),
  ).toBe(false)
  expect(openFolder().textContent).toContain('打开文件夹…')
  expect(openFolder().textContent).toContain('或把文件夹拖到这里')

  root!.querySelector<HTMLButtonElement>('[data-project-id="beta"]')!.click()
  openFolder().click()
  expect(events).toEqual([
    ['pick', 'beta'],
    ['open-folder', null],
  ])
})

it('4 · with no project at all offers only 打开文件夹…', async () => {
  await mount([])
  expect(cards()).toEqual([])
  expect(root!.textContent).not.toContain('最近的项目')
  expect(openFolder()).not.toBeNull()
})

it('5 · a dropped folder is handed on', async () => {
  await mount([card('alpha')])
  drop([{ directory: true, name: 'tankwar' }])
  await nextTick()
  expect(events).toEqual([['drop-folder', 'tankwar']])
  expect(
    root!.querySelector('.hero-recent-projects')!.hasAttribute('data-drag'),
  ).toBe(false)
})

it('6 · a dropped file is turned away', async () => {
  await mount([card('alpha')])
  drop([{ directory: false, name: 'notes.md' }])
  await nextTick()
  expect(events).toEqual([['drop-rejected', null]])
})
