import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { installVisualCoreBridge } from './visualBridge'
import {
  longMarkdownReply,
  longSessionLog,
  messageDelta,
  streamChunks,
  type LongSession,
} from '../../src/renderer/src/conversation/testing/streaming'

// FIX-04 streaming budgets, measured with a Chromium trace of the real app
// (fake bridge): a 500-turn session (`build-ui`) streams its answer as raw
// `assistant/chunk` batches every 16 ms (the main-process cadence) plus one
// `message_delta` runtime event per chunk, each its own task.
// - 6: main-thread script time per frame (16.7 ms windows, i.e. 60 Hz
//   frames), p95 < 8 ms;
// - 7: a completed block stays selected while the reply keeps growing;
// - 8: a 50 KB reply streams at more than 50 fps.
// 6 and 8 also run on a 4× slower CPU (DevTools CPU throttling), where they
// must stay above 50 fps. Measurements land in
// screenshots/streaming/perf-*.json.
// 6 and 8 measure wall-clock time and carry the @perf tag: the nightly runs
// them alone on one worker after the rest of the suite (`visual:perf`, one
// retry of what failed); they failed when other workers shared the CPU.
// 7 measures nothing and stays in the main run.
//
// FIX-17: the budgets hold on a Mac. A shared CI runner (three virtual CPUs,
// no GPU, other jobs on the host) cannot promise 60 Hz frames, so the
// nightly sets EMPEROR_PERF_BUDGETS=report: the numbers are still measured
// and recorded, a budget they miss is annotated and logged, and the test
// does not fail on it. Unset or `enforce`, a missed budget fails as before.
const PERF_BUDGETS = process.env.EMPEROR_PERF_BUDGETS ?? 'enforce'
if (!['enforce', 'report'].includes(PERF_BUDGETS))
  throw new Error(
    `EMPEROR_PERF_BUDGETS must be enforce or report, not ${PERF_BUDGETS}`,
  )
const outDir = resolve(process.cwd(), 'screenshots', 'streaming')
const SESSION = 'build-ui'
const FRAME_MS = 1000 / 60

test.beforeAll(() => {
  mkdirSync(outDir, { recursive: true })
})

interface TraceEvent {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
}

/** Script entry points on the renderer main thread (nested ones skipped). */
const SCRIPT_EVENTS = new Set([
  'FunctionCall',
  'EvaluateScript',
  'TimerFire',
  'FireAnimationFrame',
  'EventDispatch',
  'RunMicrotasks',
  'V8.Execute',
  'v8.run',
  'v8.callFunction',
  'FireIdleCallback',
])

interface FrameReport {
  frames: number
  scriptP50: number
  scriptP95: number
  scriptMax: number
  longFrames: number
  mainFrames: number
  traceFps: number
  rafFps: number
  rafDropped: number
  durationMs: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function analyzeTrace(
  events: TraceEvent[],
  raf: number[],
): Omit<FrameReport, never> {
  const start = events.find((event) => event.name === 'fix04-stream-start')
  const end = events.find((event) => event.name === 'fix04-stream-end')
  if (!start || !end) throw new Error('stream marks missing from the trace')
  const { pid, tid } = start
  const from = start.ts
  const to = end.ts
  const main = events.filter(
    (event) => event.pid === pid && event.tid === tid && event.ph === 'X',
  )
  const scripts = main
    .filter((event) => SCRIPT_EVENTS.has(event.name) && event.dur !== undefined)
    .sort((a, b) => a.ts - b.ts)
  const top: TraceEvent[] = []
  let reach = -Infinity
  for (const event of scripts) {
    if (event.ts < reach) continue
    top.push(event)
    reach = event.ts + (event.dur ?? 0)
  }
  const windowUs = FRAME_MS * 1000
  const count = Math.max(1, Math.floor((to - from) / windowUs))
  const perFrame = new Array<number>(count).fill(0)
  for (const event of top) {
    const s = Math.max(from, event.ts)
    const e = Math.min(to, event.ts + (event.dur ?? 0))
    if (e <= s) continue
    for (
      let index = Math.floor((s - from) / windowUs);
      index < count && from + index * windowUs < e;
      index++
    ) {
      const ws = from + index * windowUs
      const we = ws + windowUs
      perFrame[index]! += (Math.min(e, we) - Math.max(s, ws)) / 1000
    }
  }
  const mainFrames = events.filter(
    (event) =>
      event.name === 'BeginMainThreadFrame' &&
      event.pid === pid &&
      event.ts >= from &&
      event.ts <= to,
  ).length
  const durationMs = (to - from) / 1000
  const rafGaps = raf.slice(1).map((value, index) => value - raf[index]!)
  return {
    frames: count,
    scriptP50: round(percentile(perFrame, 50)),
    scriptP95: round(percentile(perFrame, 95)),
    scriptMax: round(Math.max(...perFrame)),
    longFrames: perFrame.filter((value) => value > FRAME_MS).length,
    mainFrames,
    traceFps: round((mainFrames / durationMs) * 1000),
    rafFps:
      raf.length > 1
        ? round(((raf.length - 1) / (raf.at(-1)! - raf[0]!)) * 1000)
        : 0,
    rafDropped: rafGaps.filter((gap) => gap > FRAME_MS * 1.5).length,
    durationMs: round(durationMs),
  }
}

/** The open turn's answer row (virtual rows are not in DOM order). */
function streamingAnswer(page: Page, session: LongSession) {
  return page.locator(
    `[data-chat-turn="${session.openTurn}"][data-chat-flow-kind="assistant"]`,
  )
}

async function openLongSession(page: Page): Promise<LongSession> {
  const session = longSessionLog(500)
  await installVisualCoreBridge(page, {
    sessionLogs: [
      {
        id: SESSION,
        header: { version: 0, id: SESSION, createdAt: 1_760_000_000_000 },
        events: session.events as unknown as Array<{
          seq: number
          type: string
        }>,
      },
    ],
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/chat/${SESSION}?visualTheme=dark`)
  await expect(page.locator('.conversation-root')).toHaveAttribute(
    'data-phase',
    'active',
  )
  await expect(
    page.locator('[data-chat-flow-kind="user"]').last(),
  ).toBeVisible()
  // The turn is running in the runtime pipeline too (sidebar row, busy).
  await page.evaluate((sessionId) => {
    const emit = (
      window as unknown as { __visualEmitCoreEvent?: (event: unknown) => void }
    ).__visualEmitCoreEvent
    emit?.({
      event: 'turn_phase',
      seq: 16,
      session_id: sessionId,
      turn_id: `${sessionId}:501`,
      phase: 'started',
    })
  }, SESSION)
  await page.waitForTimeout(500)
  return session
}

/**
 * Stream `text` into the open turn: `perFrame` chunks of `size` characters
 * every 16 ms, each chunk also as a `message_delta` task. Resolves with the
 * rAF timestamps seen while streaming.
 */
async function stream(
  page: Page,
  session: LongSession,
  text: string,
  options: { size: number; perFrame: number; during?: () => Promise<void> },
): Promise<number[]> {
  const events = streamChunks(session, text, options.size)
  const deltas = events.map((chunk) =>
    messageDelta(SESSION, chunk, session.openTurn),
  )
  // Plain JSON for the page (the wire event types are too deep to infer).
  const chunks = JSON.parse(JSON.stringify(events)) as unknown[]
  const done = page.evaluate(
    ({ chunks, deltas, perFrame, sessionId }) =>
      new Promise<number[]>((resolveStream) => {
        const target = window as unknown as {
          __visualEmitSessionEvents?: (batch: unknown) => void
          __visualEmitCoreEvent?: (event: unknown) => void
        }
        const raf: number[] = []
        let streaming = true
        const loop = (time: number): void => {
          raf.push(time)
          if (streaming) requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
        performance.mark('fix04-stream-start')
        let index = 0
        const timer = setInterval(() => {
          const batch = chunks.slice(index, index + perFrame)
          const runtime = deltas.slice(index, index + perFrame)
          index += perFrame
          target.__visualEmitSessionEvents?.({ sessionId, events: batch })
          for (const event of runtime)
            setTimeout(() => target.__visualEmitCoreEvent?.(event), 0)
          if (index >= chunks.length) {
            clearInterval(timer)
            // Let the last throttled render land before the end mark.
            setTimeout(() => {
              performance.mark('fix04-stream-end')
              streaming = false
              resolveStream(raf)
            }, 200)
          }
        }, 16)
      }),
    { chunks, deltas, perFrame: options.perFrame, sessionId: SESSION },
  )
  if (options.during) await options.during()
  return done
}

/** Chromium CPU slowdown (1 = none), to stand in for a slower Mac. */
async function throttleCpu(page: Page, rate: number): Promise<void> {
  if (rate <= 1) return
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setCPUThrottlingRate', { rate })
}

async function traced<T>(
  browser: Browser,
  page: Page,
  run: () => Promise<T>,
): Promise<{ result: T; events: TraceEvent[] }> {
  await browser.startTracing(page, {
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
      'v8.execute',
    ],
  })
  const result = await run()
  const buffer = await browser.stopTracing()
  const trace = JSON.parse(buffer.toString('utf8')) as
    { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = Array.isArray(trace) ? trace : trace.traceEvents
  return { result, events }
}

/** A wall-clock budget: enforced, or with EMPEROR_PERF_BUDGETS=report only reported. */
function budget(what: string, check: () => void): void {
  if (PERF_BUDGETS === 'enforce') {
    check()
    return
  }
  try {
    check()
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    test.info().annotations.push({
      type: 'perf-budget-missed',
      description: `${what}: ${detail}`,
    })
    console.log(`[FIX-17] budget missed, reported only: ${what}: ${detail}`)
  }
}

function record(name: string, report: Record<string, unknown>): void {
  writeFileSync(
    resolve(outDir, `perf-${name}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(`[FIX-04] ${name}`, JSON.stringify(report))
}

test(
  '6 · streaming into a 500-turn session: script per frame p95 < 8 ms',
  { tag: '@perf' },
  async ({ page, browser }) => {
    test.setTimeout(240_000)
    const session = await openLongSession(page)
    const reply = longMarkdownReply(4_000)
    const { result: raf, events } = await traced(browser, page, () =>
      stream(page, session, reply, { size: 4, perFrame: 2 }),
    )
    const report = analyzeTrace(events, raf)
    record('500-turns-cpu1', { ...report, cpu: 1, replyChars: reply.length })
    await expect(streamingAnswer(page, session)).toContainText('第 1 部分')
    expect(report.frames).toBeGreaterThan(100)
    budget('script per frame p95 < 8 ms', () =>
      expect(report.scriptP95).toBeLessThan(8),
    )
  },
)

// The same stream on a 4× slower CPU (a stand-in for an older Mac): the
// numbers go to the receipt's before/after table; it must keep its frames.
test(
  '6 · streaming into a 500-turn session keeps its frames on a 4× slower CPU',
  { tag: '@perf' },
  async ({ page, browser }) => {
    test.setTimeout(240_000)
    const session = await openLongSession(page)
    await throttleCpu(page, 4)
    const reply = longMarkdownReply(4_000)
    const { result: raf, events } = await traced(browser, page, () =>
      stream(page, session, reply, { size: 4, perFrame: 2 }),
    )
    const report = analyzeTrace(events, raf)
    record('500-turns-cpu4', { ...report, cpu: 4, replyChars: reply.length })
    budget('> 50 fps on a 4× slower CPU', () =>
      expect(report.traceFps).toBeGreaterThan(50),
    )
  },
)

test('7 · a completed block stays selected while the reply grows', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const session = await openLongSession(page)
  // Prose only: every block shares one Markdown segment with the tail.
  const reply = Array.from(
    { length: 40 },
    (_, index) =>
      `第 ${index + 1} 段：读取路径会先比较版本号，再决定是否信任缓存的结果；版本落后就丢掉这一项重新读取，并发写入以最后一次提交为准。`,
  ).join('\n\n')
  const answer = streamingAnswer(page, session)
  let selected = ''
  let after = ''
  let grewBy = 0
  await stream(page, session, reply, {
    size: 4,
    perFrame: 1,
    during: async () => {
      const first = answer.locator('.ds-md-html p').first()
      await expect(first).toHaveText(/^第 1 段/u, { timeout: 15_000 })
      // Wait until the paragraph is a completed block (two more follow).
      await expect(answer.locator('.ds-md-html p').nth(2)).toBeAttached({
        timeout: 15_000,
      })
      await first.click({ clickCount: 3 })
      selected = await page.evaluate(
        () => window.getSelection()?.toString() ?? '',
      )
      const before = (await answer.textContent())?.length ?? 0
      await page.waitForTimeout(1500)
      grewBy = ((await answer.textContent())?.length ?? 0) - before
      after = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    },
  })
  record('selection', { selected, after, grewBy })
  expect(selected).toContain('第 1 段')
  expect(grewBy).toBeGreaterThan(100)
  expect(after).toBe(selected)
})

for (const cpu of [1, 4]) {
  test(
    `8 · a 50 KB reply streams without dropping frames, > 50 fps (CPU ×${cpu})`,
    { tag: '@perf' },
    async ({ page, browser }) => {
      test.setTimeout(300_000)
      const session = await openLongSession(page)
      await throttleCpu(page, cpu)
      const reply = longMarkdownReply(50_000)
      const { result: raf, events } = await traced(browser, page, () =>
        stream(page, session, reply, { size: 40, perFrame: 2 }),
      )
      const report = analyzeTrace(events, raf)
      record(`50kb-cpu${cpu}`, {
        ...report,
        cpu,
        replyChars: reply.length,
        replyBytes: Buffer.byteLength(reply, 'utf8'),
      })
      expect(Buffer.byteLength(reply, 'utf8')).toBeGreaterThanOrEqual(50_000)
      const fps = report.mainFrames > 0 ? report.traceFps : report.rafFps
      budget(`50 KB reply > 50 fps (CPU ×${cpu})`, () =>
        expect(fps).toBeGreaterThan(50),
      )
    },
  )
}
