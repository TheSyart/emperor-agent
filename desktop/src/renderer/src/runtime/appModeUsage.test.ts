import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// MOD-01 11 · architecture: every place that lists sessions goes through
// the mode filter (`sessionAppMode`, via `isListedSession`), so a group
// member's or a trial session can never show up in 对话 by mistake.

const SRC = join(__dirname, '..')
const LIST_BUILDERS = [
  'buildSidebarGroups',
  'searchSidebarSessions',
  'groupSessionsByDay',
] as const

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'gallery') continue
      out.push(...sourceFiles(path))
    } else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

/** The body of `export function name(` up to the next top-level function. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`)
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0)
  const next = source.indexOf('\nfunction ', start + 1)
  const nextExport = source.indexOf('\nexport function ', start + 1)
  const ends = [next, nextExport].filter((index) => index > 0)
  return source.slice(start, ends.length ? Math.min(...ends) : undefined)
}

describe('every session list goes through the mode filter (MOD-01 11)', () => {
  it('the list builders filter with isListedSession, which asks sessionAppMode', () => {
    const model = read('runtime/sidebarModel.ts')
    expect(model).toMatch(
      /import \{[^}]*isListedSession[^}]*\} from '\.\/appMode'/,
    )
    for (const builder of ['buildSidebarGroups', 'searchSidebarSessions'])
      expect(functionBody(model, builder)).toMatch(/\bisListedSession\b/)
    expect(
      functionBody(read('runtime/appMode.ts'), 'isListedSession'),
    ).toContain('sessionAppMode(')
  })

  it('only known places call the list builders, each on filtered sessions', () => {
    const callers = new Map<string, string[]>()
    for (const file of sourceFiles(SRC)) {
      const path = relative(SRC, file)
      if (path === 'runtime/sidebarModel.ts') continue
      const text = readFileSync(file, 'utf8')
      for (const name of LIST_BUILDERS) {
        if (!new RegExp(`\\b${name}\\(`).test(text)) continue
        callers.set(name, [...(callers.get(name) ?? []), path])
      }
    }
    // A new caller has to be added here, after checking it lists sessions
    // through these builders (or isListedSession / sessionsInMode).
    expect(Object.fromEntries(callers)).toEqual({
      buildSidebarGroups: ['components/sidebar/useSidebarState.ts'],
      searchSidebarSessions: ['components/sidebar/SidebarRoot.vue'],
      groupSessionsByDay: ['components/sidebar/SidebarRoot.vue'],
    })
    const root = read('components/sidebar/SidebarRoot.vue')
    // Day groups only ever split the already filtered 对话 list.
    for (const match of root.matchAll(/groupSessionsByDay\(([^)]*)\)/g))
      expect(match[1]).toMatch(/^grouped\.value\./)
  })

  it('content search hits drop sessions nobody lists', () => {
    const root = read('components/sidebar/SidebarRoot.vue')
    const block = root.slice(
      root.indexOf('const searchResults = computed('),
      root.indexOf('const layoutLoaded'),
    )
    expect(block).toContain('content.hits.value')
    expect(block).toContain('isListedSession(')
  })
})

describe('App wiring (MOD-01 6–10)', () => {
  it('binds ⌘1–⌘3 and ⌘N to the mode controller and keeps the route invariant', () => {
    const app = read('App.vue')
    for (const mode of ['chat', 'build', 'group'])
      expect(app).toContain(
        `'mode.${mode}': () => runSafely(() => appModeController.switchTo('${mode}'))`,
      )
    expect(app).toContain(
      "'session.new': () => runSafely(appModeController.newSession)",
    )
    // The route leads; the mode follows it once start-up has landed.
    expect(app).toContain('appMode.followRoute(')
    expect(app).toContain('routeModeTarget(route, sessionStore.getSession)')
    // Start-up opens a session of the saved mode, not just the most recent.
    expect(app).toContain('landInAppMode')
    expect(read('appStartup.ts')).toContain('await landInAppMode?.()')
  })
})
