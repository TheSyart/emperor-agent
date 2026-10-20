// @vitest-environment jsdom
// UI-S02: a sidebar row shows no date; its relative time and 「⋯」 are the
// hover layer; a running session has the gold dot, one waiting for an
// answer or an approval the attention dot.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../types'
import SessionRow from './SessionRow.vue'

let app: App | null = null
let root: HTMLDivElement | null = null

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    title: '整理 0.2 发布说明',
    created_at: '2025-01-02T10:00:00Z',
    updated_at: '2025-01-02T10:00:00Z',
    preview: '',
    version: 1,
    ...patch,
  }
}

async function mount(props: Record<string, unknown>): Promise<HTMLElement> {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(() => h(SessionRow, props))
  app.mount(root)
  await nextTick()
  return root.querySelector<HTMLElement>('.session-row')!
}

afterEach(() => {
  app?.unmount()
  app = null
  root?.remove()
  root = null
})

describe('SessionRow (UI-S02)', () => {
  it('never shows a date, even for an old session (1)', async () => {
    const row = await mount({ session: session() })
    expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(row.querySelector('.time')?.textContent?.trim()).toMatch(/年$/)
  })

  it('keeps the relative time and 「⋯」 in the hover layer (2)', async () => {
    const row = await mount({
      session: session({ updated_at: new Date().toISOString() }),
    })
    const hover = row.querySelector('[data-hover-layer]')!
    expect(hover.querySelector('.time')?.textContent?.trim()).toBe('刚刚')
    expect(hover.querySelector('[aria-label="会话操作"]')).not.toBeNull()
  })

  it('marks a running session with the gold dot (3)', async () => {
    const row = await mount({ session: session(), indicator: 'running' })
    expect(row.querySelector('.ds-dot')?.getAttribute('data-state')).toBe(
      'running',
    )
  })

  it('marks a session waiting for an answer with the attention dot (4)', async () => {
    const row = await mount({
      session: session(),
      indicator: 'pending',
      pendingLabel: '等待回答',
    })
    const dot = row.querySelector('.ds-dot')
    expect(dot?.getAttribute('data-state')).toBe('attention')
  })
})
