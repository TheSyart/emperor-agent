import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  migrateLegacyRuntimeSkills,
  validateRuntimeManifest,
  type LegacySkillMigrationResult,
  type RuntimeManifest,
} from '@emperor/core'

export function legacyPackagedRuntimeRoot(userDataPath: string): string {
  return path.join(userDataPath, 'runtime')
}

export function runtimeDefaultsRoot(resourcesPath: string): string {
  return path.join(resourcesPath, 'runtime-defaults')
}

export interface PreparePackagedRuntimeOptions {
  resourcesPath: string
  userDataPath: string
  stateRoot: string
  appVersion: string
  now?: () => string
}

export interface PreparedPackagedRuntime {
  runtimeRoot: string
  legacyRuntimeRoot: string
  manifest: RuntimeManifest
  migration: LegacySkillMigrationResult
}

export function preparePackagedRuntime(
  opts: PreparePackagedRuntimeOptions,
): PreparedPackagedRuntime {
  const runtimeRoot = runtimeDefaultsRoot(opts.resourcesPath)
  const legacyRuntimeRoot = legacyPackagedRuntimeRoot(opts.userDataPath)
  assertSeparateRoots(runtimeRoot, opts.stateRoot)
  const manifest = validateRuntimeManifest(runtimeRoot, {
    expectedAppVersion: opts.appVersion,
  })
  const migration = migrateLegacyRuntimeSkills({
    legacyRuntimeRoot,
    stateRoot: opts.stateRoot,
    builtInSkills: manifest.builtInSkills,
    runtimeRevision: manifest.runtimeRevision,
    now: opts.now,
  })
  return { runtimeRoot, legacyRuntimeRoot, manifest, migration }
}

function assertSeparateRoots(runtimeRoot: string, stateRoot: string): void {
  const runtime = canonicalExistingPath(runtimeRoot)
  const state = canonicalExistingPath(stateRoot)
  if (containsPath(runtime, state) || containsPath(state, runtime))
    throw new Error(
      'signed runtimeRoot and writable stateRoot must be separate',
    )
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value)
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved)
  const suffix: string[] = []
  let current = resolved
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    suffix.unshift(path.basename(current))
    current = parent
  }
  return path.resolve(fs.realpathSync(current), ...suffix)
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}
