import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeRecords } from '../../router'
import { activeSidebarPage, SIDEBAR_PAGES } from './sidebarNav'

const source = (name: string) => readFileSync(join(__dirname, name), 'utf8')
const root = source('SidebarRoot.vue')
const row = source('SessionRow.vue')
const rail = source('SidebarRail.vue')
const topRow = source('SidebarTopRow.vue')
const bell = source('SidebarBell.vue')
const layoutState = source('useSidebarState.ts')

describe('sidebar deletion safeguards and navigation', () => {
  it('disables deletion of the last persisted session and reports Core failures', () => {
    expect(root).toContain('canDeletePersistedSession')
    expect(root).toContain('sessionActionError')
    expect(root).toContain(
      'Boolean(session.draft) || canDeletePersistedSession',
    )
    expect(row).toContain(':disabled="!canDelete"')
    expect(root).toContain('ctx.showToast')
  })

  it('navigates through the /chat/:sessionId route instead of activating directly', () => {
    expect(root).toContain('router.push(sessionLocation(id))')
    expect(root).not.toContain('activate(')
  })

  it('shows running subagent counts from sessions.children', () => {
    expect(root).toContain('subagents.counts[session.id]')
    expect(row).toContain('个子代理运行中')
  })
})

describe('sidebar pins', () => {
  it('offers 置顶 / 取消置顶 on every session row and sends pins with each patch', () => {
    expect(row).toContain("pinned ? '取消置顶' : '置顶'")
    expect(root.match(/@pin="layout\.togglePin\(session\.id\)"/g)).toHaveLength(
      3,
    )
    expect(layoutState).toContain('pinned_session_ids: next.pinned_session_ids')
  })
})

describe('sidebar nav', () => {
  it('points every page entry at a named route', () => {
    const names = new Set(routeRecords.map((record) => record.name))
    for (const entry of SIDEBAR_PAGES) expect(names.has(entry.name)).toBe(true)
    expect(SIDEBAR_PAGES.map((entry) => entry.label)).toEqual([
      'Pull Request',
      '定时任务',
      '能力',
      '探索',
    ])
  })

  it('highlights a page entry only on its own route', () => {
    expect(activeSidebarPage('scheduler')).toBe('scheduler')
    expect(activeSidebarPage('capabilities')).toBe('capabilities')
    expect(activeSidebarPage('chat')).toBeNull()
    expect(activeSidebarPage(undefined)).toBeNull()
  })

  it('reuses the shared nav history for back / forward', () => {
    for (const text of [topRow, rail]) {
      expect(text).toContain('useNavHistory()')
      expect(text).toContain('goBack(router)')
      expect(text).toContain('goForward(router)')
    }
  })

  it('loads the notification popover as its own chunk', () => {
    expect(bell).toContain("import('./NotificationsPopover.vue')")
    expect(bell).not.toMatch(/^import NotificationsPopover/m)
  })

  it('keeps the brand row display-only and the footer theme toggle', () => {
    const brand = source('SidebarBrandRow.vue')
    const footer = source('SidebarFooter.vue')
    expect(brand).not.toContain('<Menu')
    expect(brand).not.toContain('aria-haspopup')
    expect(footer).toContain('useTheme()')
    expect(footer).toContain('@click="toggle()"')
    expect(footer).not.toContain('openExternal')
  })
})

describe('App notification wiring', () => {
  it('feeds live runtime notices through the attention policy into the bell', () => {
    const app = readFileSync(join(__dirname, '../../App.vue'), 'utf8')
    expect(app).toContain('onNotify: (notice) => notifyFromRuntime(notice)')
    expect(app).toContain('notificationFromNotice(notice, {')
    expect(app).toContain('notifications.markSessionRead(')
  })
})
