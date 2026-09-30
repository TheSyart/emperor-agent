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
 * - After the user's "Stop Sharing" a window keeps its last frame, marked as
 *   stopped; the Agent carries on working on it.
 * - When the task ends, Core releases every target and the whole group goes
 *   (2026-09-29 §3.3). A target whose release failed stays, saying so.
 * - The Agent's pointer: where its latest desktop or built-in browser action
 *   landed, drawn on that target's live picture for about two seconds.
 */
import type { UiTargetView } from '@emperor/core/runtime-contract'

export const LIVE_PREVIEW_LIMIT = 4
/** Cards drawn in the stack; the count still covers every target. */
export const STACK_DEPTH = 4
/** A card's picture box (`.cu-card-frame img`: `aspect-ratio: 16 / 10`). */
export const FRAME_ASPECT = 16 / 10
/** The pointer starts fading this long after the latest action… */
export const POINTER_FADE_MS = 1_600
/** …and is gone this long after it. */
export const POINTER_GONE_MS = 2_000

const LIVE_STATES = new Set<UiTargetView['state']>([
  'created',
  'attached',
  'paused',
  'recovering',
])

function activity(target: UiTargetView): string {
  return target.lastActiveAt ?? target.openedAt
}

/**
 * This session's live targets (and any whose release failed), the Agent's
 * latest operation first.
 */
export function previewTargetsFor(
  targets: readonly UiTargetView[] | undefined,
  sessionId: string | null | undefined,
): UiTargetView[] {
  if (!sessionId || !targets) return []
  return targets
    .filter(
      (target) =>
        target.ownerSessionId === sessionId &&
        (LIVE_STATES.has(target.state) || releaseFailed(target)),
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

function releaseFailed(target: UiTargetView): boolean {
  return target.state === 'released' && target.releaseFailed !== undefined
}

function streamable(target: UiTargetView): boolean {
  return (
    (target.driver === 'desktop' || target.driver === 'embedded-browser') &&
    target.control === 'agent' &&
    LIVE_STATES.has(target.state) &&
    target.state !== 'recovering' &&
    target.previewBlocked === undefined &&
    target.sharingStopped !== true
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
  if (releaseFailed(target)) return { label: '释放失败', tone: 'lost' }
  if (options.stopped || target.control === 'stopped')
    return { label: '已急停', tone: 'stopped' }
  if (target.state === 'recovering') return { label: '失联', tone: 'lost' }
  if (target.control === 'paused') return { label: '已暂停', tone: 'paused' }
  if (options.awaiting) return { label: '等待回复', tone: 'waiting' }
  return { label: '操作中', tone: 'active' }
}

export type PreviewFrame =
  | { readonly kind: 'live'; readonly url: string; readonly note: string }
  /** The last live frame of a window whose sharing the user stopped. */
  | { readonly kind: 'frozen'; readonly url: string; readonly note: string }
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

/**
 * What a card shows: a live frame (or the last one after "Stop Sharing"),
 * the latest screenshot, or why neither.
 */
export function previewFrame(
  target: UiTargetView,
  frameUrl: string | undefined,
  now: Date,
): PreviewFrame {
  if (target.previewBlocked)
    return { kind: 'blocked', note: BLOCKED_NOTE[target.previewBlocked] }
  const stopped = target.sharingStopped === true
  if (frameUrl)
    return stopped
      ? { kind: 'frozen', url: frameUrl, note: '画面已停止共享 · 最后一帧' }
      : { kind: 'live', url: frameUrl, note: '实时画面' }
  const shot = target.lastScreenshot
  if (shot) {
    const time = shotTime(shot.takenAt, now)
    const note = time ? `最近截图 · ${time}` : '最近截图'
    return {
      kind: 'shot',
      attachmentId: shot.attachmentId,
      note: stopped ? `画面已停止共享 · ${note}` : note,
    }
  }
  if (stopped) return { kind: 'none', note: '画面已停止共享' }
  return {
    kind: 'none',
    note: target.driver === 'external-browser' ? '暂无截图' : '等待画面',
  }
}

/**
 * Where the Agent's pointer sits on a card, in percent of the picture box.
 * `pointer` is a share (0–1) of the window or page; the picture is
 * letterboxed in the box (`object-fit: contain`). Without the picture's
 * size, it is taken to fill the box.
 */
export function pointerPlacement(
  pointer: { readonly x: number; readonly y: number },
  picture?: { readonly width: number; readonly height: number },
  box: number = FRAME_ASPECT,
): { left: number; top: number } {
  const ratio =
    picture !== undefined && picture.width > 0 && picture.height > 0
      ? picture.width / picture.height
      : box
  const width = ratio >= box ? 1 : ratio / box
  const height = ratio >= box ? box / ratio : 1
  return {
    left: ((1 - width) / 2 + pointer.x * width) * 100,
    top: ((1 - height) / 2 + pointer.y * height) * 100,
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
