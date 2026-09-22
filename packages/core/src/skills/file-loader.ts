/**
 * File-backed Skill discovery.
 *
 * One {@link FileSkillsLoader} serves one project root (`null` for chat
 * sessions) and merges its sources with fixed precedence: project
 * (`<project>/.emperor/skills`) > user (`stateRoot/skills`) > Plugin >
 * builtin. {@link SkillLoaders} caches one loader per project root so
 * concurrent sessions never re-point a shared instance.
 *
 * Each source folder holds `<folder>/SKILL.md` Skills and flat `<name>.md`
 * Skills; a flat file only counts when its frontmatter declares both `name`
 * and `description`. Folders that fail validation are reported through
 * {@link SkillScan.invalid} with a reason instead of disappearing.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'
import type { SkillStatus } from './manager'
import { isSkillName } from './name'
import {
  checkSkillContent,
  checkSkillFolder,
  isPathInside,
  parseSkillFrontmatter,
  SKILL_FILE,
} from './validate'

export type SkillSourceKind = 'project' | 'user' | 'plugin' | 'builtin'

export const PROJECT_SKILLS_SUBDIR = join('.emperor', 'skills')
const MAX_SOURCE_ENTRIES = 1_000
const MAX_FLAT_SKILL_BYTES = 1024 * 1024

export interface ResolvedSkill {
  name: string
  /** Base directory: the Skill folder, or the source folder of a flat Skill. */
  root: string
  skillFile: string
  content: string
  description: string
  source: SkillSourceKind
  /** Builtin and Plugin Skills are read-only; user and project Skills are writable. */
  readOnly: boolean
  status: 'active'
  frontmatter: Record<string, unknown>
  warnings: string[]
  /** A flat `<name>.md` file directly inside the source folder. */
  flat: boolean
  /** The Skills folder that holds this Skill. */
  sourceDir: string
}

export interface InvalidSkill {
  /** Absolute path of the rejected Skill folder or flat file. */
  path: string
  source: SkillSourceKind
  /** All errors joined into one sentence. */
  reason: string
  /** Declared frontmatter name, else the folder name. */
  name: string
  errors: string[]
  warnings: string[]
}

export interface SkillSourceDir {
  kind: SkillSourceKind
  dir: string
  /** Folder the source must stay inside (no symlinked path components). */
  boundary: string
}

export interface SkillScan {
  /** Effective Skills (highest-precedence source per name), sorted by name. */
  skills: ResolvedSkill[]
  /** Valid Skills hidden by a higher-precedence source with the same name. */
  shadowed: ResolvedSkill[]
  invalid: InvalidSkill[]
}

export interface EffectiveSkillConfigValue {
  name: string
  source: SkillSourceKind
  status: SkillStatus
  path: string
  readOnly: boolean
}

export interface FileSkillsLoaderOptions {
  runtimeRoot: string
  stateRoot: string
  projectRoot?: string | null
  pluginRoots?: () => readonly string[]
}

export function projectSkillsDir(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_SKILLS_SUBDIR)
}

export class FileSkillsLoader {
  readonly runtimeRoot: string
  readonly stateRoot: string
  readonly builtinDir: string
  readonly userDir: string
  readonly projectRoot: string | null
  readonly projectDir: string | null
  private readonly pluginRoots: () => readonly string[]

  constructor(opts: FileSkillsLoaderOptions) {
    this.runtimeRoot = resolve(opts.runtimeRoot)
    this.stateRoot = resolve(opts.stateRoot)
    this.builtinDir = join(this.runtimeRoot, 'skills')
    this.userDir = join(this.stateRoot, 'skills')
    this.projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : null
    this.projectDir = this.projectRoot
      ? projectSkillsDir(this.projectRoot)
      : null
    this.pluginRoots = opts.pluginRoots ?? (() => [])
  }

  /** Source folders in precedence order (highest first). */
  sources(): SkillSourceDir[] {
    const plugins = [
      ...new Set(this.pluginRoots().map((root) => resolve(root))),
    ].sort()
    const seen = new Set<string>()
    return [
      ...(this.projectRoot && this.projectDir
        ? [
            {
              kind: 'project' as const,
              dir: this.projectDir,
              boundary: this.projectRoot,
            },
          ]
        : []),
      { kind: 'user' as const, dir: this.userDir, boundary: this.stateRoot },
      ...plugins.map((dir) => ({
        kind: 'plugin' as const,
        dir,
        boundary: dir,
      })),
      {
        kind: 'builtin' as const,
        dir: this.builtinDir,
        boundary: this.runtimeRoot,
      },
    ].filter((source) => {
      // A folder shared by two sources (e.g. runtimeRoot === stateRoot) counts once.
      if (seen.has(source.dir)) return false
      seen.add(source.dir)
      return true
    })
  }

  /** Scan every source: effective Skills, shadowed Skills, and invalid ones. */
  scan(): SkillScan {
    const winners = new Map<string, ResolvedSkill>()
    const shadowed: ResolvedSkill[] = []
    const invalid: InvalidSkill[] = []
    for (const source of this.sources()) {
      const result = scanSkillSource(source)
      invalid.push(...result.invalid)
      for (const skill of result.skills) {
        if (winners.has(skill.name)) shadowed.push(skill)
        else winners.set(skill.name, skill)
      }
    }
    return {
      skills: [...winners.values()].sort(byName),
      shadowed,
      invalid,
    }
  }

  resolve(name: string): ResolvedSkill | null {
    if (!isSkillName(name)) return null
    return this.scan().skills.find((skill) => skill.name === name) ?? null
  }

  resolvedSkills(): ResolvedSkill[] {
    return this.scan().skills
  }

  invalidSkills(): InvalidSkill[] {
    return this.scan().invalid
  }

  /** Effective-config view: every name with its per-source candidates. */
  configResolutions(): Array<Resolved<EffectiveSkillConfigValue | null>> {
    const scan = this.scan()
    const byName = new Map<string, ResolvedSkill[]>()
    for (const skill of [...scan.skills, ...scan.shadowed]) {
      const list = byName.get(skill.name) ?? []
      list.push(skill)
      byName.set(skill.name, list)
    }
    return [...byName.keys()].sort().map((name) => {
      const key = defineConfigKey<EffectiveSkillConfigValue | null>({
        id: `skills.${name}`,
        builtin: null,
      })
      const candidates: ConfigCandidate<EffectiveSkillConfigValue | null>[] = (
        byName.get(name) ?? []
      ).map((skill) => ({
        source: {
          kind: skill.source,
          id: `skill:${skill.source}:${name}`,
          trust: 'trusted',
        },
        value: {
          name,
          source: skill.source,
          status: 'active',
          path: skill.skillFile,
          readOnly: skill.readOnly,
        },
      }))
      return new ConfigResolver().resolve(key, { candidates })
    })
  }
}

/** Scan one source folder; never throws. */
export function scanSkillSource(source: SkillSourceDir): {
  skills: ResolvedSkill[]
  invalid: InvalidSkill[]
} {
  const skills: ResolvedSkill[] = []
  const invalid: InvalidSkill[] = []
  const dir = canonicalSourceDir(source.dir, source.boundary)
  if (dir === null) return { skills, invalid }
  let entries: string[]
  try {
    entries = readdirSync(source.dir).sort().slice(0, MAX_SOURCE_ENTRIES)
  } catch {
    return { skills, invalid }
  }
  const readOnly = source.kind === 'builtin' || source.kind === 'plugin'
  const seen = new Map<string, string>()
  const accept = (skill: ResolvedSkill): void => {
    const previous = seen.get(skill.name)
    if (previous !== undefined) {
      invalid.push({
        path: skill.flat ? skill.skillFile : skill.root,
        source: source.kind,
        name: skill.name,
        reason: `Duplicate Skill name "${skill.name}" (already declared by ${previous})`,
        errors: [`Duplicate Skill name "${skill.name}"`],
        warnings: skill.warnings,
      })
      return
    }
    seen.set(skill.name, skill.flat ? skill.skillFile : skill.root)
    skills.push(skill)
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const path = join(source.dir, entry)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      if (stat.isSymbolicLink() && !isDirectoryTarget(path)) continue
      const check = checkSkillFolder(path, { folderName: entry })
      if (!check.valid) {
        if (stat.isDirectory() && !existsSync(join(path, SKILL_FILE))) continue // plain folder without SKILL.md: not a Skill attempt
        invalid.push({
          path,
          source: source.kind,
          name: check.name || entry,
          reason: check.errors.join('; '),
          errors: check.errors,
          warnings: check.warnings,
        })
        continue
      }
      accept({
        name: check.name,
        root: path,
        skillFile: check.skillFile,
        content: check.content,
        description: check.description,
        source: source.kind,
        readOnly,
        status: 'active',
        frontmatter: check.frontmatter,
        warnings: check.warnings,
        flat: false,
        sourceDir: source.dir,
      })
      continue
    }
    if (!stat.isFile() || !entry.toLowerCase().endsWith('.md')) continue
    if (entry === SKILL_FILE || stat.size > MAX_FLAT_SKILL_BYTES) continue
    const flat = flatSkill(path, entry)
    if (flat === null) continue
    if (flat.errors.length) {
      invalid.push({
        path,
        source: source.kind,
        name: flat.name,
        reason: flat.errors.join('; '),
        errors: flat.errors,
        warnings: flat.warnings,
      })
      continue
    }
    accept({
      name: flat.name,
      root: source.dir,
      skillFile: path,
      content: flat.content,
      description: flat.description,
      source: source.kind,
      readOnly,
      status: 'active',
      frontmatter: flat.frontmatter,
      warnings: flat.warnings,
      flat: true,
      sourceDir: source.dir,
    })
  }
  return { skills, invalid }
}

/** A flat `<name>.md` Skill: only files whose frontmatter has name + description count. */
function flatSkill(
  path: string,
  entry: string,
): {
  name: string
  description: string
  content: string
  frontmatter: Record<string, unknown>
  errors: string[]
  warnings: string[]
} | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const parsed = parseSkillFrontmatter(content)
  if (
    !parsed.present ||
    typeof parsed.data.name !== 'string' ||
    typeof parsed.data.description !== 'string'
  )
    return null
  const check = checkSkillContent(content, {
    folderName: basename(entry, '.md'),
  })
  return {
    name: check.name,
    description: check.description,
    content,
    frontmatter: check.frontmatter,
    errors: check.errors,
    warnings: check.warnings.map((warning) =>
      warning.replace(/^Folder name/, 'File name'),
    ),
  }
}

function isDirectoryTarget(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The source folder when it exists without symlinked components below its boundary. */
function canonicalSourceDir(dir: string, boundary: string): string | null {
  const lexicalBoundary = resolve(boundary)
  const lexicalPath = resolve(dir)
  if (!isPathInside(lexicalBoundary, lexicalPath)) return null
  if (!existsSync(lexicalPath)) return null
  const rel = relative(lexicalBoundary, lexicalPath)
  let cursor = lexicalBoundary
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null
    } catch {
      return null
    }
  }
  try {
    if (!lstatSync(lexicalPath).isDirectory()) return null
    const canonical = realpathSync(lexicalPath)
    return isPathInside(realpathSync(lexicalBoundary), canonical)
      ? canonical
      : null
  } catch {
    return null
  }
}

function byName(left: ResolvedSkill, right: ResolvedSkill): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * Per-project loader cache plus the shared Plugin Skill roots. `forProject(null)`
 * is the chat loader; a build session gets the loader of its project root.
 */
export class SkillLoaders {
  readonly runtimeRoot: string
  readonly stateRoot: string
  readonly userDir: string
  readonly builtinDir: string
  private plugins: string[] = []
  private readonly chat: FileSkillsLoader
  private readonly projects = new Map<string, FileSkillsLoader>()
  private readonly listeners = new Set<() => void>()

  constructor(opts: { runtimeRoot: string; stateRoot: string }) {
    this.runtimeRoot = resolve(opts.runtimeRoot)
    this.stateRoot = resolve(opts.stateRoot)
    this.userDir = join(this.stateRoot, 'skills')
    this.builtinDir = join(this.runtimeRoot, 'skills')
    this.chat = this.create(null)
  }

  forProject(projectRoot: string | null | undefined): FileSkillsLoader {
    if (!projectRoot) return this.chat
    const root = resolve(projectRoot)
    const existing = this.projects.get(root)
    if (existing !== undefined) return existing
    const loader = this.create(root)
    this.projects.set(root, loader)
    this.notify()
    return loader
  }

  setPluginSkillsRoots(roots: readonly string[]): void {
    const next = [...new Set(roots.map((root) => resolve(root)))].sort()
    if (next.join('\0') === this.plugins.join('\0')) return
    this.plugins = next
    this.notify()
  }

  pluginSkillsRoots(): string[] {
    return [...this.plugins]
  }

  projectRoots(): string[] {
    return [...this.projects.keys()].sort()
  }

  /** Writable user + known project Skill folders and Plugin roots. */
  watchRoots(): string[] {
    return [
      this.userDir,
      ...this.projectRoots().map((root) => projectSkillsDir(root)),
      ...this.plugins,
    ]
  }

  /** Observe new project loaders and Plugin root changes; returns an unsubscribe. */
  onRootsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private create(projectRoot: string | null): FileSkillsLoader {
    return new FileSkillsLoader({
      runtimeRoot: this.runtimeRoot,
      stateRoot: this.stateRoot,
      projectRoot,
      pluginRoots: () => this.plugins,
    })
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // observers never break discovery
      }
    }
  }
}
