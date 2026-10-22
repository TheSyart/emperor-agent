#!/usr/bin/env node
// REL-04 (MAIN-29) workflow lint: the gates run the scripts they are meant
// to run, on the triggers they are meant to have, and only on macOS.
//
//   node scripts/ci/check-workflows.mjs [workflows-dir]
//
// - ci.yml: on pull requests; an arm64 macOS job runs scripts/ci/pr-gate.sh,
//   an Intel one scripts/ci/pr-gate.sh --build-only.
// - nightly.yml: on a schedule, never on pull requests or pushes; runs
//   scripts/ci/nightly.mjs and, on failure, scripts/ci/open-failure-issue.mjs.
// - weekly-model-metadata.yml: weekly; runs scripts/ci/weekly-model-metadata.mjs.
// - release-preview.yml, release.yml: refuse to build on a red nightly
//   (scripts/ci/require-green-nightly.mjs).
// - release.yml (REL-05): the unsigned Stable candidates are built with
//   scripts/build_desktop_release.sh and verified with
//   scripts/verify-macos-release.sh on macOS arm64 and x64.
// - Every job runs on macOS, except the few that only attest or publish
//   (NON_MACOS_JOBS); every scripts/ci/* a workflow runs exists.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Jobs that build nothing: they verify, attest and publish what macOS built. */
const NON_MACOS_JOBS = {
  'release-preview.yml': ['preview-aggregate', 'preview-publish'],
  // Checks the tag and the nightly, attests and publishes (REL-05).
  'release.yml': ['release-policy', 'release-aggregate', 'publish-release'],
}
const REQUIRED = ['ci.yml', 'nightly.yml', 'weekly-model-metadata.yml']
const RELEASES = ['release-preview.yml', 'release.yml']

const isMacos = (runner) => /^macos-/.test(runner)
const isIntel = (runner) => /^macos-.*-intel$|^macos-13$/.test(runner)

/** Every runner label a job can land on (matrix expressions expanded). */
export function runnersOf(job) {
  const runsOn = job?.['runs-on']
  if (runsOn === undefined) return [] // a reusable-workflow call
  const labels = Array.isArray(runsOn) ? runsOn.map(String) : [String(runsOn)]
  const matrix = job.strategy?.matrix ?? {}
  return labels.flatMap((label) => {
    const expression = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(label)
    if (!expression) return [label]
    const key = expression[1]
    const values = [
      ...(Array.isArray(matrix[key]) ? matrix[key] : []),
      ...(Array.isArray(matrix.include)
        ? matrix.include.map((row) => row?.[key]).filter(Boolean)
        : []),
    ].map(String)
    return values.length ? values : [label]
  })
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : []
}

function runs(job) {
  return steps(job)
    .map((step) => (typeof step?.run === 'string' ? step.run.trim() : ''))
    .filter(Boolean)
}

function triggers(workflow) {
  // YAML 1.1 reads a bare `on:` key as true; the yaml package keeps 'on'.
  const on = workflow?.on ?? workflow?.[true]
  if (typeof on === 'string') return { [on]: null }
  if (Array.isArray(on))
    return Object.fromEntries(on.map((name) => [name, null]))
  return on && typeof on === 'object' ? on : {}
}

function permission(workflow, job, name) {
  return job?.permissions?.[name] ?? workflow?.permissions?.[name] ?? null
}

/** Problems with one set of workflows, `{ name, text }` each. */
export function lintWorkflows(files, root = repoRoot) {
  const problems = []
  const parsed = new Map()
  for (const { name, text } of files) {
    try {
      parsed.set(name, YAML.parse(text) ?? {})
    } catch (error) {
      problems.push(`${name}: not valid YAML (${error.message.split('\n')[0]})`)
    }
  }
  for (const name of REQUIRED)
    if (!parsed.has(name)) problems.push(`missing workflow: ${name}`)

  for (const [name, workflow] of parsed) {
    const jobs = Object.entries(workflow.jobs ?? {})
    const allowed = new Set(NON_MACOS_JOBS[name] ?? [])
    for (const [id, job] of jobs) {
      if (allowed.has(id)) continue
      for (const runner of runnersOf(job))
        if (!isMacos(runner))
          problems.push(`${name}: job ${id} runs on ${runner}, not macOS`)
    }
    for (const [, job] of jobs)
      for (const run of runs(job))
        for (const match of run.matchAll(/scripts\/ci\/[\w.-]+/g))
          if (!existsSync(join(root, match[0])))
            problems.push(`${name}: runs ${match[0]}, which does not exist`)
  }

  const ci = parsed.get('ci.yml')
  if (ci) {
    if (!('pull_request' in triggers(ci)))
      problems.push('ci.yml: does not run on pull requests')
    const jobs = Object.values(ci.jobs ?? {})
    const runsGate = (job, command) => runs(job).some((run) => run === command)
    if (
      !jobs.some(
        (job) =>
          runnersOf(job).some((r) => isMacos(r) && !isIntel(r)) &&
          runsGate(job, 'scripts/ci/pr-gate.sh'),
      )
    )
      problems.push('ci.yml: no macOS arm64 job runs scripts/ci/pr-gate.sh')
    if (
      !jobs.some(
        (job) =>
          runnersOf(job).some(isIntel) &&
          (runsGate(job, 'scripts/ci/pr-gate.sh --build-only') ||
            runsGate(job, 'scripts/ci/pr-gate.sh')),
      )
    )
      problems.push(
        'ci.yml: no macOS x64 job runs scripts/ci/pr-gate.sh --build-only',
      )
  }

  const nightly = parsed.get('nightly.yml')
  if (nightly) {
    const on = triggers(nightly)
    const cron = Array.isArray(on.schedule)
      ? on.schedule.map((entry) => entry?.cron).filter(Boolean)
      : []
    if (!cron.length) problems.push('nightly.yml: has no schedule')
    if ('pull_request' in on || 'pull_request_target' in on)
      problems.push(
        'nightly.yml: runs on pull requests; the nightly must not block them',
      )
    if ('push' in on)
      problems.push('nightly.yml: runs on push; the nightly must not block it')
    const jobs = Object.values(nightly.jobs ?? {})
    if (
      !jobs.some((job) =>
        runs(job).some((run) =>
          /(^|\s)node scripts\/ci\/nightly\.mjs\b/.test(run),
        ),
      )
    )
      problems.push('nightly.yml: no job runs scripts/ci/nightly.mjs')
    const issueJob = jobs.find((job) =>
      steps(job).some(
        (step) =>
          typeof step?.run === 'string' &&
          step.run.includes('scripts/ci/open-failure-issue.mjs') &&
          /\b(failure|always)\(\)/.test(String(step.if ?? '')),
      ),
    )
    if (!issueJob)
      problems.push(
        'nightly.yml: no step opens an issue on failure (scripts/ci/open-failure-issue.mjs)',
      )
    else if (permission(nightly, issueJob, 'issues') !== 'write')
      problems.push(
        'nightly.yml: the issue step has no issues: write permission',
      )
  }

  const weekly = parsed.get('weekly-model-metadata.yml')
  if (weekly) {
    const on = triggers(weekly)
    const cron = Array.isArray(on.schedule)
      ? on.schedule.map((entry) => String(entry?.cron ?? '')).filter(Boolean)
      : []
    if (!cron.length)
      problems.push('weekly-model-metadata.yml: has no schedule')
    else if (!cron.some((value) => /^\S+ \S+ \* \* [0-7]$/.test(value)))
      problems.push('weekly-model-metadata.yml: its schedule is not weekly')
    const job = Object.values(weekly.jobs ?? {}).find((candidate) =>
      runs(candidate).some((run) =>
        run.includes('node scripts/ci/weekly-model-metadata.mjs'),
      ),
    )
    if (!job)
      problems.push(
        'weekly-model-metadata.yml: no job runs scripts/ci/weekly-model-metadata.mjs',
      )
    else if (
      permission(weekly, job, 'contents') !== 'write' ||
      permission(weekly, job, 'pull-requests') !== 'write'
    )
      problems.push(
        'weekly-model-metadata.yml: needs contents: write and pull-requests: write to open its pull request',
      )
  }

  const stable = parsed.get('release.yml')
  if (stable) {
    const jobs = Object.values(stable.jobs ?? {})
    const builds = (job) =>
      runs(job).includes('scripts/build_desktop_release.sh') &&
      runs(job).some((run) => run.startsWith('scripts/verify-macos-release.sh'))
    const arm64 = jobs.some(
      (job) =>
        builds(job) && runnersOf(job).some((r) => isMacos(r) && !isIntel(r)),
    )
    const x64 = jobs.some((job) => builds(job) && runnersOf(job).some(isIntel))
    if (!arm64 || !x64)
      problems.push(
        'release.yml: no macOS arm64 and x64 job builds with scripts/build_desktop_release.sh and verifies with scripts/verify-macos-release.sh',
      )
  }

  for (const name of RELEASES) {
    const workflow = parsed.get(name)
    if (!workflow) continue
    const gated = Object.values(workflow.jobs ?? {}).some(
      (job) =>
        runs(job).some((run) =>
          run.includes('node scripts/ci/require-green-nightly.mjs'),
        ) && permission(workflow, job, 'actions') === 'read',
    )
    if (!gated)
      problems.push(
        `${name}: releases are not blocked on the nightly (scripts/ci/require-green-nightly.mjs)`,
      )
  }
  return problems
}

function main(argv) {
  const dir = resolve(argv[0] ?? join(repoRoot, '.github', 'workflows'))
  const files = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
  const problems = lintWorkflows(files)
  if (problems.length) {
    for (const problem of problems) console.error(problem)
    return 1
  }
  console.log(
    `${files.length} workflows: macOS only (attest and publish jobs excepted); the PR, nightly, weekly and release gates call their scripts`,
  )
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2))
