import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Serves the recorded raw kernel log (core raw-golden.test.ts) through the
// visual bridge's `sessions.history`, root under `rootId` and children under
// their own ids. With `progressive`, history returns the log up to the first
// assistant chunk and the rest replays through `onSessionEvents` in batches.
const KERNEL_LOG = resolve(
  process.cwd(),
  '..',
  'packages/core/src/harness/projection/__golden__/kernel-turn.log.json',
)

export interface SessionLogFixtureOptions {
  rootId: string
  progressive?: { batch: number; intervalMs: number }
}

export async function installSessionLogFixture(
  page: Page,
  options: SessionLogFixtureOptions,
): Promise<void> {
  const log = JSON.parse(readFileSync(KERNEL_LOG, 'utf8')) as {
    root: {
      header: Record<string, unknown>
      events: { seq: number; type: string }[]
    }
    children: { header: { id: string }; events: { seq: number }[] }[]
  }
  await page.addInitScript(
    ({ log, rootId, progressive }) => {
      type Event = { seq: number; type: string }
      const sessions = new Map<string, { header: unknown; events: Event[] }>()
      const root = log.root.events as Event[]
      const cut = progressive
        ? Math.max(
            1,
            root.findIndex((event) => event.type === 'assistant/chunk'),
          )
        : root.length
      sessions.set(rootId, {
        header: { ...log.root.header, id: rootId },
        events: root.slice(0, cut),
      })
      for (const child of log.children)
        sessions.set(child.header.id, {
          header: child.header,
          events: child.events as Event[],
        })
      const target = window as unknown as {
        __visualSessionHistory?: (query: unknown) => unknown
        __visualEmitSessionEvents?: (batch: unknown) => void
      }
      let replaying = false
      target.__visualSessionHistory = (query) => {
        const { sessionId, beforeSeq } = query as {
          sessionId: string
          beforeSeq?: number
        }
        const session = sessions.get(sessionId)
        if (session === undefined) return undefined
        const events = session.events.filter(
          (event) => beforeSeq === undefined || event.seq < beforeSeq,
        )
        if (progressive && sessionId === rootId && !replaying) {
          replaying = true
          const rest = root.slice(cut)
          let index = 0
          const timer = setInterval(() => {
            const batch = rest.slice(index, index + progressive.batch)
            index += progressive.batch
            target.__visualEmitSessionEvents?.({
              sessionId: rootId,
              events: batch,
            })
            if (index >= rest.length) clearInterval(timer)
          }, progressive.intervalMs)
        }
        return {
          header: session.header,
          events,
          hasMore: false,
          lastSeq: session.events.at(-1)?.seq ?? -1,
        }
      }
    },
    { log, rootId: options.rootId, progressive: options.progressive ?? null },
  )
}

/** Nested subagent ids of `installNestedSubagentFixture`. */
export const NESTED_IDS = {
  root: 'build-ui',
  kid1: 'nest-kid-1',
  kid2: 'nest-kid-2',
} as const

/**
 * A depth-3 delegation chain built from the recorded kernel log:
 * `build-ui` (root turn delegating to kid 1) → kid 1 (the same root turn,
 * re-targeted to delegate to kid 2) → kid 2 (the recorded child). The
 * bridge's generic lineage walks `subagent/started` back to the root.
 */
export async function installNestedSubagentFixture(page: Page): Promise<void> {
  const log = JSON.parse(readFileSync(KERNEL_LOG, 'utf8')) as {
    root: { header: Record<string, unknown>; events: unknown[] }
    children: { header: { id: string }; events: unknown[] }[]
  }
  const childId = log.children[0]?.header.id ?? ''
  const retarget = (
    events: unknown[],
    target: string,
    description: string,
  ): unknown[] =>
    JSON.parse(
      JSON.stringify(events)
        .split(JSON.stringify(childId))
        .join(JSON.stringify(target))
        .split('"description":"research"')
        .join(`"description":${JSON.stringify(description)}`),
    ) as unknown[]
  const sessions = [
    {
      id: NESTED_IDS.root,
      header: { version: 0, createdAt: 0 },
      events: retarget(log.root.events, NESTED_IDS.kid1, '调研子任务'),
    },
    {
      id: NESTED_IDS.kid1,
      header: { version: 0, createdAt: 0, origin: 'subagent' },
      events: retarget(log.root.events, NESTED_IDS.kid2, '深入检索'),
    },
    {
      id: NESTED_IDS.kid2,
      header: { version: 0, createdAt: 0, origin: 'subagent' },
      events: log.children[0]?.events ?? [],
    },
  ]
  await page.addInitScript((entries) => {
    const register = (
      window as unknown as {
        __visualRegisterSessionLog?: (
          id: string,
          header: Record<string, unknown>,
          events: unknown[],
        ) => void
      }
    ).__visualRegisterSessionLog
    for (const entry of entries)
      register?.(entry.id, entry.header, entry.events)
  }, sessions)
}
