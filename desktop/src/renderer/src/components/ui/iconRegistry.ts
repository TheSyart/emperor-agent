import type { Component } from 'vue'
import {
  ArrowDownToLine,
  BookOpen,
  Bot,
  Brain,
  CircleAlert,
  ClipboardList,
  Coins,
  Cpu,
  Database,
  Ellipsis,
  Eraser,
  File as FileGlyph,
  FilePen,
  FileText,
  FolderSearch,
  Image as ImageGlyph,
  Inbox,
  ListTodo,
  MessageSquare,
  Play,
  Plug,
  RotateCw,
  Save,
  Server,
  ShieldQuestion,
  Sparkles,
  Square,
  Target,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-vue-next'
import * as Ds from '../icons/ds'

/**
 * The one icon registry (DS-03): the Ds glyphs plus the lucide icons the
 * app uses, under kebab-case names. A Ds glyph wins a name clash. New code
 * renders <Icon name="…" size="sm|md|lg|xs" />.
 */
export const ICON_SIZES = { xs: 12, sm: 14, md: 16, lg: 20 } as const
export type IconSize = keyof typeof ICON_SIZES

const LUCIDE: Record<string, Component> = {
  'arrow-down-to-line': ArrowDownToLine,
  'book-open': BookOpen,
  bot: Bot,
  brain: Brain,
  'circle-alert': CircleAlert,
  'clipboard-list': ClipboardList,
  coins: Coins,
  cpu: Cpu,
  database: Database,
  ellipsis: Ellipsis,
  eraser: Eraser,
  file: FileGlyph,
  'file-pen': FilePen,
  'file-text': FileText,
  'folder-search': FolderSearch,
  image: ImageGlyph,
  inbox: Inbox,
  'list-todo': ListTodo,
  'message-square': MessageSquare,
  play: Play,
  plug: Plug,
  'rotate-cw': RotateCw,
  save: Save,
  server: Server,
  'shield-question': ShieldQuestion,
  sparkles: Sparkles,
  square: Square,
  target: Target,
  users: Users,
  wrench: Wrench,
  x: X,
  zap: Zap,
}

function kebab(name: string): string {
  return name
    .replace(/^Ds/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

const DS: Record<string, Component> = Object.fromEntries(
  Object.entries(Ds).map(([name, component]) => [
    kebab(name),
    component as Component,
  ]),
)

const REGISTRY: Record<string, { component: Component; lucide: boolean }> = {
  ...Object.fromEntries(
    Object.entries(LUCIDE).map(([name, component]) => [
      name,
      { component, lucide: true },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(DS).map(([name, component]) => [
      name,
      { component, lucide: false },
    ]),
  ),
}

export function iconNames(): string[] {
  return Object.keys(REGISTRY).sort()
}

export function resolveIcon(
  name: string,
): { component: Component; lucide: boolean } | undefined {
  return REGISTRY[name]
}
