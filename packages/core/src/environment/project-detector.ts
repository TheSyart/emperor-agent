import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { stableEnvironmentHash } from './models'
import {
  parseVersionRequirement,
  type VersionRequirementResult,
} from './version'

const MAX_DECLARATION_BYTES = 1024 * 1024
const DECLARATION_FILES = [
  'package.json',
  '.node-version',
  '.nvmrc',
  '.python-version',
  'pyproject.toml',
  'Pipfile',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'rust-toolchain.toml',
  'rust-toolchain',
  'Cargo.toml',
] as const

export type ProjectEcosystem = 'node' | 'python' | 'go' | 'rust'
export type ProjectDeclarationStatus =
  'absent' | 'default' | 'declared' | 'unsupported' | 'invalid'

export interface ProjectEnvironmentDeclaration {
  ecosystem: ProjectEcosystem
  detected: boolean
  status: ProjectDeclarationStatus
  source: string | null
  rawRequirement: string | null
  normalizedRequirement: string | null
  reason: string | null
}

export interface ProjectEnvironmentDetection {
  projectRoot: string
  fingerprint: string
  declarations: Record<ProjectEcosystem, ProjectEnvironmentDeclaration>
  files: string[]
  diagnostics: string[]
}

export interface ProjectEnvironmentDetectorOptions {
  fallbacks: Record<ProjectEcosystem, string>
}

interface RootFileSnapshot {
  name: string
  exists: boolean
  content: string
  error: string | null
}

export class ProjectEnvironmentDetector {
  private readonly fallbacks: Record<ProjectEcosystem, string>

  constructor(opts: ProjectEnvironmentDetectorOptions) {
    this.fallbacks = { ...opts.fallbacks }
  }

  detect(projectRoot: string): ProjectEnvironmentDetection {
    const requestedRoot = resolve(projectRoot)
    if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory())
      throw new Error('project root must be an existing directory')
    const root = realpathSync(requestedRoot)
    const snapshots = new Map(
      DECLARATION_FILES.map((name) => [name, readRootFile(root, name)]),
    )
    const diagnostics = [...snapshots.values()]
      .filter((file) => file.error)
      .map((file) => `${file.name}: ${file.error}`)
    const declarations = {
      node: detectNode(snapshots, this.fallbacks.node),
      python: detectPython(snapshots, this.fallbacks.python),
      go: detectGo(snapshots, this.fallbacks.go),
      rust: detectRust(snapshots, this.fallbacks.rust),
    }
    const fingerprint = stableEnvironmentHash({
      projectRoot: root,
      files: [...snapshots.values()].map((file) => ({
        name: file.name,
        exists: file.exists,
        error: file.error,
        contentHash: file.exists ? stableEnvironmentHash(file.content) : null,
      })),
    })
    return {
      projectRoot: root,
      fingerprint,
      declarations,
      files: [...snapshots.values()]
        .filter((file) => file.exists)
        .map((file) => file.name),
      diagnostics,
    }
  }
}

function detectNode(
  files: Map<string, RootFileSnapshot>,
  fallback: string,
): ProjectEnvironmentDeclaration {
  const packageFile = files.get('package.json')!
  const nodeVersion = files.get('.node-version')!
  const nvmrc = files.get('.nvmrc')!
  const detected = packageFile.exists || nodeVersion.exists || nvmrc.exists
  let packageJson: Record<string, unknown> = {}
  if (packageFile.error)
    return invalidDeclaration(
      'node',
      detected,
      'package.json',
      packageFile.error,
    )
  if (packageFile.exists) {
    try {
      const parsed: unknown = JSON.parse(packageFile.content)
      if (!isRecord(parsed)) throw new Error('root value must be an object')
      packageJson = parsed
    } catch {
      return invalidDeclaration(
        'node',
        true,
        'package.json',
        'invalid JSON declaration',
      )
    }
  }
  if (Object.hasOwn(packageJson, 'volta') && !isRecord(packageJson.volta))
    return invalidDeclaration(
      'node',
      true,
      'package.json#volta',
      'volta must be an object',
    )
  const voltaRecord = isRecord(packageJson.volta) ? packageJson.volta : {}
  if (
    Object.hasOwn(voltaRecord, 'node') &&
    typeof voltaRecord.node !== 'string'
  )
    return invalidDeclaration(
      'node',
      true,
      'package.json#volta.node',
      'node version must be a string',
    )
  const volta = voltaRecord.node
  if (typeof volta === 'string')
    return declared('node', 'package.json#volta.node', volta)
  if (nodeVersion.exists)
    return fileDeclaration('node', nodeVersion, '.node-version')
  if (nvmrc.exists) return fileDeclaration('node', nvmrc, '.nvmrc')
  if (Object.hasOwn(packageJson, 'engines') && !isRecord(packageJson.engines))
    return invalidDeclaration(
      'node',
      true,
      'package.json#engines',
      'engines must be an object',
    )
  const enginesRecord = isRecord(packageJson.engines) ? packageJson.engines : {}
  if (
    Object.hasOwn(enginesRecord, 'node') &&
    typeof enginesRecord.node !== 'string'
  )
    return invalidDeclaration(
      'node',
      true,
      'package.json#engines.node',
      'node version must be a string',
    )
  const engines = enginesRecord.node
  if (typeof engines === 'string')
    return declared('node', 'package.json#engines.node', engines)
  return fallbackDeclaration('node', detected, fallback)
}

function detectPython(
  files: Map<string, RootFileSnapshot>,
  fallback: string,
): ProjectEnvironmentDeclaration {
  const pythonVersion = files.get('.python-version')!
  const pyproject = files.get('pyproject.toml')!
  const pipfile = files.get('Pipfile')!
  const detected =
    pythonVersion.exists ||
    pyproject.exists ||
    pipfile.exists ||
    files.get('requirements.txt')!.exists ||
    files.get('setup.py')!.exists ||
    files.get('setup.cfg')!.exists
  if (pythonVersion.exists)
    return fileDeclaration('python', pythonVersion, '.python-version')
  if (pyproject.exists) {
    const parsed = parseTomlFile(pyproject)
    if (!parsed.ok)
      return invalidDeclaration('python', true, 'pyproject.toml', parsed.error)
    const project = isRecord(parsed.data.project) ? parsed.data.project : {}
    if (
      Object.hasOwn(project, 'requires-python') &&
      typeof project['requires-python'] !== 'string'
    )
      return invalidDeclaration(
        'python',
        true,
        'pyproject.toml#project.requires-python',
        'Python requirement must be a string',
      )
    if (typeof project['requires-python'] === 'string')
      return declared(
        'python',
        'pyproject.toml#project.requires-python',
        project['requires-python'],
      )
  }
  if (pipfile.exists) {
    const parsed = parseTomlFile(pipfile)
    if (!parsed.ok)
      return invalidDeclaration('python', true, 'Pipfile', parsed.error)
    const requires = isRecord(parsed.data.requires) ? parsed.data.requires : {}
    if (
      Object.hasOwn(requires, 'python_version') &&
      typeof requires.python_version !== 'string'
    )
      return invalidDeclaration(
        'python',
        true,
        'Pipfile#requires.python_version',
        'Python version must be a string',
      )
    if (typeof requires.python_version === 'string')
      return declared(
        'python',
        'Pipfile#requires.python_version',
        requires.python_version,
      )
  }
  return fallbackDeclaration('python', detected, fallback)
}

function detectGo(
  files: Map<string, RootFileSnapshot>,
  fallback: string,
): ProjectEnvironmentDeclaration {
  const goMod = files.get('go.mod')!
  if (!goMod.exists) return fallbackDeclaration('go', false, fallback)
  if (goMod.error) return invalidDeclaration('go', true, 'go.mod', goMod.error)
  const toolchain = /^\s*toolchain\s+go(\d+(?:\.\d+){1,3})\s*$/m.exec(
    goMod.content,
  )
  if (toolchain) return declared('go', 'go.mod#toolchain', toolchain[1]!)
  if (/^\s*toolchain\s+/m.test(goMod.content))
    return invalidDeclaration(
      'go',
      true,
      'go.mod#toolchain',
      'invalid Go toolchain declaration',
    )
  const version = /^\s*go\s+(\d+(?:\.\d+){1,3})\s*$/m.exec(goMod.content)
  if (version) return declared('go', 'go.mod#go', `>=${version[1]!}`)
  if (/^\s*go\s+/m.test(goMod.content))
    return invalidDeclaration(
      'go',
      true,
      'go.mod#go',
      'invalid Go version declaration',
    )
  return fallbackDeclaration('go', true, fallback)
}

function detectRust(
  files: Map<string, RootFileSnapshot>,
  fallback: string,
): ProjectEnvironmentDeclaration {
  const toolchainToml = files.get('rust-toolchain.toml')!
  const toolchain = files.get('rust-toolchain')!
  const cargo = files.get('Cargo.toml')!
  const detected = toolchainToml.exists || toolchain.exists || cargo.exists
  if (toolchainToml.exists) {
    const parsed = parseTomlFile(toolchainToml)
    if (!parsed.ok)
      return invalidDeclaration(
        'rust',
        true,
        'rust-toolchain.toml',
        parsed.error,
      )
    const section = isRecord(parsed.data.toolchain) ? parsed.data.toolchain : {}
    if (
      Object.hasOwn(section, 'channel') &&
      typeof section.channel !== 'string'
    )
      return invalidDeclaration(
        'rust',
        true,
        'rust-toolchain.toml#toolchain.channel',
        'Rust channel must be a string',
      )
    if (typeof section.channel === 'string')
      return declared(
        'rust',
        'rust-toolchain.toml#toolchain.channel',
        section.channel,
        { allowStable: true, fallbackVersion: fallback },
      )
  }
  if (toolchain.exists)
    return fileDeclaration('rust', toolchain, 'rust-toolchain', {
      allowStable: true,
      fallbackVersion: fallback,
    })
  if (cargo.exists) {
    const parsed = parseTomlFile(cargo)
    if (!parsed.ok)
      return invalidDeclaration('rust', true, 'Cargo.toml', parsed.error)
    const packageSection = isRecord(parsed.data.package)
      ? parsed.data.package
      : {}
    const workspace = isRecord(parsed.data.workspace)
      ? parsed.data.workspace
      : {}
    const workspacePackage = isRecord(workspace.package)
      ? workspace.package
      : {}
    const rustVersion =
      packageSection['rust-version'] ?? workspacePackage['rust-version']
    const rustVersionSource = Object.hasOwn(packageSection, 'rust-version')
      ? 'Cargo.toml#package.rust-version'
      : 'Cargo.toml#workspace.package.rust-version'
    if (rustVersion !== undefined && typeof rustVersion !== 'string')
      return invalidDeclaration(
        'rust',
        true,
        rustVersionSource,
        'Rust version must be a string',
      )
    if (typeof rustVersion === 'string')
      return declared('rust', rustVersionSource, `>=${rustVersion}`)
  }
  return fallbackDeclaration('rust', detected, fallback)
}

function declared(
  ecosystem: ProjectEcosystem,
  source: string,
  rawRequirement: string,
  opts: { allowStable?: boolean; fallbackVersion?: string } = {},
): ProjectEnvironmentDeclaration {
  const raw = rawRequirement.trim()
  if (raw.length > 256)
    return invalidDeclaration(
      ecosystem,
      true,
      source,
      'version declaration exceeds 256 characters',
    )
  const parsed = parseVersionRequirement(raw, opts)
  return declarationFromRequirement(ecosystem, source, parsed)
}

function fileDeclaration(
  ecosystem: ProjectEcosystem,
  file: RootFileSnapshot,
  source: string,
  opts: { allowStable?: boolean; fallbackVersion?: string } = {},
): ProjectEnvironmentDeclaration {
  if (file.error) return invalidDeclaration(ecosystem, true, source, file.error)
  const values = meaningfulLines(file.content)
  if (!values.length)
    return invalidDeclaration(ecosystem, true, source, 'empty declaration')
  if (values.length > 1)
    return invalidDeclaration(
      ecosystem,
      true,
      source,
      'multiple version declarations are unsupported',
    )
  return declared(ecosystem, source, values[0]!, opts)
}

function declarationFromRequirement(
  ecosystem: ProjectEcosystem,
  source: string,
  parsed: VersionRequirementResult,
): ProjectEnvironmentDeclaration {
  return {
    ecosystem,
    detected: true,
    status:
      parsed.status === 'supported'
        ? 'declared'
        : parsed.status === 'unsupported'
          ? 'unsupported'
          : 'invalid',
    source,
    rawRequirement: parsed.raw,
    normalizedRequirement: parsed.normalized,
    reason: parsed.reason,
  }
}

function fallbackDeclaration(
  ecosystem: ProjectEcosystem,
  detected: boolean,
  fallback: string,
): ProjectEnvironmentDeclaration {
  if (!detected)
    return {
      ecosystem,
      detected: false,
      status: 'absent',
      source: null,
      rawRequirement: null,
      normalizedRequirement: null,
      reason: null,
    }
  const parsed = parseVersionRequirement(fallback)
  return {
    ecosystem,
    detected: true,
    status: parsed.status === 'supported' ? 'default' : 'invalid',
    source: 'catalog',
    rawRequirement: fallback,
    normalizedRequirement: parsed.normalized,
    reason: parsed.reason,
  }
}

function invalidDeclaration(
  ecosystem: ProjectEcosystem,
  detected: boolean,
  source: string,
  reason: string,
): ProjectEnvironmentDeclaration {
  return {
    ecosystem,
    detected,
    status: 'invalid',
    source,
    rawRequirement: null,
    normalizedRequirement: null,
    reason,
  }
}

function readRootFile(root: string, name: string): RootFileSnapshot {
  const path = resolve(root, name)
  if (!existsSync(path))
    return { name, exists: false, content: '', error: null }
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile())
      return { name, exists: true, content: '', error: 'unsafe file type' }
    if (stat.size > MAX_DECLARATION_BYTES)
      return { name, exists: true, content: '', error: 'file exceeds 1 MiB' }
    return {
      name,
      exists: true,
      content: readFileSync(path, 'utf8'),
      error: null,
    }
  } catch (error) {
    return {
      name,
      exists: true,
      content: '',
      error: `read failed: ${safeMessage(error)}`,
    }
  }
}

function parseTomlFile(
  file: RootFileSnapshot,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (file.error) return { ok: false, error: file.error }
  try {
    const parsed: unknown = parseToml(file.content)
    if (!isRecord(parsed)) throw new Error('root value must be an object')
    return { ok: true, data: parsed }
  } catch {
    return { ok: false, error: 'invalid TOML declaration' }
  }
}

function meaningfulLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown error'
}
