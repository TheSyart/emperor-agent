/**
 * 轨迹门控 (UI-S09). The trajectory — the 轨迹 tab, a tool row's Inspect and
 * the inspector column — is a developer surface, hidden until 设置 › 常规 ›
 * 开发者 › 显示轨迹 is on (`useUiPreferences().showTrajectory`, default off).
 * While it is off the chat never loads the trajectory chunk and never
 * registers its conversation target.
 *
 * - `trajectoryRouteGuard` (the trajectory route's beforeEnter) sends a
 *   trajectory link opened while it is off to the session's chat, without
 *   `call`, and leaves a notice that ConversationView takes: a toast
 *   「轨迹视图已关闭」 with 「在设置中开启」, and the tool row of `call`
 *   revealed and opened.
 * - `trajectoryOffLocation` is where the trajectory route goes the moment
 *   the switch turns off (App.vue), keeping the other query keys (an open
 *   settings modal stays open).
 */
import { shallowRef, type ShallowRef } from 'vue'
import type {
  LocationQuery,
  RouteLocationNormalized,
  RouteLocationRaw,
} from 'vue-router'
import { uiPreferences } from '../../composables/useUiPreferences'

/** A trajectory link turned back because the trajectory is off. */
export interface TrajectoryNotice {
  readonly sessionId: string
  /** The call it pointed at (`?call=`), shown in the chat instead. */
  readonly callId: string | null
}

type GateRoute = Pick<RouteLocationNormalized, 'params' | 'query'> & {
  readonly name?: RouteLocationNormalized['name']
}

const notice = shallowRef<TrajectoryNotice | null>(null)

/** The pending notice (ConversationView watches it). */
export const trajectoryNotice: Readonly<ShallowRef<TrajectoryNotice | null>> =
  notice

function firstParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

/** The session's chat with the route's query minus `call`. */
function chatLocation(route: GateRoute): RouteLocationRaw {
  const { call: _call, ...query } = route.query
  return {
    name: 'chat',
    params: { sessionId: firstParam(route.params.sessionId) },
    query: query as LocationQuery,
  }
}

/** beforeEnter of the trajectory route. */
export function trajectoryRouteGuard(to: GateRoute): true | RouteLocationRaw {
  if (uiPreferences().showTrajectory) return true
  notice.value = {
    sessionId: firstParam(to.params.sessionId),
    callId: firstParam(to.query.call) || null,
  }
  return chatLocation(to)
}

/** Where the trajectory route goes when the switch turns off (null: stay). */
export function trajectoryOffLocation(
  route: GateRoute,
): RouteLocationRaw | null {
  return route.name === 'trajectory' ? chatLocation(route) : null
}

/** Take the pending notice when it is about `sessionId`. */
export function takeTrajectoryNotice(
  sessionId: string,
): TrajectoryNotice | null {
  const pending = notice.value
  if (pending === null || pending.sessionId !== sessionId) return null
  notice.value = null
  return pending
}

/** Test seam: forget a notice nobody took. */
export function resetTrajectoryGateForTest(): void {
  notice.value = null
}
