import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ResolvedConfig } from './config'

function defaultFileExists(p: string): boolean {
  return fs.existsSync(p)
}

export interface BuildBackendCommandOptions {
  config: Pick<ResolvedConfig, 'root' | 'host' | 'port'>
  env?: Record<string, string | undefined>
  fileExists?: (p: string) => boolean
  bundledBackendPath?: string
}

export interface BackendCommand {
  command: string
  args: string[]
}

// Build the argv used to spawn the aiohttp backend. The trailing flags map
// directly onto agent/webui.py's argparse (--host / --port / --no-open).
export function buildBackendCommand({
  config,
  env = {},
  fileExists = defaultFileExists,
  bundledBackendPath = '',
}: BuildBackendCommandOptions): BackendCommand {
  const tailArgs = ['web', '--host', config.host, '--port', String(config.port), '--no-open']

  const override =
    typeof env.EMPEROR_BACKEND_CMD === 'string' ? env.EMPEROR_BACKEND_CMD.trim() : ''
  if (override) {
    const [command, ...baseArgs] = override.split(/\s+/)
    return { command, args: [...baseArgs, ...tailArgs] }
  }

  if (bundledBackendPath && fileExists(bundledBackendPath)) {
    return { command: bundledBackendPath, args: tailArgs }
  }

  const venvBinary = path.join(config.root, '.venv', 'bin', 'emperor-agent')
  if (fileExists(venvBinary)) {
    return { command: venvBinary, args: tailArgs }
  }

  return { command: 'emperor-agent', args: tailArgs }
}
