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

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [inputArg, outputArg, tag, commit] = process.argv.slice(2)
if (!inputArg || !outputArg || !tag || !commit) {
  fail('usage: assemble-release-bundle.mjs <input> <output> <tag> <commit>')
}
if (!/^[a-f0-9]{40}$/i.test(commit)) fail('release commit must be a full SHA')

const packageMetadata = JSON.parse(
  readFileSync(join(repoRoot, 'desktop', 'package.json'), 'utf8'),
)
if (tag !== `v${packageMetadata.version}`) {
  fail(`tag ${tag} does not match desktop version ${packageMetadata.version}`)
}

const inputRoot = resolve(inputArg)
const outputRoot = resolve(outputArg)
const platformReceiptNames = {
  macosArm64: 'macos-arm64.json',
  macosX64: 'macos-x64.json',
  windowsX64: 'windows-x64.json',
  linuxX64: 'linux-x64-build.json',
}
const linuxLifecycleNames = {
  22.04: '22.04-lifecycle.json',
  24.04: '24.04-lifecycle.json',
}
const files = inventory(inputRoot)
if ([...files.keys()].some((name) => name.includes('UNSIGNED-INTERNAL'))) {
  fail('UNSIGNED-INTERNAL artifacts cannot enter a trusted release')
}

const version = escapeRegExp(packageMetadata.version)
const artifactRules = [
  ['macos-arm64-dmg', new RegExp(`^Emperor-Agent-${version}-mac-arm64\\.dmg$`)],
  ['macos-arm64-zip', new RegExp(`^Emperor-Agent-${version}-mac-arm64\\.zip$`)],
  ['macos-x64-dmg', new RegExp(`^Emperor-Agent-${version}-mac-x64\\.dmg$`)],
  ['macos-x64-zip', new RegExp(`^Emperor-Agent-${version}-mac-x64\\.zip$`)],
  ['windows-x64', new RegExp(`^Emperor-Agent-${version}-win-x64\\.exe$`)],
  [
    'linux-appimage',
    new RegExp(`^Emperor-Agent-${version}-linux-x64\\.AppImage$`),
  ],
  ['linux-deb', new RegExp(`^Emperor-Agent-${version}-linux-x64\\.deb$`)],
]
const artifacts = artifactRules.map(([label, pattern]) => {
  const matches = [...files.entries()].filter(([name]) => pattern.test(name))
  if (matches.length !== 1)
    fail(`expected exactly one ${label}, found ${matches.length}`)
  return { name: matches[0][0], path: matches[0][1] }
})

const checksumGroups = [
  ['SHA256SUMS-macos-arm64.txt', artifacts.slice(0, 2)],
  ['SHA256SUMS-macos-x64.txt', artifacts.slice(2, 4)],
  ['SHA256SUMS-windows-x64.txt', artifacts.slice(4, 5)],
  ['SHA256SUMS-linux-x64.txt', artifacts.slice(5, 7)],
]
for (const [manifestName, group] of checksumGroups) {
  verifyChecksumManifest(required(files, manifestName), group)
}

validatePlatformReceipts(files, commit.toLowerCase(), artifacts)
for (const name of ['darwin-arm64.json', 'darwin-x64.json', 'win32-x64.json']) {
  validateSmokeReceipt(
    readJson(required(files, name)),
    commit.toLowerCase(),
    name,
  )
}
for (const versionId of ['22.04', '24.04']) {
  for (const kind of ['appimage', 'deb']) {
    const name = `${versionId}-${kind}.json`
    validateSmokeReceipt(
      readJson(required(files, name)),
      commit.toLowerCase(),
      name,
    )
  }
  validateLinuxLifecycle(
    readJson(required(files, linuxLifecycleNames[versionId])),
    commit.toLowerCase(),
    versionId,
  )
}

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
const manifestArtifacts = artifacts
  .map((artifact) => {
    copyFileSync(artifact.path, join(outputRoot, artifact.name))
    return {
      name: artifact.name,
      sha256: sha256(artifact.path),
      bytes: lstatSync(artifact.path).size,
    }
  })
  .sort((left, right) => left.name.localeCompare(right.name))

writeFileSync(
  join(outputRoot, 'ARTIFACT-SHA256SUMS.txt'),
  `${manifestArtifacts.map((item) => `${item.sha256} *${item.name}`).join('\n')}\n`,
)
writeFileSync(
  join(outputRoot, 'release-manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      tag,
      commit: commit.toLowerCase(),
      version: packageMetadata.version,
      artifacts: manifestArtifacts,
      verification: {
        macos: ['arm64', 'x64'],
        windows: ['x64'],
        linux: ['ubuntu-22.04', 'ubuntu-24.04'],
        receiptsValidated: true,
      },
    },
    null,
    2,
  )}\n`,
)
console.log(`assembled ${manifestArtifacts.length} trusted release artifacts`)

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
          fail(`duplicate release input basename: ${entry.name}`)
        found.set(entry.name, path)
      }
    }
  }
  visit(root)
  return found
}

function validatePlatformReceipts(
  filesByName,
  expectedCommit,
  releaseArtifacts,
) {
  for (const arch of ['arm64', 'x64']) {
    const receiptName =
      arch === 'arm64'
        ? platformReceiptNames.macosArm64
        : platformReceiptNames.macosX64
    const receipt = readJson(required(filesByName, receiptName))
    assertReceiptBase(receipt, expectedCommit, 'macos', arch)
    for (const key of ['signed', 'gatekeeper', 'notarized', 'dmgMounted']) {
      if (receipt[key] !== true) fail(`macOS ${arch} receipt failed ${key}`)
    }
    if (typeof receipt.teamId !== 'string' || !receipt.teamId)
      fail('missing macOS team ID')
    assertArtifactSet(
      receipt.artifacts,
      releaseArtifacts.slice(
        arch === 'arm64' ? 0 : 2,
        arch === 'arm64' ? 2 : 4,
      ),
    )
  }

  const windows = readJson(
    required(filesByName, platformReceiptNames.windowsX64),
  )
  assertReceiptBase(windows, expectedCommit, 'windows', 'x64')
  for (const key of [
    'authenticode',
    'installedExecutableSigned',
    'uninstallerSigned',
  ]) {
    if (windows[key] !== true) fail(`Windows receipt failed ${key}`)
  }
  for (const key of ['installExitCode', 'smokeExitCode', 'uninstallExitCode']) {
    if (windows[key] !== 0) fail(`Windows receipt has non-zero ${key}`)
  }
  if (typeof windows.publisher !== 'string' || !windows.publisher)
    fail('missing Windows publisher')
  assertArtifactSet(windows.artifacts, releaseArtifacts.slice(4, 5))

  const linux = readJson(required(filesByName, platformReceiptNames.linuxX64))
  assertReceiptBase(linux, expectedCommit, 'linux', 'x64')
  if (linux.metadataVerified !== true || linux.debArchitecture !== 'amd64') {
    fail('Linux build receipt did not verify DEB metadata')
  }
  assertArtifactSet(linux.artifacts, releaseArtifacts.slice(5, 7))
}

function validateSmokeReceipt(receipt, expectedCommit, name) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.commit !== expectedCommit ||
    receipt.exitCode !== 0 ||
    receipt.stateRoot !== '$TEMP/stateRoot' ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeManifestHash || '') ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeRevision || '') ||
    receipt.installJobs?.before !== 0 ||
    receipt.installJobs?.after !== 0
  ) {
    fail(`invalid packaged smoke receipt: ${name}`)
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

function validateLinuxLifecycle(receipt, expectedCommit, versionId) {
  assertReceiptBase(receipt, expectedCommit, 'linux', 'x64')
  if (receipt.ubuntuVersion !== versionId)
    fail(`wrong Ubuntu lifecycle receipt: ${versionId}`)
  for (const key of ['appImageSmoke', 'debInstall', 'debSmoke', 'debRemove']) {
    if (receipt[key] !== true)
      fail(`Ubuntu ${versionId} lifecycle failed ${key}`)
  }
}

function assertReceiptBase(receipt, expectedCommit, platform, arch) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.commit !== expectedCommit ||
    receipt.platform !== platform ||
    receipt.arch !== arch
  ) {
    fail(`invalid ${platform}/${arch} release receipt`)
  }
}

function assertArtifactSet(names, expectedArtifacts) {
  const expected = expectedArtifacts.map((item) => item.name).sort()
  const actual = Array.isArray(names) ? [...names].sort() : []
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail('release receipt artifact set mismatch')
}

function verifyChecksumManifest(path, expectedArtifacts) {
  const expected = new Map(
    expectedArtifacts.map((item) => [item.name, sha256(item.path)]),
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

function required(filesByName, name) {
  const path = filesByName.get(name)
  if (!path) fail(`missing required release input: ${name}`)
  return path
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`invalid JSON receipt: ${basename(path)}`)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message) {
  throw new Error(message)
}
