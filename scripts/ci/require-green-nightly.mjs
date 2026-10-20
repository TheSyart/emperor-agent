#!/usr/bin/env node
// A red nightly blocks a release, never a pull request (REL-04). The release
// workflows run this first: the last completed nightly on the default branch
// must have passed, recently, and no nightly-failure issue may be open.
//
//   node scripts/ci/require-green-nightly.mjs [--max-age-hours 72]
//   node scripts/ci/require-green-nightly.mjs --runs-json <file> --issues-json <file> [--now <iso>]
//
// The second form stands in for `gh run list` and `gh issue list` (tests and
// dry runs). Uses only Node built-ins and gh: it runs before npm ci.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Why this release must wait, or null when the nightly is green. */
export function nightlyBlocker(runs, issues, { now, maxAgeHours }) {
  const last = runs[0]
  if (!last) return 'no completed nightly run on the default branch'
  if (last.conclusion !== 'success')
    return `the last nightly concluded ${last.conclusion || 'without a result'}: ${last.url ?? ''}`.trim()
  const ageHours = Math.floor((now - Date.parse(last.createdAt)) / 3_600_000)
  if (!(ageHours <= maxAgeHours))
    return `the last nightly is ${ageHours} hours old (more than ${maxAgeHours}); run nightly.yml first`
  const issue = issues[0]
  if (issue)
    return `nightly failure issue #${issue.number} is still open: ${issue.url ?? ''}`.trim()
  return null
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    )
  return JSON.parse(result.stdout || '[]')
}

function main(argv) {
  const value = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const maxAgeHours = Number(value('--max-age-hours') ?? 72)
  const now = value('--now') ? Date.parse(value('--now')) : Date.now()
  const runsFile = value('--runs-json')
  const issuesFile = value('--issues-json')
  const branch =
    value('--branch') ?? process.env.EMPEROR_DEFAULT_BRANCH ?? 'main'
  const runs = runsFile
    ? JSON.parse(readFileSync(resolve(runsFile), 'utf8'))
    : gh([
        'run',
        'list',
        '--workflow',
        'nightly.yml',
        '--branch',
        branch,
        '--status',
        'completed',
        '--limit',
        '1',
        '--json',
        'conclusion,headSha,url,createdAt',
      ])
  const issues = issuesFile
    ? JSON.parse(readFileSync(resolve(issuesFile), 'utf8'))
    : gh([
        'issue',
        'list',
        '--state',
        'open',
        '--label',
        'nightly-failure',
        '--json',
        'number,url',
        '--limit',
        '1',
      ])
  const blocker = nightlyBlocker(runs, issues, { now, maxAgeHours })
  if (blocker) {
    console.error(`release blocked: ${blocker}`)
    return 1
  }
  console.log(`nightly is green: ${runs[0].url ?? runs[0].headSha}`)
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(
      `release blocked: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
