#!/usr/bin/env node
// Weekly (REL-04, MOD-01): is the bundled models.dev snapshot still what
// models.dev serves? weekly-model-metadata.yml runs it, and so can you:
//
//   node scripts/ci/weekly-model-metadata.mjs --dry-run         what it would do
//   node scripts/ci/weekly-model-metadata.mjs                   refresh and open the PR (CI)
//   … [--input api.json] [--out-dir dir] [--date YYYY-MM-DD] [--base main]
//
// Current: nothing to do. Stale: `npm run models:sync`, a commit on
// bot/model-metadata-<date>, and a pull request whose body lists the
// per-provider changes for review. models.dev unreachable or invalid: exit 2.
// The last line of stdout is the plan as JSON. --dry-run changes no file.
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const METADATA = join(repoRoot, 'packages', 'core', 'src', 'model', 'metadata')
const BOT = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
]

function parseArgs(argv) {
  const options = {
    dryRun: false,
    input: null,
    outDir: null,
    date: null,
    base: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--input') options.input = resolve(value())
    else if (arg === '--out-dir') options.outDir = resolve(value())
    else if (arg === '--date') options.date = value()
    else if (arg === '--base') options.base = value()
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

function exec(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? String(result.error ?? ''),
  }
}

function must(command, args, input) {
  const result = exec(command, args, input)
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`,
    )
  return result.stdout
}

export function prBody(changes, date) {
  return [
    `每周检查（weekly-model-metadata.yml，${date}）发现内置的 models.dev 快照已过期，已用 \`npm run models:sync\` 刷新。`,
    '',
    '变化（按供应商）：',
    '',
    ...(changes.length
      ? changes.map((line) => `- ${line}`)
      : ['- （只有清单变化）']),
    '',
    '合并前请核对：',
    '',
    '- 上面的增删改是否符合预期（数据来自 https://models.dev/api.json，MIT）；',
    '- `packages/core/src/model/metadata/overrides.ts` 里的覆盖项是否仍然需要、是否要新增（见 docs/design/model-metadata.md）；',
    '- `make check` 通过（这个 PR 由 GITHUB_TOKEN 创建，不会自动触发 ci.yml；推一个提交或关闭再打开 PR 以运行它）。',
  ].join('\n')
}

function main(argv) {
  const options = parseArgs(argv)
  const passthrough = [
    ...(options.input ? ['--input', options.input] : []),
    ...(options.outDir ? ['--out-dir', options.outDir] : []),
  ]
  const sync = [
    'vite-node',
    'scripts/sync-model-metadata.ts',
    '--',
    ...passthrough,
  ]
  const check = exec('npx', [...sync, '--check'])
  if (check.status === 0) {
    process.stderr.write(check.stderr)
    console.log(check.stdout.trim())
    console.log(
      JSON.stringify({ action: 'none', reason: 'model metadata is current' }),
    )
    return 0
  }
  if (check.status !== 1) {
    process.stderr.write(check.stderr || check.stdout)
    return 2
  }
  // Stale: the check printed what differs, one line each.
  const changes = check.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const branch = `bot/model-metadata-${date}`
  // GITHUB_BASE_REF is set but empty outside pull requests (push, schedule).
  const base =
    options.base ||
    process.env.GITHUB_BASE_REF ||
    process.env.GITHUB_REF_NAME ||
    'main'
  const title = `chore(models): refresh the models.dev snapshot (${date})`
  const outDir = options.outDir ?? METADATA
  const files = [
    join(outDir, 'models-dev.snapshot.json'),
    join(outDir, 'manifest.json'),
  ]
  const body = prBody(changes, date)
  const plan = {
    action: 'pull-request',
    branch,
    base,
    title,
    changes,
    body,
    commands: [
      ['npx', ...sync],
      ['git', 'switch', '-c', branch],
      ['git', 'add', '--', ...files],
      ['git', ...BOT, 'commit', '-m', title],
      ['git', 'push', '--set-upstream', 'origin', branch],
      [
        'gh',
        'pr',
        'create',
        '--base',
        base,
        '--head',
        branch,
        '--title',
        title,
        '--body-file',
        '-',
      ],
    ],
  }
  if (options.dryRun) {
    for (const line of changes) console.log(line)
    console.log(JSON.stringify(plan))
    return 0
  }
  const open = JSON.parse(
    must('gh', [
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      branch,
      '--json',
      'number,url',
    ]) || '[]',
  )
  for (const [command, ...args] of plan.commands) {
    if (command === 'gh' && open.length) {
      console.log(`refresh pull request already open: ${open[0].url}`)
      continue
    }
    if (command === 'git' && args[0] === 'push' && open.length) {
      must('git', [
        'push',
        '--force-with-lease',
        '--set-upstream',
        'origin',
        branch,
      ])
      continue
    }
    console.log(`$ ${command} ${args.join(' ')}`)
    const output = must(command, args, command === 'gh' ? body : undefined)
    if (output.trim()) console.log(output.trim())
  }
  console.log(JSON.stringify({ ...plan, done: true }))
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
