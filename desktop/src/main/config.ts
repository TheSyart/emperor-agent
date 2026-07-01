import * as fs from 'node:fs'
import * as path from 'node:path'
import { moduleDirFromUrl } from './esm-path'

export interface ResolvedConfig {
  root: string
  configSource: 'file' | 'default'
}

export interface ResolveConfigOptions {
  argv?: string[]
  env?: Record<string, string | undefined>
  readFile?: (p: string) => string
  defaultRoot?: string
}

const mainDir = moduleDirFromUrl(import.meta.url)

function defaultReadFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return undefined
}

function resolveRoot(
  argv: string[],
  env: Record<string, string | undefined>,
  defaultRoot?: string,
): string {
  return (
    argValue(argv, '--root') ||
    env.EMPEROR_AGENT_ROOT ||
    defaultRoot ||
    path.resolve(mainDir, '..', '..', '..')
  )
}

export function resolveConfig({
  argv = [],
  env = {},
  readFile = defaultReadFile,
  defaultRoot,
}: ResolveConfigOptions = {}): ResolvedConfig {
  const root = resolveRoot(argv, env, defaultRoot)

  let configSource: 'file' | 'default' = 'default'
  try {
    JSON.parse(readFile(path.join(root, 'emperor.local.json')))
    configSource = 'file'
  } catch {
    // Missing or malformed emperor.local.json must not crash the shell; we
    // silently continue with the packaged Core runtime defaults.
    configSource = 'default'
  }

  return {
    root,
    configSource,
  }
}
