#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { checkDesignDocs, statusHeaderProblems } from './lib/design-docs.mjs'
import { checkDocReferences } from './lib/doc-references.mjs'

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
  'docs/design/',
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
  const targets = [
    ...[...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map(
      (m) => m[1],
    ),
  ]
  for (const rawTarget_ of targets) {
    const rawTarget = rawTarget_.trim()
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

// docs/design/: the four-line status header and an entry in both indexes.
const designProblems = checkDesignDocs(root)

// Every other public page opens with the status header too, except the
// changelog and the Release body template (its first paragraph must be the
// unsigned notice; its status lives in an HTML comment).
const WITHOUT_HEADER = new Set([
  'docs/release/CHANGELOG.md',
  'docs/release/stable-release-notes.md',
])
const headerProblems = [
  '.github/SECURITY.md',
  ...trackedDocs.filter(
    (path) =>
      path.endsWith('.md') &&
      isPublicDocPath(path) &&
      !path.startsWith('docs/design/') &&
      !WITHOUT_HEADER.has(path),
  ),
].flatMap((path) =>
  existsSync(resolve(root, path))
    ? statusHeaderProblems(readFileSync(resolve(root, path), 'utf8')).map(
        (problem) => `${path}: ${problem}`,
      )
    : [],
)

// REL-06: settings paths, Core operations, private material, 最后核验.
const references = checkDocReferences(root)

if (
  unexpectedRootDocuments.length ||
  unexpected.length ||
  brokenLinks.length ||
  privateLinks.length ||
  designProblems.length ||
  headerProblems.length ||
  Object.values(references).some((list) => list.length)
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
  if (designProblems.length) {
    console.error(
      'Design documents without the status header or an index entry:',
    )
    for (const item of designProblems) console.error(`  - ${item}`)
  }
  if (headerProblems.length) {
    console.error('Public documents without the status header:')
    for (const item of headerProblems) console.error(`  - ${item}`)
  }
  const referenceTitles = {
    settings: 'Settings paths that do not match the settings modal:',
    operations: 'Core operations that are not in CORE_OPERATION_REGISTRY:',
    private: 'References to private development material:',
    verified: 'Pages whose 最后核验 does not cover their text:',
  }
  for (const [rule, items] of Object.entries(references)) {
    if (!items.length) continue
    console.error(referenceTitles[rule])
    for (const item of items) console.error(`  - ${item}`)
  }
  process.exit(1)
}

console.log(
  `Public documentation boundary verified: ${trackedDocs.length} tracked files, ${publicMarkdown.length} Markdown entry points; settings paths, Core operations, private references and 最后核验 dates checked.`,
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
