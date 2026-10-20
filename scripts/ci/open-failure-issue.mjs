#!/usr/bin/env node
// After the nightly (REL-04): a failed run opens an issue labelled
// nightly-failure and release-blocker, or comments on the one already open;
// a full green run closes it again. While it is open, releases are blocked
// (scripts/ci/require-green-nightly.mjs); pull requests never are.
//
//   node scripts/ci/open-failure-issue.mjs --report <dir|summary.json> [--dry-run] [--issues-json <file>]
//
// --dry-run prints the plan (action, title, labels, body, the gh arguments)
// and never runs gh; --issues-json stands in for `gh issue list`.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LABELS = ['nightly-failure', 'release-blocker']

function shortSha(commit) {
  return /^[0-9a-f]{7,}$/i.test(commit ?? '') ? commit.slice(0, 7) : 'local'
}

export function issueTitle(summary) {
  const day = String(summary.startedAt ?? new Date().toISOString()).slice(0, 10)
  return `夜间门禁失败 · ${day} · ${shortSha(summary.commit)}`
}

export function issueBody(summary) {
  const failed = summary.steps.filter((step) => step.status === 'failed')
  const skipped = summary.steps.filter((step) => step.status === 'skipped')
  const lines = [
    `夜间门禁（nightly.yml）在 \`${shortSha(summary.commit)}\` 上失败：${failed.length} 项失败。`,
    '',
    summary.runUrl ? `运行记录：${summary.runUrl}` : '运行记录：本地运行',
    '',
    '| 步骤 | 退出码 | 用时 |',
    '| --- | --- | --- |',
    ...failed.map(
      (step) =>
        `| ${step.id} | ${step.exitCode ?? '—'} | ${step.ms === undefined ? '—' : `${Math.round(step.ms / 1000)} s`} |`,
    ),
    '',
  ]
  for (const step of failed) {
    lines.push(
      `### ${step.id}`,
      '',
      '```text',
      String(step.logTail ?? '')
        .trim()
        .slice(-3000),
      '```',
      '',
    )
  }
  if (skipped.length)
    lines.push(
      `跳过 ${skipped.length} 项（需要真实模型或尚未接入）：${skipped.map((step) => step.id).join('、')}。`,
      '',
    )
  lines.push(
    '这个 issue 打开期间，发布被阻塞（release-preview.yml、release.yml 的 require-green-nightly）；PR 不受影响。',
    '修好后重新运行 nightly（Actions › nightly › Run workflow，不填 only）；完整运行通过会自动关闭这个 issue。',
    '本地重跑：`node scripts/ci/nightly.mjs --only <步骤>`（见 docs/development/ci.md）。',
  )
  return lines.join('\n')
}

/** What to do with the issue tracker after this nightly. */
export function planIssue(summary, openIssues) {
  const open = openIssues[0] ?? null
  if (summary.ok) {
    if (!open || summary.partial) return { action: 'none' }
    const comment = `夜间门禁在 \`${shortSha(summary.commit)}\` 上完整通过${summary.runUrl ? `：${summary.runUrl}` : ''}。关闭。`
    return {
      action: 'close',
      issue: open.number,
      gh: ['issue', 'close', String(open.number), '--comment', comment],
    }
  }
  const body = issueBody(summary)
  if (open)
    return {
      action: 'comment',
      issue: open.number,
      body,
      gh: ['issue', 'comment', String(open.number), '--body-file', '-'],
    }
  const title = issueTitle(summary)
  return {
    action: 'create',
    title,
    labels: LABELS,
    body,
    gh: [
      'issue',
      'create',
      '--title',
      title,
      ...LABELS.flatMap((label) => ['--label', label]),
      '--body-file',
      '-',
    ],
  }
}

function gh(args, input) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    )
  return result.stdout
}

function ensureLabels() {
  for (const label of LABELS) {
    const result = spawnSync(
      'gh',
      [
        'label',
        'create',
        label,
        '--force',
        '--color',
        label === 'release-blocker' ? 'b60205' : 'd93f0b',
      ],
      {
        encoding: 'utf8',
      },
    )
    if (result.status !== 0)
      console.warn(
        `could not create label ${label}: ${(result.stderr || '').trim()}`,
      )
  }
}

function readSummary(path) {
  const file = statSync(path).isDirectory() ? join(path, 'summary.json') : path
  if (!existsSync(file)) {
    // The nightly died before it wrote anything: that is a failure too.
    return {
      ok: false,
      partial: false,
      commit: process.env.GITHUB_SHA ?? 'local',
      startedAt: new Date().toISOString(),
      runUrl: null,
      steps: [
        { id: 'nightly', status: 'failed', logTail: `no summary at ${file}` },
      ],
    }
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

function main(argv) {
  const value = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const reportPath = value('--report')
  if (!reportPath) {
    console.error(
      'usage: open-failure-issue.mjs --report <dir|summary.json> [--dry-run] [--issues-json <file>]',
    )
    return 2
  }
  const dryRun = argv.includes('--dry-run')
  const summary = readSummary(resolve(reportPath))
  const issuesFile = value('--issues-json')
  const openIssues = issuesFile
    ? JSON.parse(readFileSync(resolve(issuesFile), 'utf8'))
    : dryRun
      ? []
      : JSON.parse(
          gh([
            'issue',
            'list',
            '--state',
            'open',
            '--label',
            LABELS[0],
            '--json',
            'number,title,url',
            '--limit',
            '20',
          ]),
        )
  const plan = planIssue(summary, openIssues)
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2))
    return 0
  }
  if (plan.action === 'none') {
    console.log('nightly passed; no failure issue to open or close')
    return 0
  }
  if (plan.action === 'create') ensureLabels()
  const output = gh(plan.gh, plan.body)
  console.log(`${plan.action}: ${output.trim() || `#${plan.issue}`}`)
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
    process.exitCode = 1
  }
}
