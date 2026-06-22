// Central icon layer. Replaces the former pixel-art PNG assets with lucide
// line icons. All exports are Vue components (lucide-vue-next) that inherit
// currentColor, so they theme automatically. Render with <component :is="..." />.
import {
  MessageSquare,
  Cpu,
  Coins,
  Sparkles,
  Wrench,
  Users,
  Clock,
  Settings,
  Plug,
  Database,
  Paperclip,
  Eraser,
  Copy,
  Plus,
  RotateCw,
  Save,
  ArrowUp,
  ChevronDown,
  ShieldQuestion,
  Zap,
  ClipboardList,
  LoaderCircle,
  CircleAlert,
  Circle,
  Terminal,
  FileText,
  FilePen,
  FolderSearch,
  Search,
  BookOpen,
  ListTodo,
  Globe,
  Bot,
  Boxes,
  Type,
  Eye,
  CircleCheck,
  CircleX,
  Brain,
  Inbox,
  File as FileIcon,
  Image as ImageIcon,
  FileType,
  User,
  Hexagon,
} from 'lucide-vue-next'
import type { Component } from 'vue'

export type IconComponent = Component

// Neutral brand mark (replaces the pixel seal logo).
export const brandIcon: IconComponent = Hexagon

// ── Navigation ──────────────────────────────────────────────────────────────
export const navIconMap: Record<string, IconComponent> = {
  chat: MessageSquare,
  model: Cpu,
  tokens: Coins,
  skills: Sparkles,
  tools: Wrench,
  team: Users,
  scheduler: Clock,
  configs: Settings,
  mcp: Plug,
  memory: Database,
}

export function navIcon(name: string): IconComponent {
  return navIconMap[name] ?? MessageSquare
}

// ── Actions / status / modes ────────────────────────────────────────────────
export const actionIcons = {
  attach: Paperclip,
  clear: Eraser,
  copy: Copy,
  new: Plus,
  refresh: RotateCw,
  save: Save,
  send: ArrowUp,
  caretDown: ChevronDown,
  modeAskBeforeEdit: ShieldQuestion,
  modeAuto: Zap,
  modePlan: ClipboardList,
  statusBusy: LoaderCircle,
  statusError: CircleAlert,
  statusOnline: Circle,
} satisfies Record<string, IconComponent>

export function modeIcon(mode: string): IconComponent {
  if (mode === 'auto') return Zap
  if (mode === 'plan') return ClipboardList
  return ShieldQuestion
}

// ── Tools ───────────────────────────────────────────────────────────────────
export const toolIconMap = {
  default: Boxes,
  edit: FilePen,
  glob: FolderSearch,
  grep: Search,
  read: BookOpen,
  shell: Terminal,
  skill: Sparkles,
  subagent: Bot,
  todo: ListTodo,
  web: Globe,
  write: FileText,
} satisfies Record<string, IconComponent>

export function toolIcon(name: string): IconComponent {
  const lower = name.toLowerCase()
  if (lower.includes('dispatch') || lower.includes('subagent')) return toolIconMap.subagent
  if (lower.includes('team') || lower.includes('teammate') || lower.includes('broadcast')) return toolIconMap.subagent
  if (lower.includes('todo')) return toolIconMap.todo
  if (lower.includes('grep')) return toolIconMap.grep
  if (lower.includes('glob')) return toolIconMap.glob
  if (lower.includes('read')) return toolIconMap.read
  if (lower.includes('write')) return toolIconMap.write
  if (lower.includes('edit')) return toolIconMap.edit
  if (lower.includes('skill')) return toolIconMap.skill
  if (lower.includes('web') || lower.includes('fetch')) return toolIconMap.web
  if (lower.includes('run') || lower.includes('command') || lower.includes('shell')) return toolIconMap.shell
  return toolIconMap.default
}

// ── Model capability ────────────────────────────────────────────────────────
export const modelIcons = {
  text: Type,
  vision: Eye,
  testOk: CircleCheck,
  testFail: CircleX,
} satisfies Record<string, IconComponent>

// ── Empty states ────────────────────────────────────────────────────────────
export const emptyIcons = {
  memory: Brain,
  skills: Sparkles,
  tools: Wrench,
  welcome: Inbox,
} satisfies Record<string, IconComponent>

// ── Avatars (neutral) ───────────────────────────────────────────────────────
export const avatarIcons = {
  emperor: User,
  eunuch: Bot,
  subagent: Boxes,
} satisfies Record<string, IconComponent>

// ── Attachments ─────────────────────────────────────────────────────────────
export function attachmentIcon(kind: string, mime?: string, name?: string): IconComponent {
  const lowerMime = (mime || '').toLowerCase()
  const lowerName = (name || '').toLowerCase()
  if (kind === 'image' || lowerMime.startsWith('image/')) return ImageIcon
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return FileType
  if (
    lowerMime.includes('markdown') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerName.endsWith('.mdx')
  ) return FileText
  if (
    kind === 'text' ||
    lowerMime.startsWith('text/') ||
    lowerMime.includes('json') ||
    lowerName.endsWith('.json') ||
    lowerName.endsWith('.csv') ||
    lowerName.endsWith('.txt')
  ) return FileText
  return FileIcon
}
