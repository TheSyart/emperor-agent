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

/**
 * A dependency-free stdio MCP server (newline-delimited JSON-RPC) with one
 * tool, `where`, that reports its working directory and `PLUGIN_ROOT`, and
 * appends a line to `$PLUGIN_DATA/calls.log` when that variable is set.
 */
export const STDIO_MCP_SERVER = `
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'plugin-fixture', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: [{
        name: 'where',
        description: 'Report where the server runs.',
        inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
      }] })
    case 'tools/call': {
      const note = (message.params.arguments || {}).note || ''
      if (process.env.PLUGIN_DATA) {
        mkdirSync(process.env.PLUGIN_DATA, { recursive: true })
        appendFileSync(join(process.env.PLUGIN_DATA, 'calls.log'), note + '\\n')
      }
      return reply({ content: [{ type: 'text', text: JSON.stringify({
        cwd: process.cwd(),
        root: process.env.PLUGIN_ROOT || null,
        note,
      }) }] })
    }
    default:
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })
  }
})
`
