#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const root = process.cwd()
const allowedRootDocuments = new Set([
  'README.md',
  'AGENTS.md',
  'package.json',
  'package-lock.json',
])
const allowedFiles = new Set(['docs/README.md', 'docs/DOCUMENTATION.md'])
const allowedPrefixes = [
  'docs/user/',
  'docs/architecture/',
  'docs/development/',
  'docs/release/',
]

const trackedDocs = execFileSync('git', ['ls-files', '-z', '--', 'docs'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .sort()

const unexpectedRootDocuments = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => path && existsSync(resolve(root, path)))
  .filter(
    (path) =>
      !path.includes('/') &&
      !path.startsWith('.') &&
      /\.(?:json|md)$/i.test(path) &&
      !allowedRootDocuments.has(path),
  )
  .sort()

const unexpected = trackedDocs.filter((path) => !isPublicDocPath(path))
const publicMarkdown = [
  'README.md',
  'AGENTS.md',
  '.github/SECURITY.md',
  'docs/release/CHANGELOG.md',
  ...trackedDocs.filter(
    (path) => isPublicDocPath(path) && path.endsWith('.md'),
  ),
]
const brokenLinks = []
const privateLinks = []

for (const path of publicMarkdown) {
  const absolute = resolve(root, path)
  if (!existsSync(absolute)) continue
  const source = readFileSync(absolute, 'utf8')
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim()
    const target = linkTarget(rawTarget)
    if (!target || isExternal(target) || target.startsWith('#')) continue

    const pathOnly = target.split('#', 1)[0].split('?', 1)[0]
    if (!pathOnly) continue

    let decoded
    try {
      decoded = decodeURIComponent(pathOnly)
    } catch {
      brokenLinks.push(`${path}: malformed link target ${target}`)
      continue
    }

    const resolved = resolve(dirname(absolute), decoded)
    if (!existsSync(resolved)) {
      brokenLinks.push(`${path}: ${target}`)
      continue
    }

    const repoPath = relative(root, resolved).split(sep).join('/')
    if (repoPath.startsWith('docs/') && !isPublicDocPath(repoPath)) {
      privateLinks.push(`${path}: ${target}`)
    }
    if (repoPath === 'private-docs' || repoPath.startsWith('private-docs/')) {
      privateLinks.push(`${path}: ${target}`)
    }
  }
}

if (
  unexpectedRootDocuments.length ||
  unexpected.length ||
  brokenLinks.length ||
  privateLinks.length
) {
  if (unexpectedRootDocuments.length) {
    console.error('Tracked Markdown/JSON files outside the root allowlist:')
    for (const path of unexpectedRootDocuments) console.error(`  - ${path}`)
  }
  if (unexpected.length) {
    console.error('Tracked docs outside the public documentation allowlist:')
    for (const path of unexpected) console.error(`  - ${path}`)
  }
  if (brokenLinks.length) {
    console.error('Broken local links in public documentation:')
    for (const item of brokenLinks) console.error(`  - ${item}`)
  }
  if (privateLinks.length) {
    console.error('Public documentation links to private development material:')
    for (const item of privateLinks) console.error(`  - ${item}`)
  }
  process.exit(1)
}

console.log(
  `Public documentation boundary verified: ${trackedDocs.length} tracked files, ${publicMarkdown.length} Markdown entry points.`,
)

function isPublicDocPath(path) {
  return (
    allowedFiles.has(path) ||
    allowedPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

function linkTarget(rawTarget) {
  if (rawTarget.startsWith('<')) {
    const end = rawTarget.indexOf('>')
    return end >= 0 ? rawTarget.slice(1, end) : rawTarget
  }
  return rawTarget.split(/\s+/, 1)[0]
}

function isExternal(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)
}
