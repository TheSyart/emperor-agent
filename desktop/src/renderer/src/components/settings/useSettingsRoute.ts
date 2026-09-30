/**
 * Settings modal ⇄ route query. The modal is open while the current route
 * carries `?settings=<section>`; a section's sub page adds `&page=<key>`
 * (`?settings=computer&page=chrome`, a deep link too). Opening, switching
 * and closing only rewrite the query, so the conversation below keeps its
 * session and scroll; switching sections or closing drops the sub page.
 * Opening a section that moved to a page (定时任务 / 插件 / Skills / MCP)
 * lands on that page through the router guard.
 */
import { computed } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
  modalSettingsSection,
  type SettingsSectionKey,
} from './settingsSections'

const PAGE_KEY = /^[a-z][a-z0-9-]{0,31}$/

/** A `page` query value that can name a sub page, else null. */
export function settingsPageKey(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && PAGE_KEY.test(raw) ? raw : null
}

export function settingsQuery(
  query: LocationQuery,
  section: SettingsSectionKey | null,
  page: string | null = null,
): LocationQuery {
  const next: LocationQuery = { ...query }
  delete next.settings
  delete next.page
  if (section) {
    next.settings = section
    if (page) next.page = page
  }
  return next
}

export function useSettingsRoute() {
  const route = useRoute()
  const router = useRouter()

  const open = computed(() => route.query.settings != null)
  const section = computed(() => modalSettingsSection(route.query.settings))
  /** The sub page the route names; the section decides whether it has one. */
  const page = computed(() => settingsPageKey(route.query.page))

  function openSettings(
    target: SettingsSectionKey = 'general',
    subPage: string | null = null,
  ): Promise<unknown> {
    return router
      .push({
        path: route.path,
        query: settingsQuery(route.query, target, subPage),
      })
      .catch(() => undefined)
  }

  function selectSection(target: SettingsSectionKey): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, target) })
      .catch(() => undefined)
  }

  /** A sub page of the open section, or its main page (null). */
  function openPage(target: string | null): Promise<unknown> {
    return router
      .replace({
        path: route.path,
        query: settingsQuery(route.query, section.value, target),
      })
      .catch(() => undefined)
  }

  function closeSettings(): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, null) })
      .catch(() => undefined)
  }

  return {
    open,
    section,
    page,
    openSettings,
    selectSection,
    openPage,
    closeSettings,
  }
}
