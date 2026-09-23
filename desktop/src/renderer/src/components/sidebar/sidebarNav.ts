// Sidebar page entries (expanded nav rows + rail icons) and their glyphs.
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Blocks,
  Clock,
  Compass,
  GitPullRequest,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

export interface SidebarPageEntry {
  /** Route name the row highlights for (router.ts). */
  name: 'pulls' | 'scheduler' | 'capabilities' | 'explore'
  label: string
  to: RouteLocationRaw
  icon: Component
}

export const SIDEBAR_PAGES: readonly SidebarPageEntry[] = [
  {
    name: 'pulls',
    label: 'Pull Request',
    to: { name: 'pulls' },
    icon: GitPullRequest,
  },
  {
    name: 'scheduler',
    label: '定时任务',
    to: { name: 'scheduler' },
    icon: Clock,
  },
  {
    name: 'capabilities',
    label: '能力',
    to: { name: 'capabilities' },
    icon: Blocks,
  },
  { name: 'explore', label: '探索', to: { name: 'explore' }, icon: Compass },
]

/** The page entry `routeName` belongs to (null on conversation routes). */
export function activeSidebarPage(
  routeName: unknown,
): SidebarPageEntry['name'] | null {
  return SIDEBAR_PAGES.find((entry) => entry.name === routeName)?.name ?? null
}

export const SIDEBAR_ICONS = {
  back: ArrowLeft,
  forward: ArrowRight,
  bell: Bell,
} satisfies Record<string, Component>
