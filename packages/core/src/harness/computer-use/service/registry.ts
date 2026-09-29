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
  generation: number
  revision: number
  state: TargetState
  control: ControlState
  /** Control state before an emergency stop, restored on resume. */
  controlBeforeStop?: ControlState
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

  /** Live (not closed / lost) targets, optionally of one owner. */
  live(ownerSessionId?: string): TargetRecord[] {
    return [...this.targets.values()].filter(
      (record) =>
        record.state !== 'closed' &&
        record.state !== 'lost' &&
        (ownerSessionId === undefined ||
          record.ownerSessionId === ownerSessionId),
    )
  }

  currentFor(ownerSessionId: string): TargetRecord | undefined {
    const id = this.current.get(ownerSessionId)
    const record = id === undefined ? undefined : this.targets.get(id)
    if (
      record === undefined ||
      record.state === 'closed' ||
      record.state === 'lost'
    ) {
      const fallback = this.live(ownerSessionId).at(-1)
      if (fallback === undefined) this.current.delete(ownerSessionId)
      else this.current.set(ownerSessionId, fallback.targetId)
      return fallback
    }
    return record
  }

  select(ownerSessionId: string, targetId: string): void {
    this.current.set(ownerSessionId, targetId)
  }

  /** Terminal: the record stays for status queries but can never act again. */
  end(targetId: string, state: 'closed' | 'lost'): TargetRecord | undefined {
    const record = this.targets.get(targetId)
    if (record === undefined) return undefined
    record.state = state
    if (this.current.get(record.ownerSessionId) === targetId)
      this.current.delete(record.ownerSessionId)
    return record
  }

  /** Drop terminal records (bounded memory). */
  prune(keep = 64): void {
    const ended = [...this.targets.values()].filter(
      (record) => record.state === 'closed' || record.state === 'lost',
    )
    for (const record of ended.slice(0, Math.max(0, ended.length - keep)))
      this.targets.delete(record.targetId)
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

export function targetView(record: TargetRecord): UiTargetView {
  const shot = record.screenshots.at(-1)
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
    ...(shot === undefined
      ? {}
      : {
          lastScreenshot: {
            attachmentId: shot.attachmentId,
            width: shot.width,
            height: shot.height,
          },
        }),
  }
}
