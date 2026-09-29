// Glyphs of the right workspace panes (launcher rows, header segments).
import {
  FileText,
  GitCompareArrows,
  Globe,
  Monitor,
  SquareTerminal,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { WorkspaceContentPane } from './workspacePanes'

export const WORKSPACE_PANE_ICONS: Record<WorkspaceContentPane, Component> = {
  review: GitCompareArrows,
  terminal: SquareTerminal,
  files: FileText,
  browser: Globe,
  desktop: Monitor,
}
