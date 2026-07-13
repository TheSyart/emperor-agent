#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyReleaseTag,
  previewVersion,
} from './preview-release-contract.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [inputArg, outputArg, tag, commitArg, runId] = process.argv.slice(2)
if (!inputArg || !outputArg || !tag || !commitArg || !runId) {
  fail(
    'usage: assemble-preview-release-bundle.mjs <input> <output> <tag> <commit> <run-id>',
  )
}
if (classifyReleaseTag(tag) !== 'preview') fail(`not a Preview tag: ${tag}`)
if (!/^[a-f0-9]{40}$/i.test(commitArg)) fail('commit must be a full SHA')
if (!/^[1-9]\d*$/.test(runId)) fail('run ID must be a positive integer')

const packageMetadata = readJson(join(repoRoot, 'desktop', 'package.json'))
const version = previewVersion(tag)
if (!version.startsWith(`${packageMetadata.version}-preview.`)) {
  fail(
    `Preview tag ${tag} is outside desktop version ${packageMetadata.version}`,
  )
}

const commit = commitArg.toLowerCase()
const inputRoot = resolve(inputArg)
const outputRoot = resolve(outputArg)
const artifactNames = [
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-arm64.dmg`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-arm64.zip`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-x64.dmg`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-x64.zip`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-windows-x64.exe`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.AppImage`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.deb`,
]
const groups = [
  candidateGroup(
    'macos',
    'arm64',
    'darwin-arm64.json',
    artifactNames.slice(0, 2),
  ),
  candidateGroup('macos', 'x64', 'darwin-x64.json', artifactNames.slice(2, 4)),
  candidateGroup('windows', 'x64', 'win32-x64.json', artifactNames.slice(4, 5)),
  candidateGroup('linux', 'x64', 'linux-x64.json', artifactNames.slice(5, 7)),
]
const lifecycleNames = ['22.04', '24.04'].map(
  (value) => `UNSIGNED-PREVIEW-ubuntu-${value}.json`,
)
const files = inventory(inputRoot)

if ([...files.keys()].some((name) => name.includes('UNSIGNED-INTERNAL'))) {
  fail('UNSIGNED-INTERNAL input cannot enter a Preview release')
}
if ([...files.keys()].some((name) => name === 'release-manifest.json')) {
  fail('Stable release input cannot enter a Preview release')
}

const expectedInputs = new Set([
  ...artifactNames,
  ...groups.flatMap((group) => [
    group.checksumName,
    group.smokeName,
    group.receiptName,
    group.markerName,
  ]),
  ...lifecycleNames,
])
const unexpected = [...files.keys()].filter((name) => !expectedInputs.has(name))
if (unexpected.length > 0) {
  fail(`unexpected Preview input: ${unexpected.sort().join(', ')}`)
}
const missing = [...expectedInputs].filter((name) => !files.has(name))
if (missing.length > 0)
  fail(`missing Preview input: ${missing.sort().join(', ')}`)

const artifacts = artifactNames.map((name) => ({
  name,
  path: required(files, name),
  ...fileDigest(required(files, name)),
}))

for (const group of groups) {
  const groupArtifacts = group.artifactNames.map((name) =>
    artifacts.find((artifact) => artifact.name === name),
  )
  verifyChecksumManifest(required(files, group.checksumName), groupArtifacts)

  const receipt = readJson(required(files, group.receiptName))
  assertPreviewBase(receipt, group.platform, group.arch)
  if (receipt.resourceInspection !== true)
    fail(`${group.platform}/${group.arch} resource inspection is missing`)
  assertFileRecord(
    receipt.packagedSmoke,
    required(files, group.smokeName),
    'candidate packaged smoke record mismatch',
  )
  assertFileRecords(
    receipt.artifacts,
    groupArtifacts,
    'candidate artifact record mismatch',
  )
  validateSmokeReceipt(
    readJson(required(files, group.smokeName)),
    group.smokePlatform,
    group.arch,
    group.smokeName,
  )

  const marker = readJson(required(files, group.markerName))
  assertPreviewBase(marker, group.platform, group.arch)
}

for (const ubuntuVersion of ['22.04', '24.04']) {
  const name = `UNSIGNED-PREVIEW-ubuntu-${ubuntuVersion}.json`
  const receipt = readJson(required(files, name))
  assertPreviewBase(receipt, 'linux', 'x64')
  if (receipt.ubuntuVersion !== ubuntuVersion)
    fail(`wrong Ubuntu Preview receipt: ${ubuntuVersion}`)
  for (const key of ['appImageSmoke', 'debInstall', 'debSmoke', 'debRemove']) {
    if (receipt[key] !== true)
      fail(`Ubuntu ${ubuntuVersion} Preview receipt failed ${key}`)
  }
  validateSourceReceiptRecords(receipt.sourceReceipts, ubuntuVersion)
}

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
for (const artifact of artifacts) {
  copyFileSync(artifact.path, join(outputRoot, artifact.name))
}

const manifestArtifacts = artifacts
  .map(({ name, sha256, size }) => ({ name, sha256, size }))
  .sort((left, right) => left.name.localeCompare(right.name))
const receiptRecords = [
  ...groups.flatMap((group) => [
    fileRecord(required(files, group.receiptName)),
    fileRecord(required(files, group.markerName)),
    fileRecord(required(files, group.smokeName)),
  ]),
  ...lifecycleNames.map((name) => fileRecord(required(files, name))),
].sort((left, right) => left.name.localeCompare(right.name))

writeFileSync(
  join(outputRoot, 'ARTIFACT-SHA256SUMS.txt'),
  `${manifestArtifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join('\n')}\n`,
)
const marker = {
  schemaVersion: 1,
  marker: 'UNSIGNED-PREVIEW',
  channel: 'preview',
  signingStatus: 'unsigned',
  notarized: false,
  tag,
  commit,
  runId,
}
writeJson(join(outputRoot, 'UNSIGNED-PREVIEW.json'), marker)
writeJson(join(outputRoot, 'preview-release-manifest.json'), {
  ...marker,
  version,
  artifacts: manifestArtifacts,
  receipts: receiptRecords,
  verification: {
    packagedSmoke: ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64'],
    linuxLifecycle: ['ubuntu-22.04', 'ubuntu-24.04'],
    resourceInspection: true,
    checksumsVerified: true,
    attestationMeaning:
      'Build provenance and integrity only; no publisher signature or notarization.',
  },
})
const noticeTemplate = readFileSync(
  join(repoRoot, 'docs', 'release', 'unsigned-preview-notice.md'),
  'utf8',
)
writeFileSync(
  join(outputRoot, 'UNSIGNED-PREVIEW-NOTICE.md'),
  noticeTemplate.replaceAll('{{tag}}', tag),
  'utf8',
)

console.log(`assembled ${manifestArtifacts.length} unsigned Preview artifacts`)

function candidateGroup(platform, arch, smokeName, names) {
  return {
    platform,
    arch,
    smokePlatform:
      platform === 'macos'
        ? 'darwin'
        : platform === 'windows'
          ? 'win32'
          : 'linux',
    smokeName,
    artifactNames: names,
    checksumName: `SHA256SUMS-${platform}-${arch}.txt`,
    receiptName: `candidate-${platform}-${arch}.json`,
    markerName: `UNSIGNED-PREVIEW-${platform}-${arch}.marker.json`,
  }
}

function inventory(root) {
  const found = new Map()
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) fail(`symbolic links are forbidden: ${path}`)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        if (found.has(entry.name))
          fail(`duplicate Preview input basename: ${entry.name}`)
        found.set(entry.name, path)
      }
    }
  }
  visit(root)
  return found
}

function assertPreviewBase(receipt, platform, arch) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.marker !== 'UNSIGNED-PREVIEW' ||
    receipt.channel !== 'preview' ||
    receipt.signingStatus !== 'unsigned' ||
    receipt.tag !== tag ||
    receipt.commit !== commit ||
    receipt.runId !== runId ||
    receipt.platform !== platform ||
    receipt.arch !== arch
  ) {
    fail(`invalid Preview receipt for ${platform}/${arch}`)
  }
}

function validateSmokeReceipt(receipt, platform, arch, name) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.appVersion !== version ||
    receipt.commit !== commit ||
    receipt.platform !== platform ||
    receipt.arch !== arch ||
    receipt.exitCode !== 0 ||
    receipt.stateRoot !== '$TEMP/stateRoot' ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeManifestHash || '') ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeRevision || '') ||
    receipt.installJobs?.before !== 0 ||
    receipt.installJobs?.after !== 0
  ) {
    fail(`invalid Preview packaged smoke receipt: ${name}`)
  }
  for (const operation of [
    'bootstrap',
    'diagnostics',
    'environment',
    'glob',
    'grep',
  ]) {
    if (receipt.operations?.[operation]?.ok !== true)
      fail(`${name} failed ${operation}`)
  }
}

function validateSourceReceiptRecords(records, ubuntuVersion) {
  const expected = [
    `${ubuntuVersion}-appimage.json`,
    `${ubuntuVersion}-deb.json`,
    `${ubuntuVersion}-lifecycle.json`,
  ]
  if (!Array.isArray(records) || records.length !== expected.length)
    fail(`invalid Ubuntu ${ubuntuVersion} source receipt records`)
  const names = records.map((record) => record?.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(expected.sort()))
    fail(`invalid Ubuntu ${ubuntuVersion} source receipt names`)
  for (const record of records) {
    if (
      !/^[a-f0-9]{64}$/.test(record?.sha256 || '') ||
      !Number.isSafeInteger(record?.size) ||
      record.size <= 0
    )
      fail(`invalid Ubuntu ${ubuntuVersion} source receipt digest`)
  }
}

function assertFileRecords(records, expectedArtifacts, message) {
  if (!Array.isArray(records) || records.length !== expectedArtifacts.length)
    fail(message)
  const expected = expectedArtifacts
    .map(({ name, sha256, size }) => ({ name, sha256, size }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const actual = records
    .map(({ name, sha256, size }) => ({ name, sha256, size }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(message)
}

function assertFileRecord(record, path, message) {
  const expected = fileRecord(path)
  if (
    record?.name !== expected.name ||
    record?.sha256 !== expected.sha256 ||
    record?.size !== expected.size
  )
    fail(message)
}

function verifyChecksumManifest(path, expectedArtifacts) {
  const expected = new Map(
    expectedArtifacts.map((artifact) => [artifact.name, artifact.sha256]),
  )
  const actual = new Map()
  for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (!match || actual.has(match[2]))
      fail(`invalid checksum manifest: ${basename(path)}`)
    actual.set(match[2], match[1].toLowerCase())
  }
  if (actual.size !== expected.size)
    fail(`checksum coverage mismatch: ${basename(path)}`)
  for (const [name, digest] of expected) {
    if (actual.get(name) !== digest) fail(`checksum mismatch: ${name}`)
  }
}

function fileRecord(path) {
  return { name: basename(path), ...fileDigest(path) }
}

function fileDigest(path) {
  const body = readFileSync(path)
  return {
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  }
}

function required(filesByName, name) {
  const path = filesByName.get(name)
  if (!path) fail(`missing required Preview input: ${name}`)
  return path
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`invalid JSON: ${basename(path)}`)
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function fail(message) {
  throw new Error(message)
}
