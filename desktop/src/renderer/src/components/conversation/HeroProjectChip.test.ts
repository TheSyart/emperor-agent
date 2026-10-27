// @vitest-environment jsdom
// MOD-03 2–3: the Build home's project chip in the composer — gold and
// asking for a project until one is picked, then the project and its
// branch; its menu picks another project or opens a folder.
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import HeroProjectChip from './HeroProjectChip.vue'
import type { RecentProject } from './heroProjects'
import type { ProjectInfo } from '../../types'

let app: App | undefined
let root: HTMLDivElement | undefined
const events: Array<[string, unknown]> = []
const props = reactive<{
  project: ProjectInfo | null
  branch: string | null
  projects: RecentProject[]
}>({ project: null, branch: null, projects: [] })

const recent = (id: string): RecentProject => ({
  id,
  name: id,
  path: `/work/${id}`,
  sessionCount: 1,
  running: 0,
  updatedAt: '',
})

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

async function mount(initial: Partial<typeof props> = {}) {
  Object.assign(props, { project: null, branch: null, projects: [] }, initial)
  events.length = 0
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(HeroProjectChip, {
        ...props,
        onPick: (project: RecentProject) => events.push(['pick', project.id]),
        onOpenFolder: () => events.push(['open-folder', null]),
      }),
  })
  app.mount(root)
  await settle()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

const chip = () =>
  root!.querySelector<HTMLButtonElement>('[data-hero-project]')!
const branch = () => root!.querySelector<HTMLElement>('[data-hero-branch]')
const menuItems = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'),
]

it('2 · asks for a project in gold until one is picked, with no branch', async () => {
  await mount({ projects: [recent('alpha')] })
  expect(chip().textContent).toContain('选择项目')
  expect(chip().hasAttribute('data-required')).toBe(true)
  expect(chip().getAttribute('data-tone')).toBe('accent')
  expect(branch()).toBeNull()
})

it('3 · shows the picked project and its branch', async () => {
  await mount({
    project: {
      project_id: 'alpha',
      project_path: '/work/alpha',
      project_name: 'Alpha',
    },
    branch: 'release/0.3',
    projects: [recent('alpha')],
  })
  expect(chip().textContent).toContain('Alpha')
  expect(chip().hasAttribute('data-required')).toBe(false)
  expect(chip().getAttribute('aria-label')).toBe('项目：Alpha，换一个项目')
  expect(branch()?.textContent).toContain('release/0.3')
  props.branch = null
  await settle()
  expect(branch()).toBeNull()
})

it('3 · the menu picks another project or opens a folder', async () => {
  await mount({ projects: [recent('alpha'), recent('beta')] })
  chip().click()
  await settle()
  expect(chip().getAttribute('aria-expanded')).toBe('true')
  const labels = menuItems().map((item) => item.textContent?.trim())
  expect(labels).toEqual(['alpha', 'beta', '打开文件夹…'])
  menuItems()[1]!.click()
  await settle()
  chip().click()
  await settle()
  menuItems().at(-1)!.click()
  await settle()
  expect(events).toEqual([
    ['pick', 'beta'],
    ['open-folder', null],
  ])
})
