/**
 * The 工具 of a plugin's detail (plugin contract §6.2, PLAN-CAP-001 ST-09).
 *
 * Computer Use lists its GUI tools by driver — 通用, 内置浏览器, Chrome 和
 * Edge, Mac 应用 — whether or not it is on: they are Emperor's own
 * definitions, and the note says when they cannot be used. Any other plugin
 * lists each MCP member's tools, which exist only while its server runs; a
 * member whose server does not run says so instead.
 */

import type {
  PluginComponentView,
  PluginRuntimeView,
  PluginScope,
  PluginToolGroup,
  PluginToolsView,
} from './models'

/** Computer Use's groups, in order: the tools of every driver, then one per driver. */
const COMPUTER_USE_GROUPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'ui', title: '通用' },
  { id: 'embedded-browser', title: '内置浏览器' },
  { id: 'external-browser', title: 'Chrome 和 Edge' },
  { id: 'desktop', title: 'Mac 应用' },
]

export function pluginToolsView(input: {
  readonly pluginId: string
  readonly scope: PluginScope
  /** Computer Use's switch when this is its package (`null`: not on this machine). */
  readonly computerUse?: boolean | null
  readonly components: readonly PluginComponentView[]
  readonly runtime: PluginRuntimeView
  /** The project whose instance runs project-scoped servers (null: Chat). */
  readonly projectRoot?: string | null
  /** Rewrites the package root out of text shown to the renderer. */
  readonly scrub: (text: string) => string
}): PluginToolsView {
  if (input.computerUse !== undefined)
    return computerUseTools(input.runtime, input.computerUse)
  return {
    note: null,
    groups: input.components
      .filter((component) => component.kind === 'mcp')
      .map((member) => mcpGroup(member, input)),
  }
}

function computerUseTools(
  runtime: PluginRuntimeView,
  enabled: boolean | null,
): PluginToolsView {
  const families = runtime.computerUseTools?.() ?? []
  return {
    note:
      enabled === null
        ? '这台电脑不能使用电脑操作'
        : enabled
          ? null
          : '打开电脑操作后可用',
    groups: COMPUTER_USE_GROUPS.map((group): PluginToolGroup => ({
      id: group.id,
      kind: 'computer-use',
      title: group.title,
      note: null,
      tools: families.find((family) => family.family === group.id)?.tools ?? [],
    })).filter((group) => group.tools.length > 0),
  }
}

function mcpGroup(
  member: PluginComponentView,
  input: Parameters<typeof pluginToolsView>[0],
): PluginToolGroup {
  const tools =
    member.state === 'running'
      ? (
          input.runtime.mcpTools?.(
            input.pluginId,
            input.scope,
            member.id,
            input.projectRoot ?? null,
          ) ?? []
        ).map((tool) => ({
          ...tool,
          description: input.scrub(tool.description),
        }))
      : []
  return {
    id: member.id,
    kind: 'mcp',
    title: member.title,
    note: tools.length ? null : mcpNote(member.state),
    tools,
  }
}

function mcpNote(state: PluginComponentView['state']): string {
  switch (state) {
    case 'running':
      return '这个服务器没有提供工具'
    case 'starting':
      return '正在连接服务器，连上后列出它的工具'
    default:
      return '服务器没有运行'
  }
}
