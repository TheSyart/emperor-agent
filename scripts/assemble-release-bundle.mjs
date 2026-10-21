#!/usr/bin/env node
// Assembles the unsigned Stable release bundle (REL-05) from the macOS
// candidates the release job downloaded (scripts/verify-macos-release.sh
// wrote them): the DMG and ZIP of each architecture, their SHA256SUMS, the
// candidate receipt and the packaged smoke receipt. Fails closed on anything
// missing, extra, signed, from another commit or from Preview or Internal.
//
//   node scripts/assemble-release-bundle.mjs <input> <output> <tag> <commit> [--arches arm64,x64]
//
// Writes the artifacts, ARTIFACT-SHA256SUMS.txt, release-manifest.json and
// RELEASE-NOTES.md (docs/release/stable-release-notes.md, rendered). The SBOM
// and SHA256SUMS.txt come after (generate-release-sbom.sh, release-contract.mjs
// checksums). --arches names fewer architectures for a local dry run
// (release-dry-run.mjs); the manifest then says partial and publication
// refuses the bundle.
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackagedSmokeReceipt } from './packaged-smoke-contract.mjs'
import {
  STABLE_ARCHES,
  assertCommit,
  checksumText,
  fileRecord,
  notesProblems,
  renderReleaseNotes,
  stableArtifactNames,
  stableVersion,
  verifyChecksums,
} from './release-contract.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP_IDENTIFIER = 'com.emperor.agent.desktop'

function parseArgs(argv) {
  const positional = []
  let arches = STABLE_ARCHES
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--arches') {
      const value = String(argv[++index] ?? '')
      arches = value.split(',').filter(Boolean)
      const unknown = arches.filter((arch) => !STABLE_ARCHES.includes(arch))
      if (!arches.length || unknown.length)
        throw new Error(
          `unknown architecture for a Stable release: ${unknown.join(', ') || value}`,
        )
      arches = STABLE_ARCHES.filter((arch) => arches.includes(arch))
    } else positional.push(argv[index])
  }
  if (positional.length !== 4)
    throw new Error(
      'usage: assemble-release-bundle.mjs <input> <output> <tag> <commit> [--arches arm64,x64]',
    )
  return { positional, arches }
}

function main(argv) {
  const { positional, arches } = parseArgs(argv)
  const [inputArg, outputArg, tag, commit] = positional
  const version = stableVersion(tag)
  assertCommit(commit)
  const packageVersion = JSON.parse(
    readFileSync(join(repoRoot, 'desktop', 'package.json'), 'utf8'),
  ).version
  if (version !== packageVersion)
    throw new Error(
      `tag ${tag} does not match desktop version ${packageVersion}`,
    )

  const inputRoot = resolve(inputArg)
  const outputRoot = resolve(outputArg)
  const files = inventory(inputRoot)
  const names = [...files.keys()]
  if (names.some((name) => name.includes('UNSIGNED-INTERNAL')))
    throw new Error('UNSIGNED-INTERNAL input cannot enter a Stable release')
  if (names.some((name) => name.includes('UNSIGNED-PREVIEW')))
    throw new Error('UNSIGNED-PREVIEW input cannot enter a Stable release')
  if (names.includes('preview-release-manifest.json'))
    throw new Error('Preview release input cannot enter a Stable release')

  const groups = arches.map((arch) => ({
    arch,
    artifacts: stableArtifactNames(version, [`macos-${arch}`]),
    checksums: `SHA256SUMS-macos-${arch}.txt`,
    receipt: `macos-${arch}.json`,
    smoke: `darwin-${arch}.json`,
  }))
  const expected = groups.flatMap((group) => [
    ...group.artifacts,
    group.checksums,
    group.receipt,
    group.smoke,
  ])
  const unexpected = names.filter((name) => !expected.includes(name))
  if (unexpected.length)
    throw new Error(`unexpected Stable input: ${unexpected.sort().join(', ')}`)
  const missing = expected.filter((name) => !files.has(name))
  if (missing.length)
    throw new Error(`missing Stable input: ${missing.sort().join(', ')}`)

  for (const group of groups) {
    const dir = (name) => resolve(files.get(name), '..')
    for (const name of group.artifacts)
      if (dir(name) !== dir(group.artifacts[0]))
        throw new Error(`macos-${group.arch} artifacts are not side by side`)
    verifyChecksums(
      files.get(group.checksums),
      dir(group.artifacts[0]),
      group.artifacts,
      `macos-${group.arch}`,
    )
    checkCandidate(
      readJson(files.get(group.receipt)),
      group,
      { tag, version, commit },
      files,
    )
    try {
      assertPackagedSmokeReceipt(readJson(files.get(group.smoke)), {
        appVersion: version,
        commit,
        platform: 'darwin',
        arch: group.arch,
      })
    } catch (error) {
      throw new Error(
        `invalid packaged smoke receipt ${group.smoke}: ${error.message}`,
      )
    }
  }

  const template = readFileSync(
    join(repoRoot, 'docs', 'release', 'stable-release-notes.md'),
    'utf8',
  )
  const notes = renderReleaseNotes(template, { tag, version })
  const problems = notesProblems(notes, { version })
  if (problems.length) throw new Error(problems.join('\n'))

  const artifactNames = groups.flatMap((group) => group.artifacts).sort()
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })
  for (const name of artifactNames)
    copyFileSync(files.get(name), join(outputRoot, name))
  writeFileSync(
    join(outputRoot, 'ARTIFACT-SHA256SUMS.txt'),
    checksumText(outputRoot, artifactNames),
  )
  const platforms = arches.map((arch) => `macos-${arch}`)
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    signingStatus: 'unsigned',
    notarized: false,
    seal: 'ad-hoc',
    tag,
    commit,
    version,
    platforms,
    partial: arches.length < STABLE_ARCHES.length,
    artifacts: artifactNames.map((name) => fileRecord(join(outputRoot, name))),
    receipts: groups
      .flatMap((group) => [group.receipt, group.smoke])
      .sort()
      .map((name) => fileRecord(files.get(name))),
    verification: {
      seal: platforms,
      packagedSmoke: platforms,
      checksumsVerified: true,
      attestationMeaning:
        'Build provenance and integrity only; no publisher signature or notarization.',
    },
  }
  writeFileSync(
    join(outputRoot, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(join(outputRoot, 'RELEASE-NOTES.md'), notes)
  console.log(
    `assembled ${artifactNames.length} unsigned Stable artifacts for ${platforms.join(', ')}${manifest.partial ? ' (partial: a dry run only)' : ''}`,
  )
}

/** The candidate receipt says: unsigned, sealed ad hoc, this tag and commit. */
function checkCandidate(receipt, group, { tag, version, commit }, files) {
  const failed = (what) =>
    new Error(
      `macos/${group.arch} candidate is not an unsigned, ad-hoc sealed Stable build of ${tag} at ${commit}: ${what}`,
    )
  const seal = receipt?.seal
  const checks = [
    ['schemaVersion', receipt?.schemaVersion === 1],
    ['channel', receipt?.channel === 'stable'],
    ['signingStatus', receipt?.signingStatus === 'unsigned'],
    ['notarized', receipt?.notarized === false],
    [
      'signing identity',
      !['teamId', 'authority', 'signed', 'identity'].some(
        (key) => receipt && key in receipt,
      ),
    ],
    ['version', receipt?.version === version],
    ['commit', receipt?.commit === commit],
    ['platform', receipt?.platform === 'macos'],
    ['arch', receipt?.arch === group.arch],
    ['seal.adHoc', seal?.adHoc === true],
    ['seal.codesignStrict', seal?.codesignStrict === true],
    ['seal.identifier', seal?.identifier === APP_IDENTIFIER],
    [
      'seal.sealedCode',
      Number.isSafeInteger(seal?.sealedCode) && seal.sealedCode > 0,
    ],
    ['seal.hardenedRuntime', seal?.hardenedRuntime === true],
    ['seal.fusesVerified', seal?.fusesVerified === true],
    ['dmgMounted', receipt?.dmgMounted === true],
    ['zipExtracted', receipt?.zipExtracted === true],
    ['packagedSmoke', receipt?.packagedSmoke === group.smoke],
  ]
  const wrong = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (wrong.length) throw failed(wrong.join(', '))
  const recorded = Array.isArray(receipt.artifacts) ? receipt.artifacts : []
  const actual = group.artifacts.map((name) => fileRecord(files.get(name)))
  const key = (items) =>
    JSON.stringify(
      items
        .map(({ name, sha256, size }) => ({ name, sha256, size }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    )
  if (key(recorded) !== key(actual)) throw failed('artifact records')
}

function inventory(root) {
  const found = new Map()
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        throw new Error(`symbolic links are forbidden: ${path}`)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        if (found.has(entry.name))
          throw new Error(`duplicate Stable input basename: ${entry.name}`)
        found.set(entry.name, path)
      }
    }
  }
  visit(root)
  return found
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`invalid JSON receipt: ${path}`)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
