/**
 * The conversation's read-only preview of the windows and tabs the Agent
 * controls (bottom right of the chat): which targets of the session show, in
 * which order, which get a live frame, and how each card reads. Pure.
 *
 * - Order: the Agent's latest operation on top (`lastActiveAt`); a card the
 *   user brought to the front stays there until the Agent acts elsewhere.
 * - Live frames: the first four streamable cards (a desktop window's capture
 *   stream or a built-in browser tab's paint frames). External browser tabs
 *   only have tool screenshots. Blocked targets never show a picture.
 */
import type { UiTargetView } from '@emperor/core/runtime-contract'

export const LIVE_PREVIEW_LIMIT = 4
/** Cards drawn in the stack; the count still covers every target. */
export const STACK_DEPTH = 4

const LIVE_STATES = new Set<UiTargetView['state']>([
  'created',
  'attached',
  'paused',
  'recovering',
])

function activity(target: UiTargetView): string {
  return target.lastActiveAt ?? target.openedAt
}

/** This session's live targets, the Agent's latest operation first. */
export function previewTargetsFor(
  targets: readonly UiTargetView[] | undefined,
  sessionId: string | null | undefined,
): UiTargetView[] {
  if (!sessionId || !targets) return []
  return targets
    .filter(
      (target) =>
        target.ownerSessionId === sessionId && LIVE_STATES.has(target.state),
    )
    .sort(
      (a, b) =>
        activity(b).localeCompare(activity(a)) ||
        a.targetId.localeCompare(b.targetId),
    )
}

/** A card the user brought to the front, and the latest activity then. */
export interface PreviewPick {
  readonly targetId: string
  readonly since: string
}

export function pickTarget(
  targets: readonly UiTargetView[],
  targetId: string,
): PreviewPick | null {
  if (!targets.some((target) => target.targetId === targetId)) return null
  const since = targets.reduce(
    (latest, target) => (activity(target) > latest ? activity(target) : latest),
    '',
  )
  return { targetId, since }
}

/**
 * Stack order: the pick on top while the Agent has not acted since; the
 * latest operation on top otherwise.
 */
export function stackOrder(
  targets: readonly UiTargetView[],
  pick: PreviewPick | null,
): UiTargetView[] {
  const picked =
    pick && targets.find((target) => target.targetId === pick.targetId)
  if (!picked || targets.some((target) => activity(target) > pick.since))
    return [...targets]
  return [picked, ...targets.filter((target) => target !== picked)]
}

function streamable(target: UiTargetView): boolean {
  return (
    (target.driver === 'desktop' || target.driver === 'embedded-browser') &&
    target.control === 'agent' &&
    target.state !== 'recovering' &&
    target.previewBlocked === undefined
  )
}

/**
 * Targets whose live frames to subscribe: the first four streamable cards,
 * none while the preview is off screen or computer use is stopped.
 */
export function liveTargetIds(
  ordered: readonly UiTargetView[],
  options: { readonly stopped: boolean; readonly onScreen: boolean },
): string[] {
  if (options.stopped || !options.onScreen) return []
  return ordered
    .filter(streamable)
    .slice(0, LIVE_PREVIEW_LIMIT)
    .map((target) => target.targetId)
}

export type PreviewTone = 'active' | 'waiting' | 'paused' | 'stopped' | 'lost'

export function previewStatus(
  target: UiTargetView,
  options: { readonly stopped: boolean; readonly awaiting: boolean },
): { label: string; tone: PreviewTone } {
  if (options.stopped || target.control === 'stopped')
    return { label: '已急停', tone: 'stopped' }
  if (target.state === 'recovering') return { label: '失联', tone: 'lost' }
  if (target.control === 'paused') return { label: '已暂停', tone: 'paused' }
  if (target.control === 'user-takeover')
    return { label: '你已接管', tone: 'paused' }
  if (options.awaiting) return { label: '等待回复', tone: 'waiting' }
  return { label: '操作中', tone: 'active' }
}

export type PreviewFrame =
  | { readonly kind: 'live'; readonly url: string; readonly note: string }
  | {
      readonly kind: 'shot'
      readonly attachmentId: string
      readonly note: string
    }
  | { readonly kind: 'blocked'; readonly note: string }
  | { readonly kind: 'none'; readonly note: string }

const BLOCKED_NOTE: Record<
  NonNullable<UiTargetView['previewBlocked']>,
  string
> = {
  'sensitive-app': '不可预览：你标记的敏感应用',
  'credential-filled': '不可预览：已代填凭据',
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local clock time of a screenshot; the date too when it is not today. */
export function shotTime(iso: string, now: Date): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  return sameDay ? time : `${at.getMonth() + 1}月${at.getDate()}日 ${time}`
}

/** What a card shows: a live frame, the latest screenshot, or why neither. */
export function previewFrame(
  target: UiTargetView,
  liveUrl: string | undefined,
  now: Date,
): PreviewFrame {
  if (target.previewBlocked)
    return { kind: 'blocked', note: BLOCKED_NOTE[target.previewBlocked] }
  if (liveUrl) return { kind: 'live', url: liveUrl, note: '实时画面' }
  const shot = target.lastScreenshot
  if (shot) {
    const time = shotTime(shot.takenAt, now)
    return {
      kind: 'shot',
      attachmentId: shot.attachmentId,
      note: time ? `最近截图 · ${time}` : '最近截图',
    }
  }
  return {
    kind: 'none',
    note: target.driver === 'external-browser' ? '暂无截图' : '等待画面',
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The line under a card's title: the app, or the browser and site. */
export function previewSource(target: UiTargetView): string {
  if (target.driver === 'desktop') {
    const appId = target.url.startsWith('app:')
      ? target.url.slice(4)
      : target.url
    return appId.split('.').filter(Boolean).at(-1) ?? appId
  }
  const host = hostOf(target.url)
  return target.driver === 'embedded-browser'
    ? `内置浏览器 · ${host}`
    : `已连接的浏览器 · ${host}`
}

export function previewTitle(target: UiTargetView): string {
  if (target.title) return target.title
  return target.driver === 'desktop' ? '未命名窗口' : hostOf(target.url)
}
