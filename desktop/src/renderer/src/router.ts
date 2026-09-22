import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type RouteLocation,
  type RouteLocationRaw,
  type RouteRecordRaw,
} from 'vue-router'
import {
  normalizeSettingsSection,
  type SettingsSectionKey,
} from './components/settings/settingsSections'

const ConversationView = () =>
  import('./components/conversation/ConversationView.vue')

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
  // Retired standalone pages: deep links open the settings modal instead.
  {
    path: '/settings/:section?',
    redirect: settingsRedirect((to) =>
      normalizeSettingsSection(firstParam(to.params.section)),
    ),
  },
  {
    path: '/plugins/:tab?',
    redirect: settingsRedirect((to) => {
      const tab = firstParam(to.params.tab)
      return tab === 'skills' || tab === 'tools' || tab === 'mcp'
        ? tab
        : 'plugins'
    }),
  },
  {
    path: '/skills/:name?',
    redirect: settingsRedirect('skills', (to): Record<string, string> => {
      const name = firstParam(to.params.name)
      return name ? { skill: name } : {}
    }),
  },
  { path: '/tools', redirect: settingsRedirect('tools') },
  { path: '/mcp', redirect: settingsRedirect('mcp') },
  { path: '/model', redirect: settingsRedirect('model') },
  { path: '/scheduler', redirect: settingsRedirect('scheduler') },
  { path: '/configs', redirect: settingsRedirect('configs') },
  { path: '/pet', redirect: settingsRedirect('pet') },
  { path: '/memory', redirect: settingsRedirect('memory') },
  { path: '/tokens', redirect: settingsRedirect('tokens') },
  { path: '/team', redirect: '/chat' },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

export const router = createRouter({
  history:
    typeof window === 'undefined' ? createMemoryHistory() : createWebHistory(),
  routes: routeRecords,
})

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
