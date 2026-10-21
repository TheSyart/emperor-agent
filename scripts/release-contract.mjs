#!/usr/bin/env node
// The Stable release contract (REL-05): what an unsigned Stable bundle holds,
// what its notes open with, its checksums, and the draft that publishing it
// would create.
//
//   release-contract.mjs checksums <bundle>
//       Writes <bundle>/SHA256SUMS.txt over every other file and checks it.
//   release-contract.mjs publication <bundle> <tag> <commit> [--allow-partial]
//       The preflight before attesting and before publishing; fails closed.
//       --allow-partial accepts a dry run's single-architecture bundle.
//   release-contract.mjs draft-plan <bundle> <tag> <commit> <out-dir>
//       Writes what publish-release.sh would send to GitHub (draft-release.json,
//       draft-release-notes.md) without running gh; for --dry-run.
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STABLE_ARCHES = ['arm64', 'x64']
export const STABLE_PLATFORMS = STABLE_ARCHES.map((arch) => `macos-${arch}`)

/**
 * What the notes' first paragraph must say: the packages are unsigned and
 * not notarized, and how to open the app the first time with the system's
 * own per-app confirmation, after checking the download.
 */
export const UNSIGNED_NOTICE_MARKERS = [
  '未签名',
  'Apple 公证',
  'SHA256SUMS.txt',
  '「应用程序」',
  '「系统设置 › 隐私与安全性」',
  '「仍要打开」',
]

/** Advice that turns off protection for the whole Mac; never in the notes. */
const SYSTEM_WIDE_BYPASS = [
  /spctl\s+--master-disable/i,
  /spctl\s+--global-disable/i,
  /disable\s+(Gatekeeper|SmartScreen|Defender)/i,
]

const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const commitPattern = /^[a-f0-9]{40}$/

export function stableVersion(tag) {
  if (!stableTagPattern.test(String(tag)))
    throw new Error(`not a Stable release tag: ${tag}`)
  return tag.slice(1)
}

export function assertCommit(commit) {
  if (!commitPattern.test(String(commit)))
    throw new Error('release commit must be a full lowercase SHA')
  return commit
}

export function stableArtifactNames(version, platforms = STABLE_PLATFORMS) {
  return platforms.flatMap((platform) => [
    `Emperor-Agent-${version}-${platform}.dmg`,
    `Emperor-Agent-${version}-${platform}.zip`,
  ])
}

export function sbomName(tag) {
  return `emperor-agent-${tag}.cdx.json`
}

/** The notes body: the template's leading comment dropped, values filled in. */
export function renderReleaseNotes(template, { tag, version }) {
  const body = String(template)
    .replace(/^\s*<!--[\s\S]*?-->\s*/, '')
    .replaceAll('{{tag}}', tag)
    .replaceAll('{{version}}', version)
  if (/\{\{[^}]*\}\}/.test(body))
    throw new Error('release notes template has an unknown placeholder')
  return `${body.trim()}\n`
}

/** The first block of a Markdown text: what GitHub shows first. */
export function firstParagraph(markdown) {
  return (
    String(markdown)
      .trim()
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find(Boolean) ?? ''
  )
}

export function notesProblems(notes, { version }) {
  const problems = []
  const first = firstParagraph(notes)
  for (const marker of UNSIGNED_NOTICE_MARKERS)
    if (!first.includes(marker))
      problems.push(
        `the release notes' first paragraph does not say ${marker} (it must state the packages are unsigned and how to open them the first time)`,
      )
  if (!first.includes(version))
    problems.push(
      `the release notes' first paragraph does not name version ${version}`,
    )
  for (const pattern of SYSTEM_WIDE_BYPASS)
    if (pattern.test(notes))
      problems.push(
        'the release notes tell users to turn off protection for the whole Mac',
      )
  if (/\{\{|<!--/.test(notes))
    problems.push('the release notes still hold template text')
  return problems
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function fileRecord(path) {
  const body = readFileSync(path)
  return {
    name: basename(path),
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  }
}

/** Regular files only, sorted; directories and links fail closed. */
function bundleNames(bundle) {
  const entries = readdirSync(bundle, { withFileTypes: true })
  const odd = entries.filter((entry) => !entry.isFile())
  if (odd.length)
    throw new Error(
      `release bundle must hold regular files only: ${odd.map((entry) => entry.name).join(', ')}`,
    )
  return entries.map((entry) => entry.name).sort()
}

export function checksumText(dir, names) {
  return `${names.map((name) => `${sha256(join(dir, name))}  ${name}`).join('\n')}\n`
}

/** Every `<sha256>  <name>` line, by name; malformed or repeated lines fail. */
export function readChecksums(path, label) {
  const digests = new Map()
  for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (!match || digests.has(match[2]))
      throw new Error(`invalid ${label} checksum list: ${basename(path)}`)
    digests.set(match[2], match[1].toLowerCase())
  }
  return digests
}

export function verifyChecksums(path, dir, expectedNames, label) {
  const digests = readChecksums(path, label)
  const expected = new Set(expectedNames)
  const extra = [...digests.keys()].filter((name) => !expected.has(name))
  const missing = expectedNames.filter((name) => !digests.has(name))
  if (extra.length || missing.length)
    throw new Error(
      `${label} checksum coverage mismatch; extra=${extra.join(',')} missing=${missing.join(',')}`,
    )
  for (const name of expectedNames)
    if (digests.get(name) !== sha256(join(dir, name)))
      throw new Error(`${label} checksum mismatch: ${name}`)
}

/** SHA256SUMS.txt over every other file of the bundle, then checked. */
export function writeChecksums(bundle) {
  const names = bundleNames(bundle).filter((name) => name !== 'SHA256SUMS.txt')
  writeFileSync(join(bundle, 'SHA256SUMS.txt'), checksumText(bundle, names))
  verifyChecksums(join(bundle, 'SHA256SUMS.txt'), bundle, names, 'full-bundle')
  return names
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${label} is missing or not JSON: ${basename(path)}`)
  }
}

/**
 * The preflight of an assembled bundle: the exact inventory, every
 * checksum, a manifest that says unsigned Stable for this tag and commit,
 * a CycloneDX 1.6 SBOM, and notes that open with the unsigned statement.
 */
export function assertPublication(bundleArg, { tag, commit, allowPartial }) {
  const bundle = resolve(bundleArg)
  const version = stableVersion(tag)
  assertCommit(commit)
  const names = bundleNames(bundle)
  if (names.some((name) => name.includes('UNSIGNED-INTERNAL')))
    throw new Error('UNSIGNED-INTERNAL files cannot be published')
  if (
    names.some(
      (name) =>
        name.includes('UNSIGNED-PREVIEW') ||
        name === 'preview-release-manifest.json',
    )
  )
    throw new Error('Preview files cannot be published as Stable')

  let manifest = null
  if (names.includes('release-manifest.json'))
    manifest = readJson(join(bundle, 'release-manifest.json'), 'manifest')
  const platforms = Array.isArray(manifest?.platforms)
    ? manifest.platforms
    : STABLE_PLATFORMS
  const artifacts = stableArtifactNames(version, platforms)
  const expected = [
    ...artifacts,
    'ARTIFACT-SHA256SUMS.txt',
    'RELEASE-NOTES.md',
    'SHA256SUMS.txt',
    'release-manifest.json',
    sbomName(tag),
  ].sort()
  const unexpected = names.filter((name) => !expected.includes(name))
  const missing = expected.filter((name) => !names.includes(name))
  if (unexpected.length || missing.length)
    throw new Error(
      `release bundle inventory mismatch; unexpected=${unexpected.join(',')} missing=${missing.join(',')}`,
    )
  verifyChecksums(
    join(bundle, 'SHA256SUMS.txt'),
    bundle,
    names.filter((name) => name !== 'SHA256SUMS.txt'),
    'full-bundle',
  )

  if (
    manifest.schemaVersion !== 1 ||
    manifest.channel !== 'stable' ||
    manifest.signingStatus !== 'unsigned' ||
    manifest.notarized !== false ||
    manifest.seal !== 'ad-hoc' ||
    manifest.tag !== tag ||
    manifest.commit !== commit ||
    manifest.version !== version ||
    typeof manifest.partial !== 'boolean'
  )
    throw new Error(
      `release manifest must declare an unsigned, ad-hoc sealed Stable ${tag} at ${commit}`,
    )
  const known = platforms.every((platform) =>
    STABLE_PLATFORMS.includes(platform),
  )
  const ordered =
    JSON.stringify(platforms) ===
    JSON.stringify(STABLE_PLATFORMS.filter((p) => platforms.includes(p)))
  if (!platforms.length || !known || !ordered)
    throw new Error(`release manifest platforms are invalid: ${platforms}`)
  const complete =
    JSON.stringify(platforms) === JSON.stringify(STABLE_PLATFORMS)
  if (manifest.partial === complete)
    throw new Error(
      'release manifest partial flag does not match its platforms',
    )
  if (manifest.partial && !allowPartial)
    throw new Error(
      `a partial bundle (${platforms.join(', ')} only) comes from a dry run and cannot be published`,
    )

  const recorded = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  if (
    JSON.stringify(recorded.map((item) => item?.name)) !==
    JSON.stringify([...artifacts].sort())
  )
    throw new Error('release manifest artifact inventory mismatch')
  for (const item of recorded) {
    const actual = fileRecord(join(bundle, item.name))
    if (item.sha256 !== actual.sha256 || item.size !== actual.size)
      throw new Error(`release manifest artifact record mismatch: ${item.name}`)
  }
  verifyChecksums(
    join(bundle, 'ARTIFACT-SHA256SUMS.txt'),
    bundle,
    artifacts,
    'artifact',
  )

  const sbom = readJson(join(bundle, sbomName(tag)), 'SBOM')
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6')
    throw new Error('release SBOM must be CycloneDX 1.6')

  const problems = notesProblems(
    readFileSync(join(bundle, 'RELEASE-NOTES.md'), 'utf8'),
    { version },
  )
  if (problems.length) throw new Error(problems.join('\n'))
  return { manifest, names }
}

/**
 * What publish-release.sh sends to GitHub for this bundle, as data: the
 * draft's title and notes, every asset, and the gh commands in order.
 */
export function draftPlan(bundleArg, { tag, commit, manifest, names }) {
  const bundle = resolve(bundleArg)
  const title = `Emperor Agent ${tag}`
  const notesFile = join(bundle, 'RELEASE-NOTES.md')
  return {
    dryRun: true,
    tag,
    commit,
    title,
    draft: true,
    prerelease: false,
    partial: manifest.partial,
    platforms: manifest.platforms,
    tagRequired: `refs/tags/${tag} → ${commit}`,
    notesFile,
    notes: readFileSync(notesFile, 'utf8'),
    assets: names.map((name) => {
      const record = fileRecord(join(bundle, name))
      return { name, size: record.size, sha256: record.sha256 }
    }),
    commands: [
      [
        'gh',
        'release',
        'create',
        tag,
        '--draft',
        '--verify-tag',
        '--title',
        title,
        '--notes-file',
        notesFile,
      ],
      [
        'gh',
        'release',
        'upload',
        tag,
        ...names.map((name) => join(bundle, name)),
      ],
      ['gh', 'release', 'edit', tag, '--draft=false'],
    ],
    checks: [
      `release-contract publication ${tag}`,
      `${tag} is an annotated tag at ${commit}`,
      `no GitHub release named ${tag} exists yet (gh release view)`,
      "the draft's asset list equals the bundle before it is made public",
    ],
  }
}

function writeDraftPlan(bundle, tag, commit, out) {
  const checked = assertPublication(bundle, { tag, commit, allowPartial: true })
  const plan = draftPlan(bundle, { tag, commit, ...checked })
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'draft-release.json'),
    `${JSON.stringify(plan, null, 2)}\n`,
  )
  writeFileSync(join(out, 'draft-release-notes.md'), plan.notes)
  return plan
}

function usage() {
  return [
    'usage:',
    '  release-contract.mjs checksums <bundle>',
    '  release-contract.mjs publication <bundle> <tag> <commit> [--allow-partial]',
    '  release-contract.mjs draft-plan <bundle> <tag> <commit> <out-dir>',
  ].join('\n')
}

function main(argv) {
  const [command, ...args] = argv
  if (command === 'checksums' && args.length === 1) {
    const names = writeChecksums(args[0])
    console.log(`SHA256SUMS.txt covers ${names.length} files`)
    return
  }
  if (
    command === 'publication' &&
    (args.length === 3 || (args.length === 4 && args[3] === '--allow-partial'))
  ) {
    const { manifest } = assertPublication(args[0], {
      tag: args[1],
      commit: args[2],
      allowPartial: args[3] === '--allow-partial',
    })
    console.log(
      `unsigned Stable ${args[1]} publication preflight passed (${manifest.platforms.join(', ')}${manifest.partial ? ', partial' : ''})`,
    )
    return
  }
  if (command === 'draft-plan' && args.length === 4) {
    const plan = writeDraftPlan(args[0], args[1], args[2], args[3])
    console.log(
      `dry run: draft ${plan.tag} with ${plan.assets.length} assets planned in ${resolve(args[3])}; gh was not run`,
    )
    return
  }
  throw new Error(usage())
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
