import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeRecords } from '../../router'
import { activeSidebarPage, SIDEBAR_PAGES } from './sidebarNav'

const source = (name: string) => readFileSync(join(__dirname, name), 'utf8')
const root = source('SidebarRoot.vue')
const row = source('SessionRow.vue')
const rail = source('SidebarRail.vue')
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

  it('shows unified running child counts on idle roots in every placement', () => {
    expect(root).toContain('subagents.counts[session.id]')
    expect(row).toContain('个子智能体运行中')
    expect(root).not.toContain('SidebarAgentTree')
    expect(row).not.toContain('tree-toggle')
    expect(root).not.toContain('runningSessionIds')
    expect(root).toContain('selectedRootId')
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
    // The rail's order (UI-S01); 探索 stays until UI-S08.
    expect(SIDEBAR_PAGES.map((entry) => entry.label)).toEqual([
      '定时任务',
      '能力',
      '探索',
      'Pull Request',
    ])
    expect(
      SIDEBAR_PAGES.filter((entry) => entry.github).map((entry) => entry.name),
    ).toEqual(['pulls'])
  })

  it('highlights a page entry only on its own route', () => {
    expect(activeSidebarPage('scheduler')).toBe('scheduler')
    expect(activeSidebarPage('capabilities')).toBe('capabilities')
    // The GitHub plugin's Issue and CI tabs sit under Pull Request.
    expect(activeSidebarPage('github-issues')).toBe('pulls')
    expect(activeSidebarPage('github-ci')).toBe('pulls')
    expect(activeSidebarPage('chat')).toBeNull()
    expect(activeSidebarPage('hasOwnProperty')).toBeNull()
    expect(activeSidebarPage(undefined)).toBeNull()
  })

  it('keeps back / forward on the shared nav history shortcuts (no buttons since UI-S01)', () => {
    const app = readFileSync(join(__dirname, '../../App.vue'), 'utf8')
    expect(app).toContain("'nav.back': () => goBack(router)")
    expect(app).toContain("'nav.forward': () => goForward(router)")
    expect(rail).not.toContain('goBack')
  })

  it('loads the notification popover as its own chunk', () => {
    expect(bell).toContain("import('./NotificationsPopover.vue')")
    expect(bell).not.toMatch(/^import NotificationsPopover/m)
  })

  it('keeps the brand bar display-only with the collapse button', () => {
    const brand = source('SidebarBrandRow.vue')
    expect(brand).not.toContain('<Menu')
    expect(brand).not.toContain('aria-haspopup')
    expect(brand).toContain('label="收起侧栏"')
    // The theme is chosen in 设置 › 常规 (the sidebar toggle is gone).
    expect(root).not.toContain('useTheme')
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
