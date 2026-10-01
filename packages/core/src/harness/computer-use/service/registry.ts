/**
 * TargetRegistry + leases (spec 00 §4.2, §5.7). The kernel is the authority
 * on who owns a target: the driver mints the unguessable id, but only the
 * owning root session may act on it. Each session also has a "current"
 * target that tools use when no `targetId` is given.
 */

import { normalizeOrigin } from '../grants/match'
import type { TargetSnapshot } from '../port'
import type {
  ControlState,
  DriverKind,
  TargetKind,
  TargetState,
  UiTargetRef,
  UiTargetView,
} from '../types'

export interface ScreenshotRecord {
  readonly screenshotId: string
  readonly generation: number
  readonly revision: number
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly attachmentId: string
  readonly takenAt: string
}

export interface TargetRecord {
  readonly targetId: string
  readonly ownerSessionId: string
  readonly kind: TargetKind
  readonly driver: DriverKind
  readonly profileId: string
  readonly appId?: string
  readonly windowRef?: string
  readonly openedAt: string
  /** The Agent's latest operation on this target. */
  lastActiveAt: string
  /** Generation at a credential fill: its picture stays out of previews. */
  credentialFilledGeneration?: number
  /** The user's "Stop Sharing" ended this window's capture stream. */
  sharingStopped?: true
  generation: number
  revision: number
  state: TargetState
  control: ControlState
  /** The task's end is releasing it: no new action starts (§3.3). */
  releasing?: true
  /** Released, but giving up control failed: why (no action runs on it). */
  releaseError?: string
  title: string
  url: string
  /** Recent screenshots, newest last (bounded). */
  readonly screenshots: ScreenshotRecord[]
  /** Role and name per ref from recent observations (for risk checks). */
  readonly elements: Map<
    string,
    { role: string; name: string; frameOrigin?: string; inputType?: string }
  >
}

const SCREENSHOTS_KEPT = 8

/** Neither released, closed nor lost: the Agent may act on it. */
export function isLive(record: TargetRecord): boolean {
  return (
    record.state !== 'released' &&
    record.state !== 'closed' &&
    record.state !== 'lost'
  )
}

/**
 * Still holds something of ours: a live target, or a released built-in
 * browser tab (its page stays open for the next task to take back).
 */
export function isHeld(record: TargetRecord): boolean {
  return (
    isLive(record) ||
    (record.state === 'released' && record.driver === 'embedded-browser')
  )
}

export class TargetRegistry {
  private readonly targets = new Map<string, TargetRecord>()
  private readonly current = new Map<string, string>()

  add(
    ownerSessionId: string,
    snapshot: TargetSnapshot,
    now: Date,
  ): TargetRecord {
    const record: TargetRecord = {
      targetId: snapshot.targetId,
      ownerSessionId,
      kind: snapshot.kind,
      driver: snapshot.driver,
      profileId: snapshot.profileId,
      ...(snapshot.appId === undefined ? {} : { appId: snapshot.appId }),
      ...(snapshot.windowRef === undefined
        ? {}
        : { windowRef: snapshot.windowRef }),
      openedAt: now.toISOString(),
      lastActiveAt: now.toISOString(),
      generation: snapshot.generation,
      revision: snapshot.revision,
      state: 'attached',
      control: 'agent',
      title: snapshot.title,
      url: snapshot.url,
      screenshots: [],
      elements: new Map(),
    }
    this.targets.set(record.targetId, record)
    this.current.set(ownerSessionId, record.targetId)
    return record
  }

  get(targetId: string): TargetRecord | undefined {
    return this.targets.get(targetId)
  }

  /** Live targets (see `isLive`), optionally of one owner. */
  live(ownerSessionId?: string): TargetRecord[] {
    return this.filter(isLive, ownerSessionId)
  }

  /** Live targets and released built-in tabs (see `isHeld`). */
  held(ownerSessionId?: string): TargetRecord[] {
    return this.filter(isHeld, ownerSessionId)
  }

  /** Released targets, optionally of one owner. */
  released(ownerSessionId?: string): TargetRecord[] {
    return this.filter((record) => record.state === 'released', ownerSessionId)
  }

  private filter(
    keep: (record: TargetRecord) => boolean,
    ownerSessionId: string | undefined,
  ): TargetRecord[] {
    return [...this.targets.values()].filter(
      (record) =>
        keep(record) &&
        (ownerSessionId === undefined ||
          record.ownerSessionId === ownerSessionId),
    )
  }

  /**
   * The owner's current target, or its latest live one. With nothing live
   * the pointer stays on a released target, so a call without a targetId
   * can say why it is gone (`lastCurrent`).
   */
  currentFor(ownerSessionId: string): TargetRecord | undefined {
    const id = this.current.get(ownerSessionId)
    const record = id === undefined ? undefined : this.targets.get(id)
    if (record !== undefined && isLive(record)) return record
    const fallback = this.live(ownerSessionId).at(-1)
    if (fallback !== undefined)
      this.current.set(ownerSessionId, fallback.targetId)
    else if (record?.state !== 'released') this.current.delete(ownerSessionId)
    return fallback
  }

  /** Where the owner's current pointer is, whatever its state. */
  lastCurrent(ownerSessionId: string): TargetRecord | undefined {
    const id = this.current.get(ownerSessionId)
    return id === undefined ? undefined : this.targets.get(id)
  }

  select(ownerSessionId: string, targetId: string): void {
    this.current.set(ownerSessionId, targetId)
  }

  /** Terminal: the record stays for status queries but can never act again. */
  end(targetId: string, state: 'closed' | 'lost'): TargetRecord | undefined {
    const record = this.targets.get(targetId)
    if (record === undefined) return undefined
    record.state = state
    record.releasing = undefined
    if (this.current.get(record.ownerSessionId) === targetId)
      this.current.delete(record.ownerSessionId)
    return record
  }

  /**
   * The task ended (§3.3): the handle goes stale, the current pointer stays
   * (see `currentFor`). `error`: giving up control failed.
   */
  release(targetId: string, error?: string): TargetRecord | undefined {
    const record = this.targets.get(targetId)
    if (record === undefined || !isLive(record)) return undefined
    record.state = 'released'
    record.releasing = undefined
    record.elements.clear()
    if (error === undefined) delete record.releaseError
    else record.releaseError = error
    return record
  }

  /** Drop records that hold nothing any more (bounded memory). */
  prune(keep = 64): void {
    const ended = [...this.targets.values()].filter((record) => !isHeld(record))
    for (const record of ended.slice(0, Math.max(0, ended.length - keep))) {
      this.targets.delete(record.targetId)
      if (this.current.get(record.ownerSessionId) === record.targetId)
        this.current.delete(record.ownerSessionId)
    }
  }

  addScreenshot(record: TargetRecord, shot: ScreenshotRecord): void {
    record.screenshots.push(shot)
    if (record.screenshots.length > SCREENSHOTS_KEPT) record.screenshots.shift()
  }

  all(): TargetRecord[] {
    return [...this.targets.values()]
  }
}

export function targetRef(record: TargetRecord): UiTargetRef {
  return {
    ownerSessionId: record.ownerSessionId,
    targetId: record.targetId,
    kind: record.kind,
    driver: record.driver,
    generation: record.generation,
  }
}

export function targetOrigin(record: Pick<TargetRecord, 'url'>): string | null {
  return normalizeOrigin(record.url)
}

/**
 * Why a preview must not show `record`: a credential fill (desktop windows
 * for good; a browser tab until it navigates).
 */
export function previewBlocked(
  record: TargetRecord,
): UiTargetView['previewBlocked'] {
  const filled = record.credentialFilledGeneration
  if (filled === undefined) return undefined
  return record.driver === 'desktop' || filled === record.generation
    ? 'credential-filled'
    : undefined
}

export function targetView(record: TargetRecord): UiTargetView {
  const shot = record.screenshots.at(-1)
  const blocked = previewBlocked(record)
  return {
    targetId: record.targetId,
    ownerSessionId: record.ownerSessionId,
    kind: record.kind,
    driver: record.driver,
    generation: record.generation,
    revision: record.revision,
    state: record.state,
    control: record.control,
    title: record.title,
    url: record.url,
    origin: targetOrigin(record),
    profileId: record.profileId,
    openedAt: record.openedAt,
    lastActiveAt: record.lastActiveAt,
    ...(blocked === undefined ? {} : { previewBlocked: blocked }),
    ...(record.sharingStopped === true ? { sharingStopped: true } : {}),
    ...(record.state === 'released' && record.releaseError !== undefined
      ? { releaseFailed: record.releaseError }
      : {}),
    ...(shot === undefined
      ? {}
      : {
          lastScreenshot: {
            attachmentId: shot.attachmentId,
            width: shot.width,
            height: shot.height,
            takenAt: shot.takenAt,
          },
        }),
  }
}
