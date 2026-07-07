import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultStateRoot } from '@emperor/core'
import { moduleDirFromUrl } from './esm-path'

export type RootSource = 'explicit' | 'env' | 'default'

export interface ResolvedConfig {
  runtimeRoot: string
  runtimeRootSource: RootSource
  stateRoot: string
  stateRootSource: RootSource
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

function resolveRuntimeRoot(
  argv: string[],
  env: Record<string, string | undefined>,
  defaultRoot?: string,
): { root: string; source: RootSource } {
  const explicit = argValue(argv, '--root')
  if (explicit) return { root: explicit, source: 'explicit' }
  if (env.EMPEROR_AGENT_ROOT) return { root: env.EMPEROR_AGENT_ROOT, source: 'env' }
  if (defaultRoot) return { root: defaultRoot, source: 'default' }
  return { root: path.resolve(mainDir, '..', '..', '..'), source: 'default' }
}

/** `EMPEROR_AGENT_ROOT`/`--root` only ever mean runtime *resources* root now; the private
 * state root is resolved independently so packaged installs keep private data outside the
 * app bundle even when `--root`/`EMPEROR_AGENT_ROOT` point at a bundled resources dir. */
function resolveStateRoot(env: Record<string, string | undefined>): { root: string; source: RootSource } {
  if (env.EMPEROR_CONFIG_DIR) return { root: env.EMPEROR_CONFIG_DIR, source: 'env' }
  return { root: defaultStateRoot(), source: 'default' }
}

export function resolveConfig({
  argv = [],
  env = {},
  readFile = defaultReadFile,
  defaultRoot,
}: ResolveConfigOptions = {}): ResolvedConfig {
  const { root: runtimeRoot, source: runtimeRootSource } = resolveRuntimeRoot(argv, env, defaultRoot)
  const { root: stateRoot, source: stateRootSource } = resolveStateRoot(env)

  let configSource: 'file' | 'default' = 'default'
  try {
    JSON.parse(readFile(path.join(stateRoot, 'emperor.local.json')))
    configSource = 'file'
  } catch {
    // Missing or malformed emperor.local.json must not crash the shell; we
    // silently continue with the packaged Core runtime defaults.
    configSource = 'default'
  }

  return {
    runtimeRoot,
    runtimeRootSource,
    stateRoot,
    stateRootSource,
    configSource,
  }
}
