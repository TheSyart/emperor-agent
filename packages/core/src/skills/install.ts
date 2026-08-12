import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path'
import { z } from 'zod'
import {
  NodeHttpsAssetDownloader,
  type AssetDownloader,
} from '../environment/download'
import { extractBoundedZip } from '../environment/zip'
import { LEGACY_SKILL_STATE_FILE } from '../runtime/resources'
import {
  SkillManager,
  parseSkillMetadata,
  replaceFileAtomic,
  type SkillDirectorySnapshot,
  type SkillRequirements,
} from './manager'

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_FILES = 1_000
const MAX_PATH_BYTES = 4_096
const MAX_PATH_DEPTH = 32
const PREVIEW_TTL_MS = 10 * 60 * 1_000
const MAX_GITHUB_METADATA_BYTES = 1024 * 1024
const MAX_ACTIVE_PREVIEWS = 100
const PREVIEW_FILE = 'preview.json'
const ARCHIVE_FILE = 'archive.zip'
const EXTRACTED_DIR = 'extracted'
const PREVIEW_ID_PATTERN = /^preview_[a-f0-9]{24}$/
const SAFE_GITHUB_PART = /^[A-Za-z0-9_.-]+$/
const SAFE_GITHUB_REF = /^[A-Za-z0-9._/-]+$/
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SkillInstallSourceInput =
  { kind: 'local'; path: string } | { kind: 'url'; url: string }

export type SkillMissingRequirements = SkillRequirements

export type ResolvedSkillInstallSource =
  | {
      kind: 'local'
      path: string
      resolvedUrl: null
      repository: null
      ref: null
      requestedPath: null
    }
  | {
      kind: 'direct_https'
      path: null
      resolvedUrl: string
      repository: null
      ref: null
      requestedPath: null
    }
  | {
      kind: 'github_repo' | 'github_tree'
      path: null
      resolvedUrl: string
      repository: string
      ref: string
      requestedPath: string | null
    }

export interface SkillInstallScriptRisk {
  path: string
  type: string
}

export interface SkillInstallCandidate {
  candidateId: string
  name: string
  relativeRoot: string
  valid: boolean
  errors: string[]
  warnings: string[]
  fileCount: number
  files: string[]
  totalBytes: number
  digest: string
  scripts: SkillInstallScriptRisk[]
  externalCommands: string[]
  environmentVariables: string[]
  requirements: SkillRequirements
  missing: SkillMissingRequirements
}

export interface SkillInstallPreview {
  previewId: string
  createdAt: string
  expiresAt: string
  source: ResolvedSkillInstallSource
  digest: string
  archiveBytes: number
  unpackedBytes: number
  fileCount: number
  candidates: SkillInstallCandidate[]
}

export interface SkillInstallResult {
  name: string
  status: 'active' | 'blocked'
  digest: string
  source: ResolvedSkillInstallSource
  missing: SkillMissingRequirements
  installedAt: string
}

export interface SkillConfirmInstallInput {
  previewId: string
  digest: string
  candidateId?: string
  permissionConfirmed: boolean
}

export interface SkillInstallServiceOptions {
  manager: SkillManager
  stateRoot: string
  downloader?: AssetDownloader
  now?: () => Date
  idFactory?: () => string
  resolveMissing?: (
    requirements: SkillRequirements,
  ) => Promise<SkillMissingRequirements>
  rename?: typeof renameSync
  env?:
    | Record<string, string | undefined>
    | (() => Record<string, string | undefined>)
  platform?: NodeJS.Platform
}

export class SkillInstallService {
  private readonly manager: SkillManager
  private readonly downloader: AssetDownloader
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly resolveMissing: (
    requirements: SkillRequirements,
  ) => Promise<SkillMissingRequirements>
  private readonly rename: typeof renameSync
  private readonly activePreviews = new Map<string, string>()
  private readonly confirmingPreviews = new Set<string>()

  constructor(opts: SkillInstallServiceOptions) {
    this.manager = opts.manager
    const stateRoot = resolve(opts.stateRoot)
    if (stateRoot !== this.manager.stateRoot)
      throw new Error('Skill install state root must match SkillManager')
    this.downloader = opts.downloader ?? new NodeHttpsAssetDownloader()
    this.now = opts.now ?? (() => new Date())
    this.idFactory =
      opts.idFactory ?? (() => `preview_${randomBytes(12).toString('hex')}`)
    const configuredEnv = opts.env
    const envProvider =
      typeof configuredEnv === 'function'
        ? () => ({ ...configuredEnv() })
        : configuredEnv
          ? () => ({ ...configuredEnv })
          : () => ({ ...process.env })
    const platform = opts.platform ?? process.platform
    this.resolveMissing =
      opts.resolveMissing ??
      (async (requirements) =>
        defaultMissingRequirements(requirements, envProvider(), platform))
    this.rename = opts.rename ?? renameSync
  }

  async previewInstall(input: {
    source: SkillInstallSourceInput
  }): Promise<SkillInstallPreview> {
    this.cleanupExpiredPreviews()
    const previewId = this.idFactory()
    if (!PREVIEW_ID_PATTERN.test(previewId))
      throw new Error('Invalid Skill preview id')
    const stagingRoot = this.stagingRoot(true)
    if (
      readdirSync(stagingRoot).filter((name) => PREVIEW_ID_PATTERN.test(name))
        .length >= MAX_ACTIVE_PREVIEWS
    )
      throw new Error('Too many active Skill previews')
    const previewRoot = join(stagingRoot, previewId)
    if (pathEntryExists(previewRoot))
      throw new Error('Skill preview id collision')
    mkdirSync(previewRoot, { recursive: false, mode: 0o700 })
    const archivePath = join(previewRoot, ARCHIVE_FILE)
    try {
      const source = await this.resolveAndFetchSource(
        input.source,
        previewRoot,
        archivePath,
      )
      const archiveStat = assertRegularBoundedFile(
        archivePath,
        MAX_DOWNLOAD_BYTES,
      )
      const digest = sha256File(archivePath)
      const extractedPath = join(previewRoot, EXTRACTED_DIR)
      const extracted = extractBoundedZip({
        archive: archivePath,
        destination: extractedPath,
        maxArchiveBytes: MAX_DOWNLOAD_BYTES,
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_UNPACKED_BYTES,
        maxPathBytes: MAX_PATH_BYTES,
        maxPathDepth: MAX_PATH_DEPTH,
      })
      const candidates = await this.inspectCandidates(
        extractedPath,
        extracted.files,
        source,
      )
      if (!candidates.length)
        throw new Error('Skill archive contains no selectable SKILL.md')
      const createdAt = this.now()
      const preview = skillInstallPreviewSchema.parse({
        previewId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + PREVIEW_TTL_MS).toISOString(),
        source,
        digest,
        archiveBytes: archiveStat.size,
        unpackedBytes: extracted.totalBytes,
        fileCount: extracted.files.length,
        candidates,
      }) as SkillInstallPreview
      atomicWriteJson(join(previewRoot, PREVIEW_FILE), preview)
      this.activePreviews.set(previewId, previewFingerprint(preview))
      return structuredClone(preview)
    } catch (error) {
      rmSync(previewRoot, { recursive: true, force: true })
      throw error
    }
  }

  async confirmInstall(
    input: SkillConfirmInstallInput,
  ): Promise<SkillInstallResult> {
    if (this.confirmingPreviews.has(input.previewId))
      throw new Error('Skill preview confirmation is already running')
    this.confirmingPreviews.add(input.previewId)
    try {
      return await this.confirmInstallOnce(input)
    } finally {
      this.confirmingPreviews.delete(input.previewId)
    }
  }

  private async confirmInstallOnce(
    input: SkillConfirmInstallInput,
  ): Promise<SkillInstallResult> {
    if (!input.permissionConfirmed)
      throw new Error('Skill installation permission confirmation is required')
    if (
      !PREVIEW_ID_PATTERN.test(input.previewId) ||
      !/^[a-f0-9]{64}$/.test(input.digest)
    )
      throw new Error('Invalid Skill preview confirmation')
    const previewRoot = join(this.stagingRoot(false), input.previewId)
    const preview = this.readPreview(previewRoot)
    const expectedFingerprint = this.activePreviews.get(input.previewId)
    if (
      !expectedFingerprint ||
      expectedFingerprint !== previewFingerprint(preview)
    )
      throw new Error('Skill preview source or state changed')
    if (this.now().getTime() >= Date.parse(preview.expiresAt)) {
      this.activePreviews.delete(input.previewId)
      rmSync(previewRoot, { recursive: true, force: true })
      throw new Error('Skill preview expired')
    }
    if (preview.digest !== input.digest)
      throw new Error('Skill preview digest is stale')
    const candidate = selectCandidate(preview.candidates, input.candidateId)
    if (!candidate.valid)
      throw new Error(
        `Skill candidate is invalid: ${candidate.errors.join('; ')}`,
      )
    const archivePath = join(previewRoot, ARCHIVE_FILE)
    assertRegularBoundedFile(archivePath, MAX_DOWNLOAD_BYTES)
    if (sha256File(archivePath) !== preview.digest)
      throw new Error('Skill preview archive digest changed')
    if (
      preview.source.kind === 'local' &&
      sha256File(preview.source.path) !== preview.digest
    )
      throw new Error('Local Skill source digest changed')
    const candidateRoot = safeCandidateRoot(
      join(previewRoot, EXTRACTED_DIR),
      candidate.relativeRoot,
    )
    const snapshot = this.manager.snapshotDirectory(
      candidateRoot,
      candidate.name,
    )
    if (!snapshot.valid)
      throw new Error(`Skill candidate changed: ${snapshot.errors.join('; ')}`)
    if (snapshot.digest !== candidate.digest)
      throw new Error('Skill candidate digest changed')
    const missing = normalizeMissing(
      await this.resolveMissing(snapshot.requirements),
      snapshot.requirements,
    )
    const installedAt = this.now().toISOString()
    const status = hasMissing(missing) ? 'blocked' : 'active'
    const skillsDir = this.manager.ensureUserSkillsDirectory()
    const target = join(skillsDir, candidate.name)
    assertReplaceableSkillTarget(target)
    const stage = join(
      skillsDir,
      `.skill-install-${process.pid}-${randomBytes(6).toString('hex')}`,
    )
    const backup = join(
      skillsDir,
      `.${candidate.name}.backup-${process.pid}-${randomBytes(6).toString('hex')}`,
    )
    let movedExisting = false
    let activated = false
    try {
      writeSnapshot(stage, snapshot)
      if (status === 'blocked')
        atomicWriteJson(join(stage, LEGACY_SKILL_STATE_FILE), {
          schemaVersion: 1,
          name: candidate.name,
          status: 'blocked',
          source: 'skill_install',
          digest: preview.digest,
          requirements: snapshot.requirements,
          missing,
          installedAt,
        })
      const stagedSnapshot = this.manager.snapshotDirectory(
        stage,
        candidate.name,
      )
      if (!stagedSnapshot.valid || stagedSnapshot.digest !== snapshot.digest)
        throw new Error('Staged Skill snapshot mismatch')
      if (pathEntryExists(target)) {
        this.rename(target, backup)
        movedExisting = true
      }
      this.rename(stage, target)
      activated = true
      this.recordInstallation({
        name: candidate.name,
        status,
        source: preview.source,
        sourceDigest: preview.digest,
        candidateDigest: candidate.digest,
        requirements: snapshot.requirements,
        missing,
        installedAt,
      })
      if (movedExisting) rmSync(backup, { recursive: true, force: true })
    } catch (error) {
      rmSync(stage, { recursive: true, force: true })
      if (activated && pathEntryExists(target))
        rmSync(target, { recursive: true, force: true })
      if (movedExisting && pathEntryExists(backup)) this.rename(backup, target)
      throw error
    }
    rmSync(previewRoot, { recursive: true, force: true })
    this.activePreviews.delete(input.previewId)
    return {
      name: candidate.name,
      status,
      digest: preview.digest,
      source: preview.source,
      missing,
      installedAt,
    }
  }

  private recordInstallation(input: {
    name: string
    status: 'active' | 'blocked'
    source: ResolvedSkillInstallSource
    sourceDigest: string
    candidateDigest: string
    requirements: SkillRequirements
    missing: SkillMissingRequirements
    installedAt: string
  }): void {
    const registryPath = join(
      this.manager.userSkillsDirectory(),
      'installed.v1.json',
    )
    let registry: { schemaVersion: 1; skills: Record<string, unknown> } = {
      schemaVersion: 1,
      skills: {},
    }
    if (pathEntryExists(registryPath)) {
      const raw = JSON.parse(
        readBoundedRegularFile(
          registryPath,
          MAX_GITHUB_METADATA_BYTES,
        ).toString('utf8'),
      ) as unknown
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Number((raw as Record<string, unknown>).schemaVersion) !== 1 ||
        !(raw as Record<string, unknown>).skills ||
        typeof (raw as Record<string, unknown>).skills !== 'object'
      )
        throw new Error('Skill installation registry is invalid')
      registry = raw as typeof registry
    }
    registry.skills[input.name] = {
      name: input.name,
      source: input.source,
      sourceDigest: input.sourceDigest,
      candidateDigest: input.candidateDigest,
      status: input.status,
      requirements: input.requirements,
      missing: input.missing,
      installedAt: input.installedAt,
      updatedAt: input.installedAt,
    }
    atomicWriteJson(registryPath, registry)
  }

  removeInstallationRecord(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name))
      throw new Error('Invalid Skill installation record name')
    const registryPath = join(
      this.manager.userSkillsDirectory(),
      'installed.v1.json',
    )
    if (!pathEntryExists(registryPath)) return
    const raw = JSON.parse(
      readBoundedRegularFile(registryPath, MAX_GITHUB_METADATA_BYTES).toString(
        'utf8',
      ),
    ) as unknown
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Number((raw as Record<string, unknown>).schemaVersion) !== 1 ||
      !(raw as Record<string, unknown>).skills ||
      typeof (raw as Record<string, unknown>).skills !== 'object' ||
      Array.isArray((raw as Record<string, unknown>).skills)
    )
      throw new Error('Skill installation registry is invalid')
    const registry = raw as {
      schemaVersion: 1
      skills: Record<string, unknown>
    }
    if (!Object.prototype.hasOwnProperty.call(registry.skills, name)) return
    delete registry.skills[name]
    atomicWriteJson(registryPath, registry)
  }

  async reconcileBlocked(): Promise<{
    activated: string[]
    blocked: string[]
  }> {
    const activated: string[] = []
    const blocked: string[] = []
    for (const record of this.manager.listRecords()) {
      if (record.source !== 'user' || record.status !== 'blocked') continue
      const markerPath = join(record.root, LEGACY_SKILL_STATE_FILE)
      const marker = readInstallMarker(markerPath)
      if (!marker) continue
      const validation = this.manager.validateRecord(record)
      const missing = normalizeMissing(
        await this.resolveMissing(validation.requirements),
        validation.requirements,
      )
      if (hasMissing(missing)) {
        atomicWriteJson(markerPath, { ...marker, missing })
        blocked.push(record.name)
      } else {
        rmSync(markerPath, { force: true })
        activated.push(record.name)
      }
    }
    return { activated: activated.sort(), blocked: blocked.sort() }
  }

  private async resolveAndFetchSource(
    input: SkillInstallSourceInput,
    previewRoot: string,
    archivePath: string,
  ): Promise<ResolvedSkillInstallSource> {
    if (input?.kind === 'local') {
      const path = resolve(String(input.path ?? ''))
      if (!['.skill', '.zip'].includes(extname(path).toLowerCase()))
        throw new Error('Local Skill source must be a .skill or .zip archive')
      const content = readBoundedRegularFile(path, MAX_DOWNLOAD_BYTES)
      writeFileSync(archivePath, content, { flag: 'wx', mode: 0o600 })
      return {
        kind: 'local',
        path,
        resolvedUrl: null,
        repository: null,
        ref: null,
        requestedPath: null,
      }
    }
    if (input?.kind !== 'url') throw new Error('Unsupported Skill source')
    const url = parseSourceUrl(String(input.url ?? ''))
    if (isDirectArchiveUrl(url)) {
      await this.downloadArchive(url.toString(), archivePath)
      return {
        kind: 'direct_https',
        path: null,
        resolvedUrl: url.toString(),
        repository: null,
        ref: null,
        requestedPath: null,
      }
    }
    const github = parseGithubSourceUrl(url)
    const metadataPath = join(previewRoot, '.github-metadata.json')
    let ref: string
    let requestedPath: string | null
    let kind: 'github_repo' | 'github_tree'
    if (github.treeParts.length) {
      const resolved = await this.resolveGithubTreeRef(
        github.owner,
        github.repository,
        github.treeParts,
        metadataPath,
      )
      ref = resolved.ref
      requestedPath = requestedCandidatePath(
        resolved.requestedPath,
        github.pathKind,
      )
      kind = 'github_tree'
    } else {
      const apiUrl = `https://api.github.com/repos/${github.owner}/${github.repository}`
      await this.downloadMetadata(apiUrl, metadataPath)
      const metadata = parseGithubJson(metadataPath)
      ref = await this.resolveGithubCommit(
        github.owner,
        github.repository,
        safeGithubRef(metadata.default_branch),
        metadataPath,
      )
      requestedPath = null
      kind = 'github_repo'
    }
    rmSync(metadataPath, { force: true })
    const repository = `${github.owner}/${github.repository}`
    const resolvedUrl = `https://codeload.github.com/${repository}/zip/${encodeRef(ref)}`
    await this.downloadArchive(resolvedUrl, archivePath)
    return {
      kind,
      path: null,
      resolvedUrl,
      repository,
      ref,
      requestedPath,
    }
  }

  private async resolveGithubTreeRef(
    owner: string,
    repository: string,
    parts: string[],
    metadataPath: string,
  ): Promise<{ ref: string; requestedPath: string | null }> {
    for (let split = parts.length; split >= 1; split -= 1) {
      const ref = parts.slice(0, split).join('/')
      if (!SAFE_GITHUB_REF.test(ref) || ref.includes('..')) continue
      const apiUrl = `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(ref)}`
      try {
        await this.downloadMetadata(apiUrl, metadataPath)
        const metadata = parseGithubJson(metadataPath)
        if (
          typeof metadata.sha !== 'string' ||
          !/^[a-f0-9]{7,64}$/i.test(metadata.sha)
        )
          throw new Error('GitHub commit metadata is invalid')
        return {
          ref: String(metadata.sha).toLowerCase(),
          requestedPath:
            split < parts.length ? parts.slice(split).join('/') : null,
        }
      } catch {
        rmSync(metadataPath, { force: true })
      }
    }
    throw new Error('GitHub tree ref could not be resolved')
  }

  private async resolveGithubCommit(
    owner: string,
    repository: string,
    ref: string,
    metadataPath: string,
  ): Promise<string> {
    const apiUrl = `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(ref)}`
    await this.downloadMetadata(apiUrl, metadataPath)
    const metadata = parseGithubJson(metadataPath)
    const sha = String(metadata.sha ?? '').toLowerCase()
    if (!/^[a-f0-9]{40,64}$/.test(sha))
      throw new Error('GitHub commit metadata is invalid')
    return sha
  }

  private async downloadMetadata(
    url: string,
    destination: string,
  ): Promise<void> {
    rmSync(destination, { force: true })
    await this.downloader.download({
      url,
      destination,
      maxBytes: MAX_GITHUB_METADATA_BYTES,
      signal: new AbortController().signal,
    })
    assertRegularBoundedFile(destination, MAX_GITHUB_METADATA_BYTES)
  }

  private async downloadArchive(
    url: string,
    destination: string,
  ): Promise<void> {
    await this.downloader.download({
      url,
      destination,
      maxBytes: MAX_DOWNLOAD_BYTES,
      signal: new AbortController().signal,
    })
    assertRegularBoundedFile(destination, MAX_DOWNLOAD_BYTES)
  }

  private async inspectCandidates(
    extractedRoot: string,
    files: string[],
    source: ResolvedSkillInstallSource,
  ): Promise<SkillInstallCandidate[]> {
    const roots = new Set(
      files
        .filter((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
        .map((path) => (path === 'SKILL.md' ? '' : dirname(path)))
        .filter((root) => candidateMatchesRequestedPath(root, source)),
    )
    const candidates: SkillInstallCandidate[] = []
    for (const relativeRoot of [...roots].sort()) {
      const root = safeCandidateRoot(extractedRoot, relativeRoot)
      const content = readFileSync(join(root, 'SKILL.md'), 'utf8')
      const metadata = parseSkillMetadata(content)
      const declaredName = String(metadata.data.name ?? '').trim()
      let snapshot: SkillDirectorySnapshot | null = null
      let snapshotError = ''
      try {
        snapshot = this.manager.snapshotDirectory(root, declaredName)
      } catch (error) {
        snapshotError = errorMessage(error)
      }
      const candidateFiles = filesForCandidate(files, relativeRoot)
      const requirements = snapshot?.requirements ?? {
        bins: [],
        runtimes: [],
        env: [],
      }
      const missing = normalizeMissing(
        await this.resolveMissing(requirements),
        requirements,
      )
      const errors = [
        ...metadata.errors,
        ...(snapshot?.errors ?? []),
        ...(snapshotError ? [snapshotError] : []),
      ]
      const name =
        snapshot?.name ??
        (declaredName || basename(relativeRoot) || '<invalid>')
      candidates.push({
        candidateId: candidateId(relativeRoot),
        name,
        relativeRoot: slash(relativeRoot),
        valid: Boolean(snapshot?.valid) && errors.length === 0,
        errors: [...new Set(errors)],
        warnings: snapshot?.warnings ?? [],
        fileCount: candidateFiles.length,
        files: candidateFiles,
        totalBytes: snapshot?.totalBytes ?? 0,
        digest: snapshot?.digest ?? '0'.repeat(64),
        scripts: scriptRisks(candidateFiles),
        externalCommands: [...requirements.bins],
        environmentVariables: [...requirements.env],
        requirements,
        missing,
      })
    }
    return candidates.sort((left, right) =>
      left.name === right.name
        ? left.relativeRoot.localeCompare(right.relativeRoot)
        : left.name.localeCompare(right.name),
    )
  }

  private stagingRoot(create: boolean): string {
    const skillsDir = create
      ? this.manager.ensureUserSkillsDirectory()
      : this.manager.userSkillsDirectory()
    const canonicalSkills = realpathSync(skillsDir)
    const staging = join(canonicalSkills, '.staging')
    if (pathEntryExists(staging)) {
      const stat = lstatSync(staging)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Skill staging root is unsafe')
    } else if (create) mkdirSync(staging, { mode: 0o700 })
    else throw new Error('Skill preview not found')
    const canonicalStaging = realpathSync(staging)
    if (!isPathInside(canonicalSkills, canonicalStaging))
      throw new Error('Skill staging root escapes user Skills')
    return canonicalStaging
  }

  private readPreview(previewRoot: string): SkillInstallPreview {
    const stat = lstatSync(previewRoot)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Skill preview root is unsafe')
    const previewPath = join(previewRoot, PREVIEW_FILE)
    const parsed = skillInstallPreviewSchema.safeParse(
      JSON.parse(
        readBoundedRegularFile(previewPath, MAX_GITHUB_METADATA_BYTES).toString(
          'utf8',
        ),
      ),
    )
    if (!parsed.success) throw new Error('Skill preview state is invalid')
    return parsed.data as SkillInstallPreview
  }

  private cleanupExpiredPreviews(): void {
    let staging: string
    try {
      staging = this.stagingRoot(false)
    } catch {
      return
    }
    const now = this.now().getTime()
    for (const name of readdirSync(staging).sort().slice(0, 1_000)) {
      if (!PREVIEW_ID_PATTERN.test(name)) continue
      const root = join(staging, name)
      try {
        const preview = this.readPreview(root)
        if (now >= Date.parse(preview.expiresAt)) {
          this.activePreviews.delete(name)
          rmSync(root, { recursive: true, force: true })
        }
      } catch {
        // Corrupt previews remain isolated for diagnostics and never execute.
      }
    }
  }
}

const missingRequirementsSchema = z
  .object({
    bins: z.array(z.string()),
    runtimes: z.array(z.string()),
    env: z.array(z.string()),
  })
  .strict()

const resolvedSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('local'),
      path: z.string().min(1).max(MAX_PATH_BYTES),
      resolvedUrl: z.null(),
      repository: z.null(),
      ref: z.null(),
      requestedPath: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('direct_https'),
      path: z.null(),
      resolvedUrl: z.string().url().max(2_048),
      repository: z.null(),
      ref: z.null(),
      requestedPath: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['github_repo', 'github_tree']),
      path: z.null(),
      resolvedUrl: z.string().url().max(2_048),
      repository: z.string().min(3).max(256),
      ref: z.string().min(1).max(512),
      requestedPath: z.string().max(MAX_PATH_BYTES).nullable(),
    })
    .strict(),
])

const candidateSchema = z
  .object({
    candidateId: z.string().regex(/^candidate_[a-f0-9]{20}$/),
    name: z.string().min(1).max(128),
    relativeRoot: z.string().max(MAX_PATH_BYTES),
    valid: z.boolean(),
    errors: z.array(z.string().max(2_048)).max(256),
    warnings: z.array(z.string().max(2_048)).max(256),
    fileCount: z.number().int().nonnegative().max(MAX_FILES),
    files: z.array(z.string().min(1).max(MAX_PATH_BYTES)).max(MAX_FILES),
    totalBytes: z.number().int().nonnegative().max(MAX_UNPACKED_BYTES),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    scripts: z.array(z.object({ path: z.string(), type: z.string() }).strict()),
    externalCommands: z.array(z.string().max(256)).max(256),
    environmentVariables: z.array(z.string().max(256)).max(256),
    requirements: missingRequirementsSchema,
    missing: missingRequirementsSchema,
  })
  .strict()

const skillInstallPreviewSchema = z
  .object({
    previewId: z.string().regex(PREVIEW_ID_PATTERN),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    source: resolvedSourceSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    archiveBytes: z.number().int().nonnegative().max(MAX_DOWNLOAD_BYTES),
    unpackedBytes: z.number().int().nonnegative().max(MAX_UNPACKED_BYTES),
    fileCount: z.number().int().nonnegative().max(MAX_FILES),
    candidates: z.array(candidateSchema).min(1).max(MAX_FILES),
  })
  .strict()

function parseSourceUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Skill source URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Skill source must be a public HTTPS URL without credentials',
    )
  return url
}

function isDirectArchiveUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase()
  return path.endsWith('.skill') || path.endsWith('.zip')
}

function parseGithubSourceUrl(url: URL): {
  owner: string
  repository: string
  treeParts: string[]
  pathKind: 'tree' | 'blob' | 'raw' | null
} {
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'raw.githubusercontent.com')
    throw new Error('Network Skill source must be GitHub or a .skill/.zip URL')
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
  if (parts.length < 2 || !SAFE_GITHUB_PART.test(parts[0]!))
    throw new Error('Invalid GitHub Skill source')
  const repository = parts[1]!.replace(/\.git$/i, '')
  if (!SAFE_GITHUB_PART.test(repository))
    throw new Error('Invalid GitHub repository name')
  if (host === 'raw.githubusercontent.com') {
    if (parts.length < 4) throw new Error('Invalid raw GitHub Skill source')
    return {
      owner: parts[0]!,
      repository,
      treeParts: parts.slice(2),
      pathKind: 'raw',
    }
  }
  if (parts.length === 2)
    return { owner: parts[0]!, repository, treeParts: [], pathKind: null }
  if ((parts[2] !== 'tree' && parts[2] !== 'blob') || parts.length < 4)
    throw new Error('Only GitHub repo, tree, and blob URLs are supported')
  const treeParts = parts.slice(3)
  if (
    treeParts.length > MAX_PATH_DEPTH ||
    treeParts.some(
      (part) => !part || part === '.' || part === '..' || part.includes('\0'),
    )
  )
    throw new Error('Invalid GitHub tree path')
  return {
    owner: parts[0]!,
    repository,
    treeParts,
    pathKind: parts[2] as 'tree' | 'blob',
  }
}

function requestedCandidatePath(
  requestedPath: string | null,
  kind: 'tree' | 'blob' | 'raw' | null,
): string | null {
  if (!requestedPath) return null
  const normalized = slash(requestedPath)
  if (/\/(?:docs\/)?install\.md$/i.test(`/${normalized}`)) return null
  if (
    (kind === 'blob' || kind === 'raw') &&
    /\/SKILL\.md$/i.test(`/${normalized}`)
  )
    return slash(dirname(normalized)) === '.' ? '' : slash(dirname(normalized))
  return normalized
}

function safeGithubRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : ''
  if (!ref || !SAFE_GITHUB_REF.test(ref) || ref.includes('..'))
    throw new Error('GitHub default branch is unsafe')
  return ref
}

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}

function parseGithubJson(path: string): Record<string, unknown> {
  const raw = JSON.parse(
    readBoundedRegularFile(path, MAX_GITHUB_METADATA_BYTES).toString('utf8'),
  ) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('GitHub metadata is invalid')
  return raw as Record<string, unknown>
}

function candidateMatchesRequestedPath(
  candidateRoot: string,
  source: ResolvedSkillInstallSource,
): boolean {
  if (source.kind !== 'github_tree' || !source.requestedPath) return true
  const parts = slash(candidateRoot).split('/')
  const withoutArchiveRoot = parts.slice(1).join('/')
  return (
    withoutArchiveRoot === source.requestedPath ||
    withoutArchiveRoot.startsWith(`${source.requestedPath}/`)
  )
}

function filesForCandidate(files: string[], root: string): string[] {
  const prefix = root ? `${slash(root)}/` : ''
  return files
    .filter((path) => !prefix || path.startsWith(prefix))
    .map((path) => (prefix ? path.slice(prefix.length) : path))
    .sort()
}

function scriptRisks(files: string[]): SkillInstallScriptRisk[] {
  return files
    .filter((path) => path.startsWith('scripts/'))
    .map((path) => ({ path, type: scriptType(path) }))
}

function scriptType(path: string): string {
  const extension = extname(path).toLowerCase()
  return (
    {
      '.sh': 'shell',
      '.bash': 'shell',
      '.zsh': 'shell',
      '.ps1': 'powershell',
      '.bat': 'batch',
      '.cmd': 'batch',
      '.py': 'python',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.ts': 'typescript',
      '.exe': 'executable',
    }[extension] ?? 'unknown'
  )
}

function candidateId(relativeRoot: string): string {
  return `candidate_${createHash('sha256')
    .update(slash(relativeRoot), 'utf8')
    .digest('hex')
    .slice(0, 20)}`
}

function selectCandidate(
  candidates: SkillInstallCandidate[],
  candidateIdValue: string | undefined,
): SkillInstallCandidate {
  if (!candidateIdValue && candidates.length !== 1)
    throw new Error('Skill candidate selection is required')
  const candidate = candidateIdValue
    ? candidates.find((entry) => entry.candidateId === candidateIdValue)
    : candidates[0]
  if (!candidate) throw new Error('Skill candidate was not found')
  return candidate
}

function safeCandidateRoot(
  extractedRoot: string,
  relativeRoot: string,
): string {
  const root = realpathSync(extractedRoot)
  const normalized = slash(relativeRoot)
  if (
    normalized &&
    (normalized.startsWith('/') ||
      normalized
        .split('/')
        .some((part) => !part || part === '.' || part === '..'))
  )
    throw new Error('Skill candidate root is unsafe')
  const candidate = normalized ? join(root, ...normalized.split('/')) : root
  const canonical = realpathSync(candidate)
  if (!isPathInside(root, canonical))
    throw new Error('Skill candidate root escapes staging')
  return canonical
}

function writeSnapshot(root: string, snapshot: SkillDirectorySnapshot): void {
  mkdirSync(root, { recursive: false, mode: 0o700 })
  for (const file of snapshot.files) {
    const path = safeSnapshotPath(root, file.path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, file.data, { flag: 'wx', mode: 0o600 })
  }
}

function safeSnapshotPath(root: string, value: string): string {
  const normalized = slash(value)
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Skill snapshot path is unsafe')
  return join(root, ...normalized.split('/'))
}

function assertReplaceableSkillTarget(path: string): void {
  if (!pathEntryExists(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Existing Skill target is unsafe')
}

function readBoundedRegularFile(path: string, maxBytes: number): Buffer {
  const pathStat = lstatSync(path, { bigint: true })
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.size > BigInt(maxBytes)
  )
    throw new Error('Skill archive must be a bounded regular file')
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (
      !before.isFile() ||
      before.size > BigInt(maxBytes) ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino ||
      pathStat.size !== before.size ||
      pathStat.mtimeNs !== before.mtimeNs
    )
      throw new Error('Skill archive must be a bounded regular file')
    const content = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.size !== BigInt(content.byteLength)
    )
      throw new Error('Skill archive changed while reading')
    return content
  } finally {
    closeSync(descriptor)
  }
}

function assertRegularBoundedFile(
  path: string,
  maxBytes: number,
): { size: number } {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes)
    throw new Error('Skill archive must be a bounded regular file')
  return { size: stat.size }
}

function sha256File(path: string): string {
  return createHash('sha256')
    .update(readBoundedRegularFile(path, MAX_DOWNLOAD_BYTES))
    .digest('hex')
}

function normalizeMissing(
  value: SkillMissingRequirements,
  declared: SkillRequirements,
): SkillMissingRequirements {
  const parsed = missingRequirementsSchema.parse(value)
  return {
    bins: intersection(parsed.bins, declared.bins),
    runtimes: intersection(parsed.runtimes, declared.runtimes),
    env: intersection(parsed.env, declared.env),
  }
}

function intersection(values: string[], declared: string[]): string[] {
  const allowed = new Set(declared)
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => allowed.has(value)),
    ),
  ].sort()
}

function hasMissing(missing: SkillMissingRequirements): boolean {
  return Boolean(
    missing.bins.length || missing.runtimes.length || missing.env.length,
  )
}

function defaultMissingRequirements(
  requirements: SkillRequirements,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): SkillMissingRequirements {
  const pathEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => isAbsolute(entry))
  const bins = requirements.bins.filter(
    (name) => !resolveExecutable(name, pathEntries, env, platform),
  )
  const runtimeExecutables: Record<string, string[]> = {
    node: ['node'],
    python: ['python3', 'python'],
    go: ['go'],
    rust: ['rustc'],
  }
  const runtimes = requirements.runtimes.filter((runtime) => {
    const executables = runtimeExecutables[runtime.toLowerCase()]
    return (
      !executables ||
      !executables.some((name) =>
        resolveExecutable(name, pathEntries, env, platform),
      )
    )
  })
  const missingEnv = requirements.env.filter(
    (name) => !SAFE_ENV_NAME.test(name) || !env[name],
  )
  return {
    bins: [...new Set(bins)].sort(),
    runtimes: [...new Set(runtimes)].sort(),
    env: [...new Set(missingEnv)].sort(),
  }
}

function resolveExecutable(
  name: string,
  pathEntries: string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null
  const extensions =
    platform === 'win32' && !extname(name)
      ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry))
      : ['']
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate =
        platform === 'win32'
          ? win32.join(directory, `${name}${extension}`)
          : join(directory, `${name}${extension}`)
      try {
        const canonical = realpathSync(candidate)
        accessSync(canonical, constants.X_OK)
        const stat = lstatSync(canonical)
        if (!stat.isSymbolicLink() && stat.isFile()) return canonical
      } catch {
        // Continue through the bounded PATH candidates.
      }
    }
  }
  return null
}

function readInstallMarker(path: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    const value = JSON.parse(
      readBoundedRegularFile(path, 64 * 1024).toString('utf8'),
    ) as unknown
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).status !== 'blocked' ||
      (value as Record<string, unknown>).source !== 'skill_install'
    )
      return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    replaceFileAtomic(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function previewFingerprint(preview: SkillInstallPreview): string {
  return createHash('sha256').update(stableJson(preview), 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

function slash(path: string): string {
  return path.split(sep).join('/')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
