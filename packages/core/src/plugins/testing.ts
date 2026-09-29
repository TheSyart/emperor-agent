/**
 * Test fixtures for plugin packages: write a package tree from a file map.
 * JSON values are serialized; strings are written as they are.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const PLUGIN_SCHEMA_URL =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const MCP_SCHEMA_URL =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

export type PackageFiles = Record<string, string | object>

export function tempDirectory(prefix = 'emperor-plugin-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Write `files` under `root` (created as needed) and return `root`. */
export function writePackage(root: string, files: PackageFiles): string {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    )
  }
  return root
}

export function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`
}

/** A portable package: root `plugin.json` plus the given files. */
export function portablePackage(
  name: string,
  files: PackageFiles = {},
  manifest: Record<string, unknown> = {},
): PackageFiles {
  return {
    'plugin.json': { $schema: PLUGIN_SCHEMA_URL, name, ...manifest },
    ...files,
  }
}
