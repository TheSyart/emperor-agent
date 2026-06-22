import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8765

export interface ResolvedConfig {
  root: string
  host: string
  port: number
  backendBaseUrl: string
  configSource: 'file' | 'default'
}

export interface ResolveConfigOptions {
  argv?: string[]
  env?: Record<string, string | undefined>
  readFile?: (p: string) => string
}

function defaultReadFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return undefined
}

// Accept only finite integers inside the valid TCP range; anything else is
// treated as missing so we fall back to the default port.
function coercePort(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return undefined
  return n
}

function resolveRoot(argv: string[], env: Record<string, string | undefined>): string {
  return (
    argValue(argv, '--root') ||
    env.EMPEROR_AGENT_ROOT ||
    path.resolve(__dirname, '..', '..', '..')
  )
}

export function resolveConfig({
  argv = [],
  env = {},
  readFile = defaultReadFile,
}: ResolveConfigOptions = {}): ResolvedConfig {
  const root = resolveRoot(argv, env)

  let fileHost: string | undefined
  let filePort: number | undefined
  let configSource: 'file' | 'default' = 'default'
  try {
    const raw = JSON.parse(readFile(path.join(root, 'emperor.local.json')))
    const webui = (raw && raw.webui) || {}
    if (typeof webui.host === 'string' && webui.host.trim()) fileHost = webui.host.trim()
    filePort = coercePort(webui.port)
    configSource = 'file'
  } catch {
    // Missing or malformed emperor.local.json must not crash the shell; we
    // silently fall back to the documented defaults below.
    configSource = 'default'
  }

  const host = fileHost || DEFAULT_HOST

  // Precedence for port: --port > EMPEROR_WEBUI_PORT > file > default.
  const port =
    coercePort(argValue(argv, '--port')) ||
    coercePort(env.EMPEROR_WEBUI_PORT) ||
    filePort ||
    DEFAULT_PORT

  return {
    root,
    host,
    port,
    backendBaseUrl: `http://${host}:${port}`,
    configSource,
  }
}
