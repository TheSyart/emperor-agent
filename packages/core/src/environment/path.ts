import { posix, win32 } from 'node:path'
import type { EnvironmentPlatform } from './models'
import type { EnvironmentProcessRunner } from './process-runner'

export interface EffectivePathOptions {
  platform: EnvironmentPlatform
  envPath?: string | null
  homeDir: string
  machinePath?: string | null
  userPath?: string | null
  windowsEnv?: Record<string, string | undefined>
}

export interface EffectivePath {
  entries: string[]
  value: string
}

export interface WindowsRegistryPaths {
  machinePath: string
  userPath: string
  diagnostics: string[]
}

export function buildEffectivePath(opts: EffectivePathOptions): EffectivePath {
  const separator = opts.platform === 'win32' ? ';' : ':'
  const inherited = splitPath(opts.envPath, separator)
  let entries: string[]
  if (opts.platform === 'win32') {
    const windowsEnv = normalizedWindowsEnv(opts.windowsEnv ?? {})
    const expanded = [
      ...inherited,
      ...splitPath(opts.machinePath, separator),
      ...splitPath(opts.userPath, separator),
    ]
      .map((entry) => expandWindowsPath(entry, windowsEnv))
      .filter((entry): entry is string => Boolean(entry))
    const localAppData = windowsEnv.localappdata
    const voltaHome = windowsEnv.volta_home
    entries = [
      ...(voltaHome
        ? [win32.join(voltaHome, 'bin')]
        : localAppData
          ? [win32.join(localAppData, 'Volta', 'bin')]
          : []),
      ...expanded,
      win32.join(opts.homeDir, '.cargo', 'bin'),
      win32.join(opts.homeDir, '.local', 'bin'),
    ]
  } else {
    const env = opts.windowsEnv ?? {}
    const voltaHome = env.VOLTA_HOME
    const voltaBin =
      voltaHome && posix.isAbsolute(voltaHome)
        ? posix.join(voltaHome, 'bin')
        : posix.join(opts.homeDir, '.volta', 'bin')
    const system = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    const platform =
      opts.platform === 'darwin' ? ['/opt/homebrew/bin'] : ['/usr/local/go/bin']
    entries = [
      voltaBin,
      ...inherited,
      ...platform,
      ...system,
      posix.join(opts.homeDir, '.local', 'bin'),
      posix.join(opts.homeDir, '.cargo', 'bin'),
    ]
  }
  const deduped = dedupePathEntries(entries, opts.platform)
  return { entries: deduped, value: deduped.join(separator) }
}

export function dedupePathEntries(
  entries: string[],
  platform: EnvironmentPlatform,
): string[] {
  const output: string[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const entry = String(raw ?? '')
      .trim()
      .replace(/^"|"$/g, '')
    if (
      !entry ||
      [...entry].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      })
    )
      continue
    if (platform === 'win32' && /^\\\\(?:\?|\.)?\\?/.test(entry)) continue
    const absolute =
      platform === 'win32' ? win32.isAbsolute(entry) : posix.isAbsolute(entry)
    if (!absolute) continue
    const key = platform === 'win32' ? entry.toLowerCase() : entry
    if (seen.has(key)) continue
    seen.add(key)
    output.push(entry)
  }
  return output
}

export function parseWindowsRegistryPath(output: string): string {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line)
    if (match) return match[1]!.trim()
  }
  return ''
}

export async function queryWindowsRegistryPaths(
  runner: EnvironmentProcessRunner,
  env: Record<string, string | undefined>,
): Promise<WindowsRegistryPaths> {
  const systemRoot = windowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows'
  const executable = win32.join(systemRoot, 'System32', 'reg.exe')
  const processEnv = {
    SystemRoot: systemRoot,
    SYSTEMROOT: systemRoot,
    PATH: windowsEnvValue(env, 'PATH') ?? '',
    TEMP: windowsEnvValue(env, 'TEMP') ?? windowsEnvValue(env, 'TMP') ?? '',
  }
  const queries = [
    {
      scope: 'machine' as const,
      key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    },
    { scope: 'user' as const, key: 'HKCU\\Environment' },
  ]
  const values = { machine: '', user: '' }
  const diagnostics: string[] = []
  for (const query of queries) {
    const result = await runner.run({
      executable,
      args: ['query', query.key, '/v', 'Path'],
      env: processEnv,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    })
    if (result.status === 'completed' && result.exitCode === 0)
      values[query.scope] = parseWindowsRegistryPath(result.stdout)
    else diagnostics.push(`${query.scope}_path_query_${result.status}`)
  }
  return {
    machinePath: values.machine,
    userPath: values.user,
    diagnostics,
  }
}

export function windowsEnvValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  return Object.entries(env).find(([key]) => key.toLowerCase() === target)?.[1]
}

function splitPath(
  value: string | null | undefined,
  separator: string,
): string[] {
  return String(value ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function normalizedWindowsEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => [key.toLowerCase(), value]),
  )
}

function expandWindowsPath(
  value: string,
  env: Record<string, string>,
): string | null {
  let unknown = false
  const expanded = value.replace(/%([^%]+)%/g, (_, name: string) => {
    const replacement = env[name.toLowerCase()]
    if (replacement === undefined) {
      unknown = true
      return ''
    }
    return replacement
  })
  return unknown || expanded.includes('%') ? null : expanded
}
