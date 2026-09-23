/**
 * The Skill open in the Skills tab's inline detail, kept in the current
 * route's `?skill=<name>` query (`/capabilities/skills?skill=writer`), so
 * /skills/:name deep links land on it and 「全部 Skills」 goes back.
 *
 * The page is kept alive while another route shows, so the selection only
 * follows the route while it is still the route the section mounted on;
 * returning to the page restores what was open. `select()` rewrites only
 * `skill` and keeps every other query key.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'

export function skillFromQuery(query: LocationQuery): string | null {
  const raw = query.skill
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value ? value : null
}

/** `query` with `skill` set to `name` (or removed for null). */
export function skillQuery(
  query: LocationQuery,
  name: string | null,
): LocationQuery {
  const next: LocationQuery = { ...query }
  delete next.skill
  if (name) next.skill = name
  return next
}

export function useSkillSelection() {
  const route = useRoute()
  const router = useRouter()
  const home = route.name
  const selected = ref<string | null>(skillFromQuery(route.query))

  watch(
    () => [route.name, route.query.skill] as const,
    ([name]) => {
      if (name === home) selected.value = skillFromQuery(route.query)
    },
  )

  function select(name: string | null): Promise<unknown> {
    if (route.name !== home) return Promise.resolve()
    return router
      .replace({ path: route.path, query: skillQuery(route.query, name) })
      .catch(() => undefined)
  }

  return { selected: computed(() => selected.value), select }
}
