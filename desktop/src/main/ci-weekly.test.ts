// REL-04 test 5: the weekly model-metadata check opens a PR (dry-run) when
// the bundled models.dev snapshot is stale, and nothing when it is current.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const weekly = path.join(repoRoot, 'scripts', 'ci', 'weekly-model-metadata.mjs')
const metadataDir = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'model',
  'metadata',
)

interface Snapshot {
  providers: Record<
    string,
    { models: Record<string, { limit: { context: number } }> }
  >
}

/**
 * A models.dev document that projects back onto the committed snapshot: the
 * snapshot keeps only fields the projection reads, in its own shape, minus
 * the ids models.dev repeats inside each provider and model.
 */
function upstreamFromSnapshot(edit?: (snapshot: Snapshot) => void): string {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(metadataDir, 'models-dev.snapshot.json'), 'utf8'),
  ) as Snapshot
  edit?.(snapshot)
  const upstream = Object.fromEntries(
    Object.entries(snapshot.providers).map(([providerId, provider]) => [
      providerId,
      {
        id: providerId,
        ...provider,
        models: Object.fromEntries(
          Object.entries(provider.models).map(([modelId, model]) => [
            modelId,
            { id: modelId, ...model },
          ]),
        ),
      },
    ]),
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-models-dev-'))
  const file = path.join(dir, 'api.json')
  fs.writeFileSync(file, JSON.stringify(upstream))
  return file
}

function copyOfMetadata(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-metadata-'))
  for (const name of ['models-dev.snapshot.json', 'manifest.json'])
    fs.copyFileSync(path.join(metadataDir, name), path.join(dir, name))
  return dir
}

function run(args: string[]) {
  return spawnSync(process.execPath, [weekly, '--dry-run', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    // A push or schedule run sets GITHUB_BASE_REF to an empty string (it is
    // only filled for pull requests); the base must still be main.
    env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REF_NAME: 'main' },
    timeout: 120_000,
  })
}

describe('weekly model metadata (REL-04 test 5)', () => {
  it('opens nothing when the snapshot is current', () => {
    const outDir = copyOfMetadata()
    const result = run(['--input', upstreamFromSnapshot(), '--out-dir', outDir])
    expect(result.stderr).not.toMatch(/error/i)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({
      action: 'none',
      reason: 'model metadata is current',
    })
  })

  it('plans a refresh PR when the snapshot is stale, and changes no file', () => {
    const outDir = copyOfMetadata()
    const before = fs.readFileSync(
      path.join(outDir, 'models-dev.snapshot.json'),
    )
    const input = upstreamFromSnapshot((snapshot) => {
      const provider = Object.values(snapshot.providers)[0]!
      const model = Object.values(provider.models)[0]!
      model.limit.context += 1
    })
    const result = run([
      '--input',
      input,
      '--out-dir',
      outDir,
      '--date',
      '2026-10-26',
    ])
    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    expect(plan).toMatchObject({
      action: 'pull-request',
      branch: 'bot/model-metadata-2026-10-26',
      base: 'main',
      title: 'chore(models): refresh the models.dev snapshot (2026-10-26)',
      commands: [
        expect.arrayContaining(['vite-node', 'scripts/sync-model-metadata.ts']),
        ['git', 'switch', '-c', 'bot/model-metadata-2026-10-26'],
        [
          'git',
          'add',
          '--',
          path.join(outDir, 'models-dev.snapshot.json'),
          path.join(outDir, 'manifest.json'),
        ],
        expect.arrayContaining(['git', 'commit']),
        [
          'git',
          'push',
          '--set-upstream',
          'origin',
          'bot/model-metadata-2026-10-26',
        ],
        expect.arrayContaining(['gh', 'pr', 'create', '--base', 'main']),
      ],
    })
    expect(plan.changes.join('\n')).toMatch(/changed /)
    expect(plan.body).toContain('models.dev')
    expect(plan.body).toContain('overrides.ts')
    expect(
      fs.readFileSync(path.join(outDir, 'models-dev.snapshot.json')),
    ).toEqual(before)
  })

  it('fails the job when models.dev cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-models-dev-'))
    const input = path.join(dir, 'api.json')
    fs.writeFileSync(input, '{"not": "models.dev"}')
    const result = run(['--input', input, '--out-dir', copyOfMetadata()])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('model metadata:')
  })
})
