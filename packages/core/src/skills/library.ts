/**
 * Skill library: the write side of Skills, shared by the Skill CoreApi
 * service and the `skill_manage` agent tool.
 *
 * - Writable scopes are `user` (`stateRoot/skills`) and `project`
 *   (`<project>/.emperor/skills`, Build sessions only). Builtin and Plugin
 *   Skills are read-only: saving or deleting them fails with
 *   `skill_read_only`; `copyToUser` makes an editable personal copy.
 * - Reads go through the per-project {@link SkillLoaders} so a session only
 *   ever sees its own project's Skills.
 * - Every mutation calls `onChanged` (catalog refresh + change event).
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { WebFetchClient } from '../network/web-fetch-client'
import { SkillError } from './errors'
import {
  projectSkillsDir,
  scanSkillSource,
  type FileSkillsLoader,
  type ResolvedSkill,
  type SkillLoaders,
  type SkillScan,
  type SkillSourceDir,
} from './file-loader'
import {
  importSkills,
  installSkillFolder,
  type SkillImportResult,
  type SkillImportSource,
} from './import'
import { replaceFileAtomic } from './manager'
import { skillNameError } from './name'
import {
  checkSkillContent,
  checkSkillFolder,
  isPathInside,
  SKILL_FILE,
  SKIPPED_SKILL_DIRS,
} from './validate'

export type SkillScope = 'user' | 'project'

export const SKILL_SCOPES: readonly SkillScope[] = ['user', 'project']

const MAX_EXTRA_FILES = 200
const MAX_EXTRA_FILE_BYTES = 2 * 1024 * 1024
const MAX_EXTRA_TOTAL_BYTES = 10 * 1024 * 1024

export interface SkillLibraryOptions {
  loaders: SkillLoaders
  /** Public-HTTPS client for URL imports (absent → URL import unavailable). */
  fetchClient?: () => WebFetchClient | null | undefined
  /** Called after every successful mutation. */
  onChanged?: () => void
}

export interface SkillWriteInput {
  /** Expected Skill name; must match the frontmatter `name` when given. */
  name?: string | null
  /** Full SKILL.md text. */
  content: string
  /** Extra files keyed by path relative to the Skill folder. */
  files?: Record<string, string> | null
  scope: SkillScope
  mode: 'create' | 'update'
}

export interface SkillWriteResult {
  name: string
  scope: SkillScope
  /** Skill folder (or the flat file for a flat Skill). */
  path: string
  skillFile: string
  created: boolean
  errors: string[]
  warnings: string[]
}

export interface SkillDeleteResult {
  name: string
  scope: SkillScope
  path: string
}

export class SkillLibrary {
  readonly loaders: SkillLoaders
  private readonly fetchClient: () => WebFetchClient | null | undefined
  private readonly onChanged: () => void

  constructor(opts: SkillLibraryOptions) {
    this.loaders = opts.loaders
    this.fetchClient = opts.fetchClient ?? (() => null)
    this.onChanged = opts.onChanged ?? (() => {})
  }

  loader(projectRoot: string | null): FileSkillsLoader {
    return this.loaders.forProject(projectRoot)
  }

  list(projectRoot: string | null): SkillScan {
    return this.loader(projectRoot).scan()
  }

  /** The effective Skill of a name for a project (null = chat). */
  find(projectRoot: string | null, name: string): ResolvedSkill | null {
    return this.loader(projectRoot).resolve(name)
  }

  require(projectRoot: string | null, name: string): ResolvedSkill {
    const nameError = skillNameError(name)
    if (nameError) throw new SkillError(nameError, 'skill_invalid')
    const skill = this.find(projectRoot, name)
    if (skill === null)
      throw new SkillError(`Skill not found: ${name}`, 'skill_not_found')
    return skill
  }

  /** The Skills folder of a writable scope. */
  scopeDir(
    scope: SkillScope,
    projectRoot: string | null,
    opts: { create?: boolean } = {},
  ): string {
    const { dir, boundary } = this.scopeSource(scope, projectRoot)
    if (opts.create) mkdirSync(dir, { recursive: true })
    assertNoSymlinkBelow(boundary, dir)
    return dir
  }

  /** A valid Skill of a name inside one writable scope only. */
  findInScope(
    projectRoot: string | null,
    name: string,
    scope: SkillScope,
  ): ResolvedSkill | null {
    const source = this.scopeSource(scope, projectRoot)
    return (
      scanSkillSource({ kind: scope, ...source }).skills.find(
        (skill) => skill.name === name,
      ) ?? null
    )
  }

  /** Create or update a Skill from full SKILL.md text plus optional extra files. */
  write(projectRoot: string | null, input: SkillWriteInput): SkillWriteResult {
    const content = `${String(input.content ?? '').trimEnd()}\n`
    const check = checkSkillContent(content)
    if (check.errors.length)
      throw new SkillError(
        `SKILL.md is invalid: ${check.errors.join('; ')}`,
        'skill_invalid',
      )
    const requested = String(input.name ?? '').trim()
    if (requested && requested !== check.name)
      throw new SkillError(
        `Frontmatter name "${check.name}" does not match the Skill name "${requested}"`,
        'skill_invalid',
      )
    const name = check.name
    const files = normalizeExtraFiles(input.files)
    const dir = this.scopeDir(input.scope, projectRoot, { create: true })
    const existing = this.findInScope(projectRoot, name, input.scope)
    const folder = join(dir, name)
    const flatFile = join(dir, `${name}.md`)
    let skillFile: string
    let path: string
    let created = false
    if (input.mode === 'create') {
      if (existing !== null || pathExists(folder) || pathExists(flatFile))
        throw new SkillError(
          `A ${input.scope} Skill named "${name}" already exists; update it instead`,
          'skill_exists',
          { action: 'update' },
        )
      const stage = join(
        dir,
        `.skill-write-${process.pid}-${randomBytes(6).toString('hex')}`,
      )
      try {
        mkdirSync(stage)
        writeFileSync(join(stage, SKILL_FILE), content, 'utf8')
        for (const [rel, text] of files)
          writeInside(stage, rel, text, { atomic: false })
        renameSync(stage, folder)
      } catch (error) {
        rmSync(stage, { recursive: true, force: true })
        throw error
      }
      created = true
      path = folder
      skillFile = join(folder, SKILL_FILE)
    } else {
      if (
        existing === null &&
        pathExists(folder) &&
        lstatSync(folder).isSymbolicLink()
      )
        throw new SkillError(
          `Skill folder "${name}" is a symbolic link and cannot be written`,
          'skill_invalid',
        )
      const target =
        existing ??
        (pathExists(folder) && lstatSync(folder).isDirectory()
          ? null
          : undefined)
      if (target === undefined)
        throw new SkillError(
          `No ${input.scope} Skill named "${name}" exists; create it first`,
          'skill_not_found',
          { action: 'create' },
        )
      if (target !== null && target.flat) {
        if (files.length)
          throw new SkillError(
            `"${name}" is a single-file Skill; it cannot hold extra files`,
            'skill_invalid',
          )
        writeFileAtomic(target.skillFile, content)
        path = target.skillFile
        skillFile = target.skillFile
      } else {
        const root = target?.root ?? folder
        if (lstatSync(root).isSymbolicLink())
          throw new SkillError(
            `Skill folder "${name}" is a symbolic link and cannot be written`,
            'skill_invalid',
          )
        writeInside(root, SKILL_FILE, content, { atomic: true })
        for (const [rel, text] of files)
          writeInside(root, rel, text, { atomic: true })
        path = root
        skillFile = join(root, SKILL_FILE)
      }
    }
    this.onChanged()
    const after = path === skillFile ? null : checkSkillFolder(path)
    return {
      name,
      scope: input.scope,
      path,
      skillFile,
      created,
      errors: after?.errors ?? [],
      warnings: after?.warnings ?? check.warnings,
    }
  }

  /**
   * Save edited SKILL.md text of the effective Skill in place. A name that
   * does not resolve becomes a new personal Skill; read-only sources fail.
   */
  save(
    projectRoot: string | null,
    name: string,
    content: string,
  ): SkillWriteResult {
    const nameError = skillNameError(name)
    if (nameError) throw new SkillError(nameError, 'skill_invalid')
    const skill = this.find(projectRoot, name)
    if (skill === null) {
      const userFolder = join(this.scopeDir('user', projectRoot), name)
      return this.write(projectRoot, {
        name,
        content,
        scope: 'user',
        mode: pathExists(userFolder) ? 'update' : 'create',
      })
    }
    if (skill.readOnly) throw readOnlyError(skill)
    return this.write(projectRoot, {
      name,
      content,
      scope: skill.source as SkillScope,
      mode: 'update',
    })
  }

  /**
   * Delete a writable Skill by name. With `scope`, `name` may also be the
   * folder (or `.md` file) name of an invalid Skill in that scope's folder.
   */
  delete(
    projectRoot: string | null,
    name: string,
    scope?: SkillScope | null,
  ): SkillDeleteResult {
    name = String(name ?? '').trim()
    const nameError = skillNameError(name)
    if (nameError && !scope) throw new SkillError(nameError, 'skill_invalid')
    let target: { path: string; scope: SkillScope; flat: boolean } | null = null
    if (scope) {
      if (!isSafeEntryName(name))
        throw new SkillError(
          `Invalid Skill folder name "${name}"`,
          'skill_invalid',
        )
      const found = nameError
        ? null
        : this.findInScope(projectRoot, name, scope)
      const dir = this.scopeDir(scope, projectRoot)
      if (found !== null)
        target = {
          path: found.flat ? found.skillFile : found.root,
          scope,
          flat: found.flat,
        }
      else if (pathExists(join(dir, name)))
        target = { path: join(dir, name), scope, flat: false }
      else if (!name.endsWith('.md') && pathExists(join(dir, `${name}.md`)))
        target = { path: join(dir, `${name}.md`), scope, flat: true }
    } else {
      const skill = this.find(projectRoot, name)
      if (skill !== null) {
        if (skill.readOnly) throw readOnlyError(skill)
        target = {
          path: skill.flat ? skill.skillFile : skill.root,
          scope: skill.source as SkillScope,
          flat: skill.flat,
        }
      } else {
        for (const candidate of this.writableScopes(projectRoot)) {
          const folder = join(this.scopeDir(candidate, projectRoot), name)
          if (pathExists(folder)) {
            target = { path: folder, scope: candidate, flat: false }
            break
          }
        }
      }
    }
    if (target === null)
      throw new SkillError(`Skill not found: ${name}`, 'skill_not_found')
    const dir = this.scopeDir(target.scope, projectRoot)
    if (
      !isPathInside(dir, target.path) ||
      resolve(target.path) === resolve(dir)
    )
      throw new SkillError(
        `Skill "${name}" is outside the ${target.scope} Skills folder`,
        'skill_invalid',
      )
    const stat = lstatSync(target.path)
    if (target.flat || stat.isSymbolicLink() || !stat.isDirectory())
      unlinkSync(target.path)
    else rmSync(target.path, { recursive: true, force: true })
    this.onChanged()
    return { name, scope: target.scope, path: target.path }
  }

  /** Copy a builtin, Plugin, or project Skill into the personal Skills folder. */
  copyToUser(
    projectRoot: string | null,
    name: string,
    opts: { overwrite?: boolean } = {},
  ): SkillWriteResult {
    const skill = this.require(projectRoot, name)
    if (skill.source === 'user')
      throw new SkillError(
        `"${name}" is already a personal Skill`,
        'skill_exists',
      )
    const dir = this.scopeDir('user', projectRoot, { create: true })
    if (skill.flat) {
      const exists = this.findInScope(projectRoot, name, 'user') !== null
      if (exists && !opts.overwrite)
        throw new SkillError(
          `A personal Skill named "${name}" already exists; choose overwrite to replace it`,
          'skill_exists',
          { action: 'overwrite' },
        )
      return this.write(projectRoot, {
        name,
        content: skill.content,
        scope: 'user',
        mode: exists ? 'update' : 'create',
      })
    }
    const check = checkSkillFolder(skill.root)
    const installed = installSkillFolder(skill.root, {
      targetDir: dir,
      name,
      overwrite: opts.overwrite === true,
    })
    this.onChanged()
    return {
      name,
      scope: 'user',
      path: installed.path,
      skillFile: join(installed.path, SKILL_FILE),
      created: !installed.replaced,
      errors: [],
      warnings: [...check.warnings, ...installed.warnings],
    }
  }

  async import(
    projectRoot: string | null,
    input: {
      source: SkillImportSource
      scope: SkillScope
      overwrite?: boolean
      signal?: AbortSignal
    },
  ): Promise<SkillImportResult> {
    const dir = this.scopeDir(input.scope, projectRoot, { create: true })
    const result = await importSkills({
      source: input.source,
      targetDir: dir,
      scope: input.scope,
      overwrite: input.overwrite === true,
      fetchClient: this.fetchClient() ?? null,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (result.imported.length) this.onChanged()
    return result
  }

  /** Writable scopes available to a project (user always; project in Build sessions). */
  writableScopes(projectRoot: string | null): SkillScope[] {
    return projectRoot ? ['project', 'user'] : ['user']
  }

  private scopeSource(
    scope: SkillScope,
    projectRoot: string | null,
  ): Omit<SkillSourceDir, 'kind'> {
    if (scope === 'user')
      return { dir: this.loaders.userDir, boundary: this.loaders.stateRoot }
    if (!projectRoot)
      throw new SkillError(
        'Project Skills need a Build session bound to a project',
        'skill_scope_unavailable',
      )
    return {
      dir: projectSkillsDir(projectRoot),
      boundary: resolve(projectRoot),
    }
  }
}

/** A single folder/file name inside a Skills folder (no separators, not hidden). */
function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    !name.startsWith('.') &&
    !/[\\/\0]/.test(name)
  )
}

function readOnlyError(skill: ResolvedSkill): SkillError {
  const label = skill.source === 'builtin' ? 'Built-in' : 'Plugin'
  return new SkillError(
    `${label} Skill "${skill.name}" is read-only; copy it to your personal Skills to change it`,
    'skill_read_only',
    { action: 'copy_to_user' },
  )
}

/** Validate `files` of a write: relative, inside the folder, bounded. */
function normalizeExtraFiles(
  files: Record<string, string> | null | undefined,
): Array<[string, string]> {
  const entries = Object.entries(files ?? {})
  if (entries.length > MAX_EXTRA_FILES)
    throw new SkillError(
      `At most ${MAX_EXTRA_FILES} extra files can be written at once`,
      'skill_invalid',
    )
  let total = 0
  const out: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const [raw, value] of entries) {
    const rel = String(raw ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
    const parts = rel.split('/')
    if (
      !rel ||
      rel.startsWith('/') ||
      /^[A-Za-z]:/.test(rel) ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          SKIPPED_SKILL_DIRS.has(part),
      )
    )
      throw new SkillError(
        `Invalid Skill file path "${raw}": use a relative path inside the Skill folder`,
        'skill_invalid',
      )
    if (rel.toLowerCase() === SKILL_FILE.toLowerCase())
      throw new SkillError(
        'Pass SKILL.md through "content", not "files"',
        'skill_invalid',
      )
    if (seen.has(rel.toLowerCase()))
      throw new SkillError(
        `Duplicate Skill file path "${rel}"`,
        'skill_invalid',
      )
    seen.add(rel.toLowerCase())
    const text = String(value ?? '')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_EXTRA_FILE_BYTES)
      throw new SkillError(`Skill file exceeds 2 MiB: ${rel}`, 'skill_invalid')
    total += bytes
    if (total > MAX_EXTRA_TOTAL_BYTES)
      throw new SkillError(
        'Skill files exceed 10 MiB in total',
        'skill_invalid',
      )
    out.push([rel, text])
  }
  return out
}

/** Write `root/rel` without following symbolic links below `root`. */
function writeInside(
  root: string,
  rel: string,
  content: string,
  opts: { atomic: boolean },
): void {
  const target = join(root, ...rel.split('/'))
  if (!isPathInside(root, target))
    throw new SkillError(`Invalid Skill file path "${rel}"`, 'skill_invalid')
  let cursor = root
  for (const part of relative(root, dirname(target))
    .split(sep)
    .filter(Boolean)) {
    cursor = join(cursor, part)
    if (pathExists(cursor)) {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new SkillError(
          `Cannot write "${rel}": "${relative(root, cursor)}" is not a plain folder`,
          'skill_invalid',
        )
    } else mkdirSync(cursor)
  }
  if (pathExists(target) && lstatSync(target).isSymbolicLink())
    throw new SkillError(
      `Cannot write "${rel}": it is a symbolic link`,
      'skill_invalid',
    )
  if (opts.atomic) writeFileAtomic(target, content)
  else writeFileSync(target, content, 'utf8')
}

function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' })
    replaceFileAtomic(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Refuse a Skills folder reached through symbolic links below its boundary. */
function assertNoSymlinkBelow(boundary: string, dir: string): void {
  const base = resolve(boundary)
  const target = resolve(dir)
  if (!isPathInside(base, target))
    throw new SkillError('Skills folder escapes its root', 'skill_invalid')
  let cursor = base
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) return
    if (lstatSync(cursor).isSymbolicLink())
      throw new SkillError(
        `Skills folder must not be reached through a symbolic link: ${cursor}`,
        'skill_invalid',
      )
  }
  if (
    existsSync(target) &&
    !isPathInside(realpathSync(base), realpathSync(target))
  )
    throw new SkillError('Skills folder escapes its root', 'skill_invalid')
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
