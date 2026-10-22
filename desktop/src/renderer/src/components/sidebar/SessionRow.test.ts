// @vitest-environment jsdom
// UI-S11: a sidebar row shows a compact relative time (never an ISO date)
// that hover swaps for 「⋯」; a running session has the gold dot, one
// waiting for an answer or an approval the attention dot.
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
    created_at: '2025-01-02T10:00:00',
    updated_at: '2025-01-02T10:00:00',
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

describe('SessionRow (UI-S11)', () => {
  it('shows a compact time, never an ISO date (6)', async () => {
    const row = await mount({ session: session() })
    expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(row.querySelector('.time')?.textContent?.trim()).toBe('2025/1/2')
    expect(row.querySelector('[aria-label="会话操作"]')).not.toBeNull()
    expect(row.getAttribute('data-session-id')).toBe('s1')
  })

  it('marks a running session with the gold dot (6)', async () => {
    const row = await mount({ session: session(), indicator: 'running' })
    expect(row.querySelector('.ds-dot')?.getAttribute('data-state')).toBe(
      'running',
    )
  })

  it('marks a session waiting for an answer with the attention dot (6)', async () => {
    const row = await mount({
      session: session(),
      indicator: 'pending',
      pendingLabel: '等待回答',
    })
    expect(row.querySelector('.ds-dot')?.getAttribute('data-state')).toBe(
      'attention',
    )
  })
})
