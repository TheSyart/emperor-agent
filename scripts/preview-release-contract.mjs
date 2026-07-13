#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const previewTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.([1-9]\d*)$/
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const commitPattern = /^[a-f0-9]{40}$/
const runIdPattern = /^[1-9]\d*$/
const previewMarker = 'UNSIGNED-PREVIEW'

const platformSpecs = {
  macos: {
    arches: ['arm64', 'x64'],
    extensions: ['dmg', 'zip'],
    smoke: 'darwin',
  },
  windows: { arches: ['x64'], extensions: ['exe'], smoke: 'win32' },
  linux: { arches: ['x64'], extensions: ['AppImage', 'deb'], smoke: 'linux' },
}

export function classifyReleaseTag(tag) {
  if (previewTagPattern.test(tag)) return 'preview'
  if (stableTagPattern.test(tag)) return 'stable'
  return 'none'
}

export function previewVersion(tag) {
  if (classifyReleaseTag(tag) !== 'preview')
    throw new Error(`not a supported Preview tag: ${tag}`)
  return tag.slice(1)
}

export function createPreviewCandidate({
  distRoot,
  tag,
  commit,
  runId,
  platform,
  arch,
}) {
  const dist = resolve(distRoot)
  const version = previewVersion(tag)
  validateIdentity({ commit, runId, platform, arch })
  rejectForeignMarkers(dist)

  const spec = platformSpecs[platform]
  const expectedNames = spec.extensions.map(
    (extension) =>
      `Emperor-Agent-${version}-${previewMarker}-${platform}-${arch}.${extension}`,
  )
  rejectForeignProductFiles(dist, platform, arch, expectedNames)
  for (const name of expectedNames) {
    const file = join(dist, name)
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Error(`missing Preview artifact: ${name}`)
  }

  const smokeName = `${spec.smoke}-${arch}.json`
  const smokePath = join(dist, 'packaged-smoke', smokeName)
  const smoke = readJson(smokePath, 'packaged smoke receipt')
  if (
    smoke.schemaVersion !== 1 ||
    smoke.appVersion !== version ||
    smoke.commit !== commit ||
    smoke.platform !== spec.smoke ||
    smoke.arch !== arch ||
    smoke.exitCode !== 0
  )
    throw new Error('packaged smoke receipt does not match Preview candidate')

  const artifacts = expectedNames.map((name) => fileRecord(join(dist, name)))
  const smokeReceipt = fileRecord(smokePath)
  const common = {
    schemaVersion: 1,
    marker: previewMarker,
    channel: 'preview',
    signingStatus: 'unsigned',
    tag,
    commit,
    runId,
    platform,
    arch,
  }
  const receipt = {
    ...common,
    resourceInspection: true,
    packagedSmoke: smokeReceipt,
    artifacts,
  }
  const receiptRoot = join(dist, 'preview-receipts')
  mkdirSync(receiptRoot, { recursive: true })
  writeJsonAtomic(
    join(receiptRoot, `candidate-${platform}-${arch}.json`),
    receipt,
  )
  writeJsonAtomic(
    join(receiptRoot, `${previewMarker}-${platform}-${arch}.marker.json`),
    common,
  )
  writeFileAtomic(
    join(dist, `SHA256SUMS-${platform}-${arch}.txt`),
    `${artifacts.map(({ sha256, name }) => `${sha256}  ${name}`).join('\n')}\n`,
  )
  return receipt
}

export function createPreviewLinuxLifecycle({
  distRoot,
  tag,
  commit,
  runId,
  ubuntuVersion,
}) {
  const dist = resolve(distRoot)
  previewVersion(tag)
  validateIdentity({ commit, runId, platform: 'linux', arch: 'x64' })
  if (!['22.04', '24.04'].includes(ubuntuVersion))
    throw new Error(`unsupported Ubuntu version: ${ubuntuVersion}`)
  rejectForeignMarkers(dist)

  const sourceRoot = join(dist, 'linux-receipts')
  const sourceNames = [
    `${ubuntuVersion}-appimage.json`,
    `${ubuntuVersion}-deb.json`,
    `${ubuntuVersion}-lifecycle.json`,
  ]
  const sources = sourceNames.map((name) => fileRecord(join(sourceRoot, name)))
  const lifecycle = readJson(
    join(sourceRoot, `${ubuntuVersion}-lifecycle.json`),
    'Linux lifecycle receipt',
  )
  if (
    lifecycle.commit !== commit ||
    lifecycle.ubuntuVersion !== ubuntuVersion ||
    lifecycle.appImageSmoke !== true ||
    lifecycle.debInstall !== true ||
    lifecycle.debSmoke !== true ||
    lifecycle.debRemove !== true
  )
    throw new Error('Linux lifecycle receipt does not match Preview candidate')

  const receipt = {
    schemaVersion: 1,
    marker: previewMarker,
    channel: 'preview',
    signingStatus: 'unsigned',
    tag,
    commit,
    runId,
    platform: 'linux',
    arch: 'x64',
    ubuntuVersion,
    appImageSmoke: true,
    debInstall: true,
    debSmoke: true,
    debRemove: true,
    sourceReceipts: sources,
  }
  const outputRoot = join(dist, 'preview-linux-receipts')
  mkdirSync(outputRoot, { recursive: true })
  writeJsonAtomic(
    join(outputRoot, `${previewMarker}-ubuntu-${ubuntuVersion}.json`),
    receipt,
  )
  return receipt
}

function validateIdentity({ commit, runId, platform, arch }) {
  if (!commitPattern.test(commit)) throw new Error('invalid commit SHA')
  if (!runIdPattern.test(runId)) throw new Error('invalid workflow run ID')
  const spec = platformSpecs[platform]
  if (!spec || !spec.arches.includes(arch))
    throw new Error(`unsupported Preview target: ${platform}/${arch}`)
}

function rejectForeignMarkers(dist) {
  if (!existsSync(dist))
    throw new Error(`distribution directory missing: ${dist}`)
  const names = readdirSync(dist)
  if (names.some((name) => name.includes('UNSIGNED-INTERNAL')))
    throw new Error('UNSIGNED-INTERNAL input cannot enter Preview')
  if (names.some((name) => name === 'release-manifest.json'))
    throw new Error('Stable release input cannot enter Preview')
}

function rejectForeignProductFiles(dist, platform, arch, expectedNames) {
  const extensionPattern = new RegExp(
    `\\.(${platformSpecs[platform].extensions.map(escapeRegex).join('|')})$`,
  )
  const candidates = readdirSync(dist).filter(
    (name) =>
      name.startsWith('Emperor-Agent-') &&
      name.includes(`-${platform === 'windows' ? 'win' : platform}-${arch}`) &&
      extensionPattern.test(name),
  )
  const foreign = candidates.filter((name) => !expectedNames.includes(name))
  if (foreign.length > 0)
    throw new Error(`non-Preview artifact input: ${foreign.join(', ')}`)
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${basename(file)}`, {
      cause: error,
    })
  }
}

function fileRecord(file) {
  if (!existsSync(file) || !statSync(file).isFile())
    throw new Error(`required file missing: ${basename(file)}`)
  const body = readFileSync(file)
  return {
    name: basename(file),
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeFileAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, value, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function usage() {
  return [
    'usage:',
    '  preview-release-contract.mjs classify <tag>',
    '  preview-release-contract.mjs assert <tag> <preview|stable>',
    '  preview-release-contract.mjs candidate <dist> <tag> <commit> <run-id> <platform> <arch>',
    '  preview-release-contract.mjs linux-lifecycle <dist> <tag> <commit> <run-id> <ubuntu-version>',
  ].join('\n')
}

function main(argv) {
  const [command, ...args] = argv
  if (command === 'classify' && args.length === 1) {
    console.log(classifyReleaseTag(args[0]))
    return
  }
  if (command === 'assert' && args.length === 2) {
    const actual = classifyReleaseTag(args[0])
    if (actual !== args[1])
      throw new Error(`release tag routes to ${actual}, expected ${args[1]}`)
    console.log(actual)
    return
  }
  if (command === 'candidate' && args.length === 6) {
    createPreviewCandidate({
      distRoot: args[0],
      tag: args[1],
      commit: args[2],
      runId: args[3],
      platform: args[4],
      arch: args[5],
    })
    return
  }
  if (command === 'linux-lifecycle' && args.length === 5) {
    createPreviewLinuxLifecycle({
      distRoot: args[0],
      tag: args[1],
      commit: args[2],
      runId: args[3],
      ubuntuVersion: args[4],
    })
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
