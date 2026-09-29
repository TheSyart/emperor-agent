/**
 * The plugin open in the 插件 tab's inline detail, kept in the route query
 * (`/capabilities/plugins?plugin=acme/demo&scope=user`): plugin ids may hold
 * a `/`, so the query carries them rather than a path segment, as `?skill=`
 * does for Skills. The page is kept alive while another route shows, so the
 * selection only follows the route it mounted on; `select()` rewrites only
 * `plugin` and `scope` and keeps every other query key.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'

const SCOPES = ['user', 'project', 'local', 'managed'] as const
export type PluginSelectionScope = (typeof SCOPES)[number]

export interface PluginSelection {
  pluginId: string
  scope: PluginSelectionScope
}

function first(value: LocationQuery[string]): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw ? raw : null
}

export function pluginFromQuery(query: LocationQuery): PluginSelection | null {
  const pluginId = first(query.plugin)
  const scope = first(query.scope)
  if (!pluginId || !SCOPES.includes(scope as PluginSelectionScope)) return null
  return { pluginId, scope: scope as PluginSelectionScope }
}

/** `query` with `plugin` / `scope` set (or both removed for null). */
export function pluginQuery(
  query: LocationQuery,
  selection: PluginSelection | null,
): LocationQuery {
  const next: LocationQuery = { ...query }
  delete next.plugin
  delete next.scope
  if (selection) {
    next.plugin = selection.pluginId
    next.scope = selection.scope
  }
  return next
}

export function usePluginSelection() {
  const route = useRoute()
  const router = useRouter()
  const home = route.name
  const selected = ref<PluginSelection | null>(pluginFromQuery(route.query))

  watch(
    () => [route.name, route.query.plugin, route.query.scope] as const,
    ([name]) => {
      if (name === home) selected.value = pluginFromQuery(route.query)
    },
  )

  function select(selection: PluginSelection | null): Promise<unknown> {
    if (route.name !== home) return Promise.resolve()
    return router
      .replace({ path: route.path, query: pluginQuery(route.query, selection) })
      .catch(() => undefined)
  }

  return { selected: computed(() => selected.value), select }
}
