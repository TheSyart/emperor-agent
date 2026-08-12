import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { isPathWithin } from '../util/paths'

const PUBLIC_SCRIPT_NAMES = ['dev', 'start', 'preview', 'serve', 'web'] as const
const MAX_MANIFEST_BYTES = 1_048_576

export type ProjectLaunchEcosystem =
  'node' | 'python' | 'go' | 'rust' | 'static'

export interface ProjectLaunchCandidate {
  id: string
  name: string
  ecosystem: ProjectLaunchEcosystem
  source: string
  previewCapable: boolean
  available: boolean
  unavailableReason?: string
}

export type ProjectLaunchSpec =
  | {
      kind: 'process'
      candidateId: string
      name: string
      ecosystem: Exclude<ProjectLaunchEcosystem, 'static'>
      executable: string
      args: string[]
      cwd: string
      env: Record<string, string>
      previewCapable: boolean
    }
  | {
      kind: 'static'
      candidateId: string
      name: string
      ecosystem: 'static'
      entryPath: string
      cwd: string
      previewCapable: true
      env: Record<string, string>
    }

export interface ProjectLaunchDetectionInput {
  projectRoot: string
  toolPaths: Readonly<Record<string, string | undefined>>
}

export class ProjectLaunchCandidateError extends Error {
  readonly code:
    'project_launch_candidate_invalid' | 'project_launch_candidate_unavailable'

  constructor(
    code:
      | 'project_launch_candidate_invalid'
      | 'project_launch_candidate_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ProjectLaunchCandidateError'
    this.code = code
  }
}

interface DetectedCandidate {
  descriptor: ProjectLaunchCandidate
  build(port: number): ProjectLaunchSpec
}

/**
 * Deterministic, manifest-only project launch discovery. Public descriptors
 * intentionally never contain executable paths, argv, cwd or environment.
 */
export class ProjectLaunchCandidateDetector {
  detect(input: ProjectLaunchDetectionInput): ProjectLaunchCandidate[] {
    return this.detectPrivate(input).map(({ descriptor }) => ({
      ...descriptor,
    }))
  }

  resolve(
    input: ProjectLaunchDetectionInput & { candidateId: string; port: number },
  ): ProjectLaunchSpec {
    const candidate = this.detectPrivate(input).find(
      ({ descriptor }) => descriptor.id === input.candidateId,
    )
    if (!candidate)
      throw new ProjectLaunchCandidateError(
        'project_launch_candidate_invalid',
        '项目启动候选不存在或已经失效。',
      )
    if (!candidate.descriptor.available)
      throw new ProjectLaunchCandidateError(
        'project_launch_candidate_unavailable',
        candidate.descriptor.unavailableReason || '项目启动候选不可用。',
      )
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
      throw new ProjectLaunchCandidateError(
        'project_launch_candidate_invalid',
        '项目启动端口无效。',
      )
    return candidate.build(input.port)
  }

  private detectPrivate(
    input: ProjectLaunchDetectionInput,
  ): DetectedCandidate[] {
    const root = canonicalDirectory(input.projectRoot)
    const candidates: DetectedCandidate[] = []
    candidates.push(...this.nodeCandidates(root, input.toolPaths))
    candidates.push(...this.pythonCandidates(root, input.toolPaths))
    candidates.push(...this.goCandidates(root, input.toolPaths))
    candidates.push(...this.rustCandidates(root, input.toolPaths))
    candidates.push(...this.staticCandidates(root))
    return candidates
  }

  private nodeCandidates(
    root: string,
    toolPaths: Readonly<Record<string, string | undefined>>,
  ): DetectedCandidate[] {
    const manifest = readRootFile(root, 'package.json')
    if (!manifest) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(manifest.content)
    } catch {
      return []
    }
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return []
    const scripts = parsed.scripts
    const manager = packageManager(root)
    const executable = toolPaths[manager]
    const unavailableReason = executable
      ? undefined
      : `${manager} 不在受信工具目录中`
    return PUBLIC_SCRIPT_NAMES.flatMap((script) => {
      if (typeof scripts[script] !== 'string') return []
      const name = `${manager} run ${script}`
      return [
        createCandidate({
          root,
          ecosystem: 'node',
          source: `package.json#scripts.${script}`,
          fingerprint: manifest.content,
          name,
          available: Boolean(executable),
          unavailableReason,
          build: (candidateId, port) => ({
            kind: 'process',
            candidateId,
            name,
            ecosystem: 'node',
            executable: executable!,
            args: ['run', script],
            cwd: root,
            env: previewEnvironment(port),
            previewCapable: true,
          }),
        }),
      ]
    })
  }

  private pythonCandidates(
    root: string,
    toolPaths: Readonly<Record<string, string | undefined>>,
  ): DetectedCandidate[] {
    const candidates: DetectedCandidate[] = []
    const manifest = readRootFile(root, 'pyproject.toml')
    if (manifest) {
      const parsed = safeToml(manifest.content)
      const scripts = nestedRecord(parsed, 'project', 'scripts')
      const uv = toolPaths.uv
      for (const script of PUBLIC_SCRIPT_NAMES) {
        if (typeof scripts?.[script] !== 'string') continue
        const name = `uv run ${script}`
        candidates.push(
          createCandidate({
            root,
            ecosystem: 'python',
            source: `pyproject.toml#project.scripts.${script}`,
            fingerprint: manifest.content,
            name,
            available: Boolean(uv),
            unavailableReason: uv ? undefined : 'uv 不在受信工具目录中',
            build: (candidateId, port) => ({
              kind: 'process',
              candidateId,
              name,
              ecosystem: 'python',
              executable: uv!,
              args: ['run', script],
              cwd: root,
              env: previewEnvironment(port),
              previewCapable: true,
            }),
          }),
        )
      }
    }
    const django = readRootFile(root, 'manage.py')
    if (django) {
      const python = toolPaths.python
      const name = 'Django development server'
      candidates.push(
        createCandidate({
          root,
          ecosystem: 'python',
          source: 'manage.py',
          fingerprint: django.content,
          name,
          available: Boolean(python),
          unavailableReason: python ? undefined : 'python 不在受信工具目录中',
          build: (candidateId, port) => ({
            kind: 'process',
            candidateId,
            name,
            ecosystem: 'python',
            executable: python!,
            args: ['manage.py', 'runserver', `127.0.0.1:${port}`],
            cwd: root,
            env: previewEnvironment(port),
            previewCapable: true,
          }),
        }),
      )
    }
    return candidates
  }

  private goCandidates(
    root: string,
    toolPaths: Readonly<Record<string, string | undefined>>,
  ): DetectedCandidate[] {
    const manifest = readRootFile(root, 'go.mod')
    if (!manifest || !rootContainsGoMain(root)) return []
    const executable = toolPaths.go
    const name = 'go run .'
    return [
      createCandidate({
        root,
        ecosystem: 'go',
        source: 'go.mod',
        fingerprint: manifest.content,
        name,
        available: Boolean(executable),
        unavailableReason: executable ? undefined : 'go 不在受信工具目录中',
        build: (candidateId, port) => ({
          kind: 'process',
          candidateId,
          name,
          ecosystem: 'go',
          executable: executable!,
          args: ['run', '.'],
          cwd: root,
          env: previewEnvironment(port),
          previewCapable: true,
        }),
      }),
    ]
  }

  private rustCandidates(
    root: string,
    toolPaths: Readonly<Record<string, string | undefined>>,
  ): DetectedCandidate[] {
    const manifest = readRootFile(root, 'Cargo.toml')
    if (!manifest) return []
    const parsed = safeToml(manifest.content)
    const parsedRecord = isRecord(parsed) ? parsed : null
    const packageRecord = nestedRecord(parsedRecord, 'package')
    const defaultRun = textValue(packageRecord?.['default-run'])
    const bins = Array.isArray(parsedRecord?.bin)
      ? (parsedRecord.bin as unknown[])
          .filter(isRecord)
          .map((bin) => textValue(bin.name))
          .filter((name): name is string => Boolean(name))
      : []
    const implicitMain = Boolean(readRootFile(root, 'src/main.rs'))
    if (
      !defaultRun &&
      bins.length !== 1 &&
      !(bins.length === 0 && implicitMain)
    )
      return []
    const selectedBin = defaultRun || (bins.length === 1 ? bins[0] : null)
    const executable = toolPaths.cargo
    const name = selectedBin ? `cargo run · ${selectedBin}` : 'cargo run'
    return [
      createCandidate({
        root,
        ecosystem: 'rust',
        source: 'Cargo.toml',
        fingerprint: manifest.content,
        name,
        available: Boolean(executable),
        unavailableReason: executable ? undefined : 'cargo 不在受信工具目录中',
        build: (candidateId, port) => ({
          kind: 'process',
          candidateId,
          name,
          ecosystem: 'rust',
          executable: executable!,
          args: [
            'run',
            '--locked',
            ...(selectedBin ? ['--bin', selectedBin] : []),
          ],
          cwd: root,
          env: previewEnvironment(port),
          previewCapable: true,
        }),
      }),
    ]
  }

  private staticCandidates(root: string): DetectedCandidate[] {
    const entry = readRootFile(root, 'index.html')
    if (!entry) return []
    const name = 'Static website'
    return [
      createCandidate({
        root,
        ecosystem: 'static',
        source: 'index.html',
        fingerprint: entry.content,
        name,
        available: true,
        build: (candidateId, port) => ({
          kind: 'static',
          candidateId,
          name,
          ecosystem: 'static',
          entryPath: entry.path,
          cwd: root,
          previewCapable: true,
          env: previewEnvironment(port),
        }),
      }),
    ]
  }
}

function createCandidate(input: {
  root: string
  ecosystem: ProjectLaunchEcosystem
  source: string
  fingerprint: string
  name: string
  available: boolean
  unavailableReason?: string
  build: (candidateId: string, port: number) => ProjectLaunchSpec
}): DetectedCandidate {
  const id = `launch_${input.ecosystem}_${createHash('sha256')
    .update(
      `${input.root}\0${input.ecosystem}\0${input.source}\0${input.fingerprint}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 24)}`
  return {
    descriptor: {
      id,
      name: input.name,
      ecosystem: input.ecosystem,
      source: input.source,
      previewCapable: true,
      available: input.available,
      ...(input.unavailableReason
        ? { unavailableReason: input.unavailableReason }
        : {}),
    },
    build: (port) => input.build(id, port),
  }
}

function canonicalDirectory(path: string): string {
  const absolute = resolve(path)
  const real = realpathSync(absolute)
  if (!lstatSync(real).isDirectory())
    throw new ProjectLaunchCandidateError(
      'project_launch_candidate_invalid',
      '项目根目录无效。',
    )
  return real
}

function readRootFile(
  root: string,
  name: string,
): { path: string; content: string } | null {
  const path = join(root, name)
  if (!existsSync(path)) return null
  try {
    const real = realpathSync(path)
    if (!isPathWithin(real, root) || !lstatSync(real).isFile()) return null
    const bytes = lstatSync(real).size
    if (bytes > MAX_MANIFEST_BYTES) return null
    return { path: real, content: readFileSync(real, 'utf8') }
  } catch {
    return null
  }
}

function packageManager(root: string): 'npm' | 'pnpm' | 'yarn' {
  if (readRootFile(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (readRootFile(root, 'yarn.lock')) return 'yarn'
  return 'npm'
}

function previewEnvironment(port: number): Record<string, string> {
  return {
    HOST: '127.0.0.1',
    PORT: String(port),
    BROWSER: 'none',
  }
}

function safeToml(content: string): unknown {
  try {
    return parseToml(content)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nestedRecord(
  value: unknown,
  ...keys: string[]
): Record<string, unknown> | null {
  let current: unknown = value
  for (const key of keys) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return isRecord(current) ? current : null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function rootContainsGoMain(root: string): boolean {
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.go')) return false
      const file = readRootFile(root, basename(entry.name))
      return Boolean(file && /^\s*package\s+main\b/m.test(file.content))
    })
  } catch {
    return false
  }
}
