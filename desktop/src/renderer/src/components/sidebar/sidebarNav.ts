// Sidebar page entries (expanded nav rows + rail icons) and their glyphs.
// 探索 is part of 能力 since UI-S08; Pull Request shows only while the
// GitHub plugin is on.
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Blocks,
  Clock,
  GitPullRequest,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { githubPluginOn } from '../pages/github/githubPlugin'

export interface SidebarPageEntry {
  /** Route name the row highlights for (router.ts). */
  name: 'pulls' | 'scheduler' | 'capabilities'
  label: string
  to: RouteLocationRaw
  icon: Component
  /** Shown only while the GitHub plugin is in effect and active. */
  github?: true
}

export const SIDEBAR_PAGES: readonly SidebarPageEntry[] = [
  {
    name: 'pulls',
    label: 'Pull Request',
    to: { name: 'pulls' },
    icon: GitPullRequest,
    github: true,
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
]

/** The page entries to show with these plugins (Pull Request needs GitHub). */
export function visibleSidebarPages(
  plugins: Parameters<typeof githubPluginOn>[0],
): SidebarPageEntry[] {
  const github = githubPluginOn(plugins)
  return SIDEBAR_PAGES.filter((entry) => !entry.github || github)
}

/** Pages reached from another entry: the GitHub plugin's tabs live under Pull Request. */
const PAGE_OWNERS: Readonly<Record<string, SidebarPageEntry['name']>> = {
  'github-issues': 'pulls',
  'github-ci': 'pulls',
}

/** The page entry `routeName` belongs to (null on conversation routes). */
export function activeSidebarPage(
  routeName: unknown,
): SidebarPageEntry['name'] | null {
  if (typeof routeName === 'string' && Object.hasOwn(PAGE_OWNERS, routeName))
    return PAGE_OWNERS[routeName]!
  return SIDEBAR_PAGES.find((entry) => entry.name === routeName)?.name ?? null
}

export const SIDEBAR_ICONS = {
  back: ArrowLeft,
  forward: ArrowRight,
  bell: Bell,
} satisfies Record<string, Component>
