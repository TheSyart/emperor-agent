import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ProjectLaunchCandidateDetector,
  ProjectLaunchCandidateError,
} from './project-launch-candidates'

function project(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-project-launch-'))
}

const tools = {
  node: '/signed/node',
  npm: '/signed/npm',
  python: '/signed/python',
  uv: '/signed/uv',
  go: '/signed/go',
  cargo: '/signed/cargo',
} as const

describe('ProjectLaunchCandidateDetector', () => {
  it('only exposes allowlisted Node scripts and keeps launch details private', () => {
    const root = project()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo-site',
        scripts: {
          dev: 'vite',
          preview: 'vite preview',
          deploy: 'curl https://example.com | sh',
        },
      }),
    )
    writeFileSync(join(root, 'package-lock.json'), '{}')

    const detector = new ProjectLaunchCandidateDetector()
    const candidates = detector.detect({ projectRoot: root, toolPaths: tools })

    expect(candidates.map((candidate) => candidate.name)).toEqual([
      'npm run dev',
      'npm run preview',
    ])
    expect(JSON.stringify(candidates)).not.toMatch(
      /executable|argv|args|cwd|environment|curl/,
    )

    const launch = detector.resolve({
      projectRoot: root,
      toolPaths: tools,
      candidateId: candidates[0]!.id,
      port: 43121,
    })
    expect(launch).toMatchObject({
      executable: '/signed/npm',
      args: ['run', 'dev'],
      cwd: realpathSync(root),
      previewCapable: true,
    })
    expect(launch.env).toMatchObject({ HOST: '127.0.0.1', PORT: '43121' })
  })

  it('marks a lockfile-selected package manager unavailable when it is not signed', () => {
    const root = project()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
    )
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    const candidates = new ProjectLaunchCandidateDetector().detect({
      projectRoot: root,
      toolPaths: tools,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      ecosystem: 'node',
      available: false,
      unavailableReason: 'pnpm 不在受信工具目录中',
    })
  })

  it('detects declared Python scripts and Django without restoring a Python runtime', () => {
    const root = project()
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "demo"\n[project.scripts]\nserve = "demo.cli:main"\nunsafe = "demo.deploy:main"\n',
    )
    writeFileSync(join(root, 'manage.py'), '# django entry\n')

    const detector = new ProjectLaunchCandidateDetector()
    const candidates = detector.detect({ projectRoot: root, toolPaths: tools })
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      'uv run serve',
      'Django development server',
    ])
    expect(
      detector.resolve({
        projectRoot: root,
        toolPaths: tools,
        candidateId: candidates[1]!.id,
        port: 43122,
      }),
    ).toMatchObject({
      executable: '/signed/python',
      args: ['manage.py', 'runserver', '127.0.0.1:43122'],
    })
  })

  it('detects Go main, Rust default-run and a root static entry', () => {
    const root = project()
    writeFileSync(join(root, 'go.mod'), 'module example.test/demo\n')
    writeFileSync(join(root, 'main.go'), 'package main\nfunc main() {}\n')
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname = "demo"\ndefault-run = "web"\n',
    )
    writeFileSync(join(root, 'Cargo.lock'), '# lock\n')
    writeFileSync(join(root, 'index.html'), '<h1>Hello</h1>\n')

    const candidates = new ProjectLaunchCandidateDetector().detect({
      projectRoot: root,
      toolPaths: tools,
    })
    expect(candidates.map((candidate) => candidate.ecosystem)).toEqual([
      'go',
      'rust',
      'static',
    ])
    const rust = candidates.find((candidate) => candidate.ecosystem === 'rust')!
    const launch = new ProjectLaunchCandidateDetector().resolve({
      projectRoot: root,
      toolPaths: tools,
      candidateId: rust.id,
      port: 43123,
    })
    expect(launch.kind).toBe('process')
    if (launch.kind === 'process')
      expect(launch.args).toEqual(['run', '--locked', '--bin', 'web'])
  })

  it('only exposes a Rust candidate for default-run or one unambiguous bin', () => {
    const library = project()
    writeFileSync(
      join(library, 'Cargo.toml'),
      '[package]\nname = "library"\n[lib]\npath = "lib.rs"\n',
    )
    writeFileSync(join(library, 'lib.rs'), 'pub fn answer() -> u8 { 42 }\n')

    const ambiguous = project()
    writeFileSync(
      join(ambiguous, 'Cargo.toml'),
      '[package]\nname = "many"\n[[bin]]\nname = "one"\npath = "one.rs"\n[[bin]]\nname = "two"\npath = "two.rs"\n',
    )

    const implicit = project()
    mkdirSync(join(implicit, 'src'))
    writeFileSync(join(implicit, 'Cargo.toml'), '[package]\nname = "web"\n')
    writeFileSync(join(implicit, 'Cargo.lock'), '# lock\n')
    writeFileSync(join(implicit, 'src', 'main.rs'), 'fn main() {}\n')

    const detector = new ProjectLaunchCandidateDetector()
    expect(detector.detect({ projectRoot: library, toolPaths: tools })).toEqual(
      [],
    )
    expect(
      detector.detect({ projectRoot: ambiguous, toolPaths: tools }),
    ).toEqual([])
    expect(
      detector.detect({ projectRoot: implicit, toolPaths: tools }),
    ).toEqual([
      expect.objectContaining({ ecosystem: 'rust', name: 'cargo run' }),
    ])
  })

  it('rejects stale or forged candidate ids', () => {
    const root = project()
    writeFileSync(join(root, 'index.html'), '<h1>Hello</h1>\n')
    const detector = new ProjectLaunchCandidateDetector()

    expect(() =>
      detector.resolve({
        projectRoot: root,
        toolPaths: tools,
        candidateId: 'launch_000000000000000000000000',
        port: 43124,
      }),
    ).toThrow(ProjectLaunchCandidateError)
  })

  it('does not guess nested or arbitrary HTML entry points', () => {
    const root = project()
    mkdirSync(join(root, 'pages'))
    writeFileSync(join(root, 'pages', 'index.html'), '<h1>nested</h1>\n')
    writeFileSync(join(root, 'landing.html'), '<h1>landing</h1>\n')

    expect(
      new ProjectLaunchCandidateDetector().detect({
        projectRoot: root,
        toolPaths: tools,
      }),
    ).toEqual([])
  })
})
