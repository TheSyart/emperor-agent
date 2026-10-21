#!/usr/bin/env node
// REL-04 (MAIN-29): every `uses:` in a workflow or a composite action names
// a full 40-hex commit, so a moved tag or a hijacked branch cannot change
// what CI runs. Local actions (`./…`) and digest-pinned Docker images
// (`docker://image@sha256:…`) are pinned by construction. Write the version
// the commit stands for beside it: `uses: actions/checkout@<sha> # v4.4.0`.
//
//   node scripts/ci/check-action-pins.mjs [dir-or-file …]
//
// Default: .github/workflows and .github/actions. Exit 1 lists every
// reference that is not pinned (file:line: reference).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"#\s]+)\1/

/** Whether one `uses:` value cannot move under CI's feet. */
export function isPinned(reference) {
  if (reference.startsWith('./')) return true
  if (reference.startsWith('docker://'))
    return /@sha256:[0-9a-f]{64}$/.test(reference)
  const at = reference.lastIndexOf('@')
  if (at <= 0) return false
  return /^[0-9a-f]{40}$/.test(reference.slice(at + 1))
}

/** `{ line, reference }` for every `uses:` in `text` that is not pinned. */
export function findUnpinnedUses(text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const match = USES.exec(line)
    if (!match) continue
    const reference = match[2]
    if (!isPinned(reference)) problems.push({ line: index + 1, reference })
  }
  return problems
}

export function countUses(text) {
  return text.split(/\r?\n/).filter((line) => USES.test(line)).length
}

function yamlFiles(target) {
  if (!existsSync(target)) return []
  if (statSync(target).isFile()) return [target]
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const path = join(target, entry.name)
    if (entry.isDirectory()) return yamlFiles(path)
    return /\.ya?ml$/.test(entry.name) ? [path] : []
  })
}

function main(argv) {
  const targets = argv.length
    ? argv.map((arg) => resolve(arg))
    : [
        join(repoRoot, '.github', 'workflows'),
        join(repoRoot, '.github', 'actions'),
      ]
  const files = targets.flatMap(yamlFiles).sort()
  let pinned = 0
  const problems = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const found = findUnpinnedUses(text)
    pinned += countUses(text) - found.length
    const name = relative(process.cwd(), file) || file
    for (const problem of found)
      problems.push(`${name}:${problem.line}: ${problem.reference}`)
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem)
    console.error(
      `${problems.length} uses: not pinned to a 40-hex commit (write uses: owner/repo@<sha> # vX.Y.Z)`,
    )
    return 1
  }
  console.log(
    `${pinned} uses: pinned to a commit in ${files.length} workflow file(s)`,
  )
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2))
