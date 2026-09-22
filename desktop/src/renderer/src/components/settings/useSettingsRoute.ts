/**
 * Settings modal ⇄ route query. The modal is open while the current route
 * carries `?settings=<section>` (skills may add `&skill=<name>`); opening,
 * switching and closing only rewrite the query, so the conversation below
 * keeps its session and scroll.
 */
import { computed } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
  normalizeSettingsSection,
  type SettingsSectionKey,
} from './settingsSections'

export function settingsQuery(
  query: LocationQuery,
  section: SettingsSectionKey | null,
  extra: Record<string, string | undefined> = {},
): LocationQuery {
  const next: LocationQuery = { ...query }
  delete next.settings
  delete next.skill
  if (section) next.settings = section
  for (const [key, value] of Object.entries(extra))
    if (value !== undefined && section) next[key] = value
  return next
}

export function useSettingsRoute() {
  const route = useRoute()
  const router = useRouter()

  const open = computed(() => route.query.settings != null)
  const section = computed(() => normalizeSettingsSection(route.query.settings))
  const skill = computed(() => {
    const raw = route.query.skill
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' && value ? value : null
  })

  function openSettings(
    target: SettingsSectionKey = 'general',
    extra: Record<string, string | undefined> = {},
  ): Promise<unknown> {
    return router
      .push({
        path: route.path,
        query: settingsQuery(route.query, target, extra),
      })
      .catch(() => undefined)
  }

  function selectSection(
    target: SettingsSectionKey,
    extra: Record<string, string | undefined> = {},
  ): Promise<unknown> {
    return router
      .replace({
        path: route.path,
        query: settingsQuery(route.query, target, extra),
      })
      .catch(() => undefined)
  }

  function closeSettings(): Promise<unknown> {
    return router
      .replace({ path: route.path, query: settingsQuery(route.query, null) })
      .catch(() => undefined)
  }

  return { open, section, skill, openSettings, selectSection, closeSettings }
}
