/**
 * 工具画像解析 (MIG-CTRL-015)。对齐 Python `agent/permissions/resolvers.py:resolve_tool_profile`。
 * 经工具的 isReadOnly/isConcurrencySafe/isDestructive/getPath 取属性，异常回退。
 */
import type { Tool } from '../tools/base'
import type { ToolRegistry } from '../tools/registry'
import { makeProfile, type ToolPermissionProfile } from './models'
import { schedulerAction } from '../tools/resolvers'

function argumentPath(args: Record<string, unknown>): string | null {
  const value = args && typeof args === 'object' ? args.path : null
  return value ? String(value) : null
}

export function resolveToolProfile(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { registry?: ToolRegistry | null },
): ToolPermissionProfile {
  const tool: Tool | undefined = opts?.registry
    ? opts.registry.get(toolName)
    : undefined
  let readOnly = tool
    ? Boolean(tool.readOnly)
    : FALLBACK_READ_ONLY_TOOLS.has(toolName)
  let concurrencySafe = tool ? Boolean(tool.concurrencySafe) : false
  let destructive = !readOnly
  let path = argumentPath(args)
  let paths = path ? [path] : []

  if (tool) {
    try {
      readOnly = tool.isReadOnly(args)
    } catch {
      readOnly = false
    }
    try {
      concurrencySafe = tool.isConcurrencySafe(args)
    } catch {
      concurrencySafe = Boolean(tool.concurrencySafe)
    }
    if (typeof tool.isDestructive === 'function') {
      try {
        destructive = Boolean(tool.isDestructive(args))
      } catch {
        destructive = !readOnly
      }
    } else {
      destructive = !readOnly
    }
    if (typeof tool.getPath === 'function') {
      try {
        path = tool.getPath(args) || path
      } catch {
        /* keep argument path */
      }
    }
    if (typeof tool.getPaths === 'function') {
      try {
        paths = uniquePaths(tool.getPaths(args))
        path = paths[0] ?? path
      } catch {
        /* keep argument paths */
      }
    } else if (path) {
      paths = [path]
    }
  }

  return makeProfile({
    name: toolName,
    arguments: args,
    readOnly,
    concurrencySafe,
    destructive,
    path,
    paths,
    command: String((args && args.command) || ''),
    schedulerAction: schedulerAction(args),
  })
}

// Core callers normally supply the registry. Keeping this narrow fallback
// makes policy-only checks reflect the immutable semantics of built-in readers
// without treating unknown tools as safe.
const FALLBACK_READ_ONLY_TOOLS = new Set([
  'glob',
  'grep',
  'load_skill',
  'read_file',
  'web_fetch',
  'web_search',
])

function uniquePaths(values: unknown[]): string[] {
  return [
    ...new Set(
      values.map((value) => String(value ?? '').trim()).filter(Boolean),
    ),
  ]
}
