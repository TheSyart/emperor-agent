/**
 * Settings modal ⇄ route query. The modal is open while the current route
 * carries `?settings=<section>`; opening, switching and closing only rewrite
 * the query, so the conversation below keeps its session and scroll.
 * Opening a section that moved to a page (定时任务 / 插件 / Skills / MCP)
 * lands on that page through the router guard.
 */
import { computed } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
  modalSettingsSection,
  type SettingsSectionKey,
} from './settingsSections'

export function settingsQuery(
  query: LocationQuery,
  section: SettingsSectionKey | null,
): LocationQuery {
  const next: LocationQuery = { ...query }
  delete next.settings
  if (section) next.settings = section
  return next
}

export function useSettingsRoute() {
  const route = useRoute()
  const router = useRouter()

  const open = computed(() => route.query.settings != null)
  const section = computed(() => modalSettingsSection(route.query.settings))

  function openSettings(
    target: SettingsSectionKey = 'general',
  ): Promise<unknown> {
    return router
      .push({ path: route.path, query: settingsQuery(route.query, target) })
      .catch(() => undefined)
  }

  function selectSection(target: SettingsSectionKey): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, target) })
      .catch(() => undefined)
  }

  function closeSettings(): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, null) })
      .catch(() => undefined)
  }

  return { open, section, openSettings, selectSection, closeSettings }
}
