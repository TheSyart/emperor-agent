import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type LocationQuery,
  type RouteLocation,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type Router,
} from 'vue-router'
import {
  normalizeSettingsSection,
  settingsAlias,
  type SettingsSectionKey,
} from './components/settings/settingsSections'

// Every route view is its own chunk.
const ConversationView = () =>
  import('./components/conversation/ConversationView.vue')
const SchedulerPage = () =>
  import('./components/pages/scheduler/SchedulerPage.vue')
const CapabilitiesPage = () =>
  import('./components/pages/capabilities/CapabilitiesPage.vue')
const PullRequestsPage = () =>
  import('./components/pages/pulls/PullRequestsPage.vue')
const GitHubIssuesPage = () =>
  import('./components/pages/github/GitHubIssuesPage.vue')
const GitHubRunsPage = () =>
  import('./components/pages/github/GitHubRunsPage.vue')

/** Routes that render inside the conversation shell (workspace available). */
export const CONVERSATION_ROUTE_NAMES: readonly string[] = [
  'chat',
  'trajectory',
  'external-agent',
]

export function isConversationRoute(name: unknown): boolean {
  return typeof name === 'string' && CONVERSATION_ROUTE_NAMES.includes(name)
}

function firstParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

/** Redirect a retired standalone page to /chat with the settings modal open. */
export function settingsRedirect(
  section: SettingsSectionKey | ((to: RouteLocation) => SettingsSectionKey),
  extra?: (to: RouteLocation) => Record<string, string>,
) {
  return (to: RouteLocation): RouteLocationRaw => ({
    path: '/chat',
    query: {
      settings: typeof section === 'function' ? section(to) : section,
      ...(extra?.(to) ?? {}),
    },
  })
}

export const routeRecords: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  {
    path: '/chat/:sessionId/agents/:delegationId',
    name: 'external-agent',
    component: () =>
      import('./components/conversation/ExternalAgentConversation.vue'),
    meta: { label: '子智能体', tab: 'chat' },
  },
  {
    path: '/chat/:sessionId/trajectory',
    name: 'trajectory',
    component: ConversationView,
    meta: { label: 'Trajectory', tab: 'trajectory' },
  },
  {
    path: '/chat/:sessionId?',
    name: 'chat',
    component: ConversationView,
    meta: { label: 'Chat', tab: 'chat' },
  },
  // Full pages (no workspace column).
  {
    path: '/scheduler',
    name: 'scheduler',
    component: SchedulerPage,
    meta: { label: '定时任务', page: true },
  },
  {
    path: '/capabilities/:tab(plugins|skills|mcp|tools)?',
    name: 'capabilities',
    component: CapabilitiesPage,
    meta: { label: '能力', page: true },
  },
  // The page was 插件 (/plugins/:tab) before 工具 joined it.
  {
    path: '/plugins/:tab(plugins|skills|mcp|tools)?',
    redirect: (to) => {
      const tab = firstParam(to.params.tab)
      return {
        path: tab ? `/capabilities/${tab}` : '/capabilities',
        query: to.query,
      }
    },
  },
  {
    path: '/pulls/:owner?/:repo?/:number?',
    name: 'pulls',
    component: PullRequestsPage,
    meta: { label: 'Pull Request', page: true },
  },
  // The GitHub plugin's Issue and CI views (tabs of the Pull Request page).
  {
    path: '/github/issues/:owner?/:repo?/:number?',
    name: 'github-issues',
    component: GitHubIssuesPage,
    meta: { label: 'Issue', page: true },
  },
  {
    path: '/github/ci/:owner?/:repo?/:runId?',
    name: 'github-ci',
    component: GitHubRunsPage,
    meta: { label: 'CI', page: true },
  },
  { path: '/github', redirect: '/github/issues' },
  // 探索 is the 推荐 block of 能力 now (UI-S08).
  {
    path: '/explore',
    redirect: (to) => ({
      path: '/capabilities',
      query: to.query,
      hash: '#recommended',
    }),
  },
  {
    path: '/skills/:name?',
    redirect: (to) => {
      const name = firstParam(to.params.name)
      return {
        path: '/capabilities/skills',
        query: name ? { skill: name } : {},
      }
    },
  },
  { path: '/mcp', redirect: '/capabilities/mcp' },
  { path: '/tools', redirect: '/capabilities/tools' },
  // Retired standalone pages: deep links open the settings modal instead.
  {
    path: '/settings/:section?',
    redirect: settingsRedirect(
      (to) => normalizeSettingsSection(firstParam(to.params.section)),
      (to): Record<string, string> => {
        const page = settingsAlias(firstParam(to.params.section))?.page
        return page ? { page } : {}
      },
    ),
  },
  { path: '/model', redirect: settingsRedirect('model') },
  { path: '/configs', redirect: settingsRedirect('memory') },
  // 桌宠 is a switch in 常规 › 外观 now.
  { path: '/pet', redirect: settingsRedirect('general') },
  { path: '/memory', redirect: settingsRedirect('memory') },
  { path: '/tokens', redirect: settingsRedirect('tokens') },
  { path: '/team', redirect: '/chat' },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

/** Settings sections that moved to full pages (`?settings=` deep links). */
const SETTINGS_PAGE_PATHS: Record<string, string> = {
  scheduler: '/scheduler',
  plugins: '/capabilities',
  skills: '/capabilities/skills',
  mcp: '/capabilities/mcp',
  tools: '/capabilities/tools',
}

/**
 * Where a `?settings=<section>` link of a section that became a page goes
 * (null: stay). Other query keys carry over; `skill` only for Skills. A
 * section folded into another one (Hooks, 诊断 → 高级; 桌宠 → 常规) opens
 * there, on its sub page when it has one.
 */
export function settingsPageRedirect(
  to: Pick<RouteLocationNormalized, 'query' | 'path'>,
): RouteLocationRaw | null {
  const section = firstParam(to.query.settings)
  const alias = settingsAlias(section)
  if (alias) {
    const { settings: _settings, page: _page, ...rest } = to.query
    return {
      path: to.path,
      query: {
        ...rest,
        settings: alias.section,
        ...(alias.page ? { page: alias.page } : {}),
      },
    }
  }
  const path = SETTINGS_PAGE_PATHS[section]
  if (!path) return null
  const { settings: _settings, page: _page, skill, ...rest } = to.query
  const query: LocationQuery = { ...rest }
  const name = firstParam(skill)
  if (section === 'skills' && name) query.skill = name
  return { path, query }
}

/** Global navigation guards (the app router and router tests). */
export function installRouteGuards(target: Router): void {
  target.beforeEach((to) => settingsPageRedirect(to) ?? true)
}

export const router = createRouter({
  history:
    typeof window === 'undefined' ? createMemoryHistory() : createWebHistory(),
  routes: routeRecords,
})
installRouteGuards(router)

/** Route location of a session's Chat (or Trajectory) tab. */
export function sessionLocation(
  sessionId: string,
  tab: 'chat' | 'trajectory' = 'chat',
): RouteLocationRaw {
  if (!sessionId) return { name: 'chat' }
  return tab === 'trajectory'
    ? { name: 'trajectory', params: { sessionId } }
    : { name: 'chat', params: { sessionId } }
}
