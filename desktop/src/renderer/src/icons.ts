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
  Brain,
  Inbox,
  File as FileIcon,
  Image as ImageIcon,
  FileType,
  X,
  Cat,
  Target,
  Play,
  ArrowDownToLine,
  Square,
  Ellipsis,
} from 'lucide-vue-next'
import type { Component } from 'vue'

export type IconComponent = Component

// ── Navigation ──────────────────────────────────────────────────────────────
export const navIconMap: Record<string, IconComponent> = {
  chat: MessageSquare,
  model: Cpu,
  tokens: Coins,
  skills: Sparkles,
  tools: Wrench,
  team: Users,
  project: ClipboardList,
  scheduler: Clock,
  configs: Settings,
  mcp: Plug,
  memory: Database,
  pet: Cat,
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
  stop: Square,
  close: X,
  caretDown: ChevronDown,
  modeAskBeforeEdit: ShieldQuestion,
  modeAcceptEdits: FilePen,
  modeAuto: Zap,
  modePlan: ClipboardList,
  statusBusy: LoaderCircle,
  statusError: CircleAlert,
  statusOnline: Circle,
  queue: Inbox,
  edit: FilePen,
  interject: ArrowDownToLine,
  remove: X,
  more: Ellipsis,
  commandNew: MessageSquare,
  commandCompact: Eraser,
  commandModel: Cpu,
  commandReasoning: Brain,
  commandPermissions: ShieldQuestion,
  commandPlan: ClipboardList,
  commandGoal: Target,
  commandContinue: Play,
} satisfies Record<string, IconComponent>

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
  if (lower === 'bash' || lower === 'pwsh' || lower.startsWith('job_'))
    return toolIconMap.shell
  if (
    lower.includes('subagent') ||
    lower.includes('agent') ||
    lower === 'send_message' ||
    lower === 'report'
  )
    return toolIconMap.subagent
  if (lower.includes('todo')) return toolIconMap.todo
  if (lower.includes('grep')) return toolIconMap.grep
  if (lower.includes('glob')) return toolIconMap.glob
  if (lower.includes('read')) return toolIconMap.read
  if (lower.includes('write')) return toolIconMap.write
  if (lower.includes('edit')) return toolIconMap.edit
  if (lower.includes('skill')) return toolIconMap.skill
  if (lower.includes('web') || lower.includes('fetch')) return toolIconMap.web
  if (
    lower.includes('run') ||
    lower.includes('command') ||
    lower.includes('shell')
  )
    return toolIconMap.shell
  return toolIconMap.default
}

// ── Attachments ─────────────────────────────────────────────────────────────
export function attachmentIcon(
  kind: string,
  mime?: string,
  name?: string,
): IconComponent {
  const lowerMime = (mime || '').toLowerCase()
  const lowerName = (name || '').toLowerCase()
  if (kind === 'image' || lowerMime.startsWith('image/')) return ImageIcon
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf'))
    return FileType
  if (
    lowerMime.includes('markdown') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerName.endsWith('.mdx')
  )
    return FileText
  if (
    kind === 'text' ||
    lowerMime.startsWith('text/') ||
    lowerMime.includes('json') ||
    lowerName.endsWith('.json') ||
    lowerName.endsWith('.csv') ||
    lowerName.endsWith('.txt')
  )
    return FileText
  return FileIcon
}
