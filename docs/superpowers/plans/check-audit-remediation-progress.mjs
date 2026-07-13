#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const progressUrl = new URL(
  './2026-07-13-audit-findings-remediation.progress.json',
  import.meta.url,
)

let progress
try {
  progress = JSON.parse(await readFile(progressUrl, 'utf8'))
} catch (error) {
  console.error(`cannot read audit remediation progress: ${error}`)
  process.exit(1)
}

const tasks = Object.entries(progress.tasks ?? {})
const remaining = tasks.filter(([, task]) => task.status !== 'done')
if (tasks.length !== progress.total_tasks) {
  console.error(
    `progress task count mismatch: expected ${progress.total_tasks}, found ${tasks.length}`,
  )
  process.exit(1)
}
if (remaining.length) {
  console.error(
    `${remaining.length} audit remediation tasks remain out of ${progress.total_tasks}`,
  )
  for (const [id, task] of remaining) console.error(`  ${id}: ${task.status}`)
  process.exit(1)
}

console.log(
  `all audit remediation tasks complete: ${progress.completed}/${progress.total_tasks}, rounds=${progress.rounds}`,
)
