import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeRecords } from '../../router'
import {
  activeSidebarPage,
  SIDEBAR_PAGES,
  visibleSidebarPages,
} from './sidebarNav'

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
    // 探索 is part of 能力 since UI-S08; Pull Request needs the GitHub plugin.
    expect(SIDEBAR_PAGES.map((entry) => entry.label)).toEqual([
      'Pull Request',
      '定时任务',
      '能力',
    ])
    expect(SIDEBAR_PAGES.filter((entry) => entry.github)).toHaveLength(1)
  })

  it('shows Pull Request in Build only, and only with the GitHub plugin on (D4)', () => {
    const github = [
      { pluginId: 'github', effective: true, activation: 'active' },
    ] as Parameters<typeof visibleSidebarPages>[0]
    const names = (...args: Parameters<typeof visibleSidebarPages>) =>
      visibleSidebarPages(...args).map((entry) => entry.name)
    expect(names(github, 'build')).toEqual([
      'pulls',
      'scheduler',
      'capabilities',
    ])
    expect(names([], 'build')).toEqual(['scheduler', 'capabilities'])
    expect(names(github, 'chat')).toEqual(['scheduler', 'capabilities'])
    expect(names(github, 'group')).toEqual(['scheduler', 'capabilities'])
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

  it('makes the brand row the mode switcher and keeps the footer theme toggle (MOD-02)', () => {
    const brand = source('SidebarBrandRow.vue')
    const switcher = source('ModeSwitcher.vue')
    const menu = source('ModeMenu.vue')
    const footer = source('SidebarFooter.vue')
    expect(brand).toContain('<ModeSwitcher')
    // The switcher's menu (its own chunk since MOD-05) is the shared
    // primitive, its rows radio items.
    expect(switcher).toContain('<ModeMenu')
    expect(switcher).toContain('aria-haspopup="menu"')
    expect(menu).toContain('<Menu')
    expect(menu).toContain('radio')
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
