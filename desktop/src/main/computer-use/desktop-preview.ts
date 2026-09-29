/**
 * Live preview of agent-controlled desktop windows (E-M16). The helper keeps
 * a 2 fps capture stream on each window the Agent controls; while a pane
 * shows one, main asks for its newest frame every 500 ms (one request in
 * flight per window, at most four windows) and forwards new JPEG frames on
 * the Agent preview channel. Browser tabs keep their own paint-based preview;
 * `routedPreview` sends each target id to the right one.
 */

import type {
  AgentPreviewFrame,
  AgentPreviewInput,
} from '../../shared/ipc-contract'

/** Desktop target ids come from the helper: `t-` + an uppercase UUID. */
export const DESKTOP_TARGET_ID =
  /^t-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/

export interface DesktopPreviewFrame {
  readonly seq: number
  readonly jpeg?: Uint8Array
  readonly width?: number
  readonly height?: number
}

export interface DesktopPreviewSource {
  /** The newest frame, with pixels only when newer than `afterSeq`; null when none is live. */
  preview(
    targetId: string,
    afterSeq: number | undefined,
  ): Promise<DesktopPreviewFrame | null>
}

export interface DesktopPreviewOptions {
  source(): DesktopPreviewSource | null
  send(frame: AgentPreviewFrame): void
  intervalMs?: number
  maxTargets?: number
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

type StartResult =
  { ok: true; width: number; height: number } | { ok: false; error: string }

interface Poll {
  lastSeq?: number
  timer: unknown
  inFlight: boolean
}

export class DesktopPreview {
  private readonly polls = new Map<string, Poll>()
  private readonly intervalMs: number
  private readonly maxTargets: number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: DesktopPreviewOptions) {
    this.intervalMs = options.intervalMs ?? 500
    this.maxTargets = options.maxTargets ?? 4
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get active(): string[] {
    return [...this.polls.keys()]
  }

  start(targetId: string): StartResult {
    if (!this.polls.has(targetId)) {
      if (this.polls.size >= this.maxTargets)
        return { ok: false, error: '同时最多预览 4 个窗口' }
      this.polls.set(targetId, { timer: null, inFlight: false })
      void this.poll(targetId)
    }
    // The size arrives with the first frame.
    return { ok: true, width: 0, height: 0 }
  }

  stop(targetId: string): void {
    const poll = this.polls.get(targetId)
    if (poll === undefined) return
    this.polls.delete(targetId)
    if (poll.timer !== null) this.clearTimer(poll.timer)
  }

  stopAll(): void {
    for (const targetId of [...this.polls.keys()]) this.stop(targetId)
  }

  private async poll(targetId: string): Promise<void> {
    const poll = this.polls.get(targetId)
    if (poll === undefined || poll.inFlight) return
    poll.inFlight = true
    try {
      const frame =
        (await this.options.source()?.preview(targetId, poll.lastSeq)) ?? null
      if (
        this.polls.get(targetId) === poll &&
        frame?.jpeg !== undefined &&
        frame.width !== undefined &&
        frame.height !== undefined &&
        frame.seq !== poll.lastSeq
      ) {
        poll.lastSeq = frame.seq
        this.options.send({
          targetId,
          seq: frame.seq,
          width: frame.width,
          height: frame.height,
          jpeg: frame.jpeg,
        })
      }
    } catch {
      // Keep polling: the helper may be restarting.
    } finally {
      poll.inFlight = false
      if (this.polls.get(targetId) === poll)
        poll.timer = this.setTimer(() => {
          poll.timer = null
          void this.poll(targetId)
        }, this.intervalMs)
    }
  }
}

export interface PreviewCapability {
  start(targetId: string): StartResult
  stop(targetId: string): void
  input(targetId: string, event: AgentPreviewInput): boolean
}

/** Desktop windows get the polled preview; input forwarding stays browser-only. */
export function routedPreview(
  browser: PreviewCapability,
  desktop: DesktopPreview,
): PreviewCapability {
  return {
    start: (targetId) =>
      DESKTOP_TARGET_ID.test(targetId)
        ? desktop.start(targetId)
        : browser.start(targetId),
    stop: (targetId) =>
      DESKTOP_TARGET_ID.test(targetId)
        ? desktop.stop(targetId)
        : browser.stop(targetId),
    input: (targetId, event) =>
      DESKTOP_TARGET_ID.test(targetId) ? false : browser.input(targetId, event),
  }
}
