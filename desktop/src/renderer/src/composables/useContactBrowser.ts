/**
 * The contacts page's toggle (GRP-21). The footer's 联系人 icon opens
 * `/contacts` (the list and, then, profiles) and a second click returns to
 * the conversation it was opened from. Only a conversation is remembered;
 * opening it while already browsing contacts keeps the last one.
 *
 * The page is an ordinary route, so the sidebar and the router's back /
 * forward keep working; no overlay state is involved.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CONTACT_ROUTES, GROUP_HOME_ROUTE } from '../runtime/appMode'

/** Routes that show a conversation; the page returns to the last one. */
const ROOM_ROUTES: readonly string[] = [
  'chat',
  'trajectory',
  'external-agent',
  'group',
  'group-settings',
]

let lastRoom = ''

export function useContactBrowser() {
  const route = useRoute()
  const router = useRouter()

  const active = computed(() =>
    CONTACT_ROUTES.includes(String(route.name ?? '')),
  )

  function toggle(): void {
    if (active.value) {
      const back = lastRoom
      lastRoom = ''
      void router
        .push(back || { name: GROUP_HOME_ROUTE })
        .catch(() => undefined)
      return
    }
    if (ROOM_ROUTES.includes(String(route.name ?? '')))
      lastRoom = route.fullPath
    void router.push({ name: 'contacts' }).catch(() => undefined)
  }

  return { active, toggle }
}

/** Tests: forget the conversation remembered for the next toggle. */
export function resetContactBrowserForTest(): void {
  lastRoom = ''
}
