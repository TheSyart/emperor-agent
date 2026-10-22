#!/usr/bin/env node
// A local dry run of the Stable release (REL-05). From candidates already
// built and verified in desktop/dist (scripts/build_desktop_release.sh, then
// scripts/verify-macos-release.sh <arch>), it runs the release job's
// aggregate and publish steps into one folder and stops before GitHub:
//
//   <out>/release-inputs/    what the release job downloads
//   <out>/release-bundle/    exactly what would be uploaded: the artifacts,
//                            ARTIFACT-SHA256SUMS.txt, release-manifest.json,
//                            RELEASE-NOTES.md, the SBOM and SHA256SUMS.txt
//   <out>/draft-release.json the draft it would create (title, notes, assets,
//                            the gh commands in order), and the notes body in
//                            draft-release-notes.md
//
// Nothing is created on GitHub: no tag, no release, no draft, no gh call.
// The provenance attestations exist only on GitHub and are not made here.
//
//   node scripts/release-dry-run.mjs --out <dir> [--dist desktop/dist]
//     [--tag v<version>] [--commit <sha>] [--arches arm64,x64]
//     [--sbom <file.cdx.json>]
//
// --arches defaults to the architectures found in dist; fewer than both
// gives a partial bundle that publication refuses. --sbom uses a document
// already made instead of running generate-release-sbom.sh (npx).
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STABLE_ARCHES, sbomName, stableVersion } from './release-contract.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (
      !['--out', '--dist', '--tag', '--commit', '--arches', '--sbom'].includes(
        name,
      )
    )
      throw new Error(`unknown option: ${name}`)
    const value = argv[++index]
    if (!value) throw new Error(`${name} needs a value`)
    options[name.slice(2)] = value
  }
  if (!options.out)
    throw new Error(
      'usage: release-dry-run.mjs --out <dir> [--dist <dir>] [--tag <tag>] [--commit <sha>] [--arches arm64,x64] [--sbom <file>]',
    )
  return options
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`${basename(args[0] ?? command)} failed`)
  }
}

function candidateFiles(dist, arch, version) {
  return [
    `Emperor-Agent-${version}-macos-${arch}.dmg`,
    `Emperor-Agent-${version}-macos-${arch}.zip`,
    `SHA256SUMS-macos-${arch}.txt`,
    join('packaged-smoke', `darwin-${arch}.json`),
    join('release-receipts', `macos-${arch}.json`),
  ].map((relative) => ({ relative, path: join(dist, relative) }))
}

function main(argv) {
  const options = parseArgs(argv)
  const dist = resolve(options.dist ?? join(repoRoot, 'desktop', 'dist'))
  const out = resolve(options.out)
  const version = JSON.parse(
    readFileSync(join(repoRoot, 'desktop', 'package.json'), 'utf8'),
  ).version
  const tag = options.tag ?? `v${version}`
  if (stableVersion(tag) !== version)
    throw new Error(`tag ${tag} does not match desktop version ${version}`)
  const commit =
    options.commit ??
    spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).stdout.trim()

  const arches = options.arches
    ? options.arches.split(',').filter(Boolean)
    : STABLE_ARCHES.filter((arch) =>
        existsSync(join(dist, `Emperor-Agent-${version}-macos-${arch}.dmg`)),
      )
  if (!arches.length)
    throw new Error(
      `no Stable candidate in ${dist}: run scripts/build_desktop_release.sh, then scripts/verify-macos-release.sh <arch>`,
    )
  for (const arch of arches) {
    const missing = candidateFiles(dist, arch, version).filter(
      (file) => !existsSync(file.path),
    )
    if (missing.length)
      throw new Error(
        `the macos-${arch} candidate is incomplete (${missing.map((file) => file.relative).join(', ')}): run scripts/verify-macos-release.sh ${arch} after scripts/build_desktop_release.sh`,
      )
  }

  rmSync(out, { recursive: true, force: true })
  const inputs = join(out, 'release-inputs')
  for (const arch of arches)
    for (const file of candidateFiles(dist, arch, version)) {
      const target = join(inputs, `macos-${arch}-candidate`, file.relative)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(file.path, target)
    }

  const bundle = join(out, 'release-bundle')
  run(process.execPath, [
    join(repoRoot, 'scripts', 'assemble-release-bundle.mjs'),
    inputs,
    bundle,
    tag,
    commit,
    '--arches',
    arches.join(','),
  ])
  const sbom = join(bundle, sbomName(tag))
  if (options.sbom) copyFileSync(resolve(options.sbom), sbom)
  else
    run('bash', [join(repoRoot, 'scripts', 'generate-release-sbom.sh'), sbom])
  run(process.execPath, [
    join(repoRoot, 'scripts', 'release-contract.mjs'),
    'checksums',
    bundle,
  ])
  run(
    'bash',
    [join(repoRoot, 'scripts', 'publish-release.sh'), '--dry-run', out, bundle],
    {
      EMPEROR_RELEASE_TAG: tag,
      EMPEROR_RELEASE_COMMIT: commit,
    },
  )
  console.log(
    [
      `dry run of ${tag} at ${commit} (${arches.map((arch) => `macos-${arch}`).join(', ')}${arches.length < STABLE_ARCHES.length ? ', partial' : ''}):`,
      `  upload:  ${bundle}`,
      `  draft:   ${join(out, 'draft-release.json')}`,
      `  notes:   ${join(out, 'draft-release-notes.md')}`,
      'Nothing was sent to GitHub. The real draft comes from the release workflow.',
    ].join('\n'),
  )
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
