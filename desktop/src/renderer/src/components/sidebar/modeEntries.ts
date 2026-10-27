// The three modes as the sidebar shows them (0.3 MOD-02,
// docs/design/modes.md): the English name (D3) with one Chinese line, the
// glyph, the ⌘1–⌘3 action, and each mode's primary row — the ⌘N button and
// the + beside it. Group's 新建群聊 waits for GRP-08; 新建联系人 opens the
// contact editor (GRP-04).
import { CodeXml, MessageSquare, Users } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { AppMode } from '../../runtime/appMode'
import type { ShortcutAction } from '../../shortcuts'
import { DsNewChat, DsPlus } from '../icons/ds'

/** What an entry that is not built yet says on hover. */
export const COMING_SOON = '即将推出'

export interface ModeAction {
  label: string
  icon: Component
  /** False: shown, marked unavailable (`aria-disabled`), 「即将推出」. */
  ready: boolean
}

export interface ModeEntry {
  mode: AppMode
  name: 'Chat' | 'Build' | 'Group'
  description: string
  icon: Component
  shortcut: Extract<ShortcutAction, `mode.${string}`>
  /** The ⌘N button of the primary row. */
  primary: ModeAction
  /** The + beside it (Chat has none). */
  secondary?: ModeAction
}

export const MODE_ENTRIES: readonly ModeEntry[] = [
  {
    mode: 'chat',
    name: 'Chat',
    description: '对话：提问、写作、调研，不绑项目',
    icon: MessageSquare,
    shortcut: 'mode.chat',
    primary: { label: '新对话', icon: DsNewChat, ready: true },
  },
  {
    mode: 'build',
    name: 'Build',
    description: '构建：在项目里写代码、调试和发布',
    icon: CodeXml,
    shortcut: 'mode.build',
    primary: { label: '新建项目会话', icon: DsNewChat, ready: true },
    secondary: { label: '打开文件夹', icon: DsPlus, ready: true },
  },
  {
    mode: 'group',
    name: 'Group',
    description: '群聊：联系人与群聊，多个 agent 协作',
    icon: Users,
    shortcut: 'mode.group',
    primary: { label: '新建群聊', icon: Users, ready: false },
    secondary: { label: '新建联系人', icon: DsPlus, ready: true },
  },
]

export function modeEntry(mode: AppMode): ModeEntry {
  return MODE_ENTRIES.find((entry) => entry.mode === mode) ?? MODE_ENTRIES[0]!
}

/** 「Emperor Chat」 and so on (D3). */
export function modeFullName(mode: AppMode): string {
  return `Emperor ${modeEntry(mode).name}`
}
