#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  classifyReleaseTag,
  previewVersion,
} from './preview-release-contract.mjs'

const [bundleArg, tag, commitArg, runId] = process.argv.slice(2)
if (!bundleArg || !tag || !commitArg || !runId) {
  fail(
    'usage: preview-publication-contract.mjs <bundle> <tag> <commit> <run-id>',
  )
}
if (classifyReleaseTag(tag) !== 'preview') fail(`not a Preview tag: ${tag}`)
if (!/^[a-f0-9]{40}$/i.test(commitArg)) fail('commit must be a full SHA')
if (!/^[1-9]\d*$/.test(runId)) fail('run ID must be a positive integer')

const bundle = resolve(bundleArg)
const commit = commitArg.toLowerCase()
const version = previewVersion(tag)
const entries = readdirSync(bundle, { withFileTypes: true })
if (entries.some((entry) => !entry.isFile()))
  fail('Preview release bundle must contain regular files only')
const names = entries.map((entry) => entry.name)
if (names.some((name) => name.includes('UNSIGNED-INTERNAL')))
  fail('UNSIGNED-INTERNAL input cannot be published')
if (names.includes('release-manifest.json'))
  fail('Stable release input cannot be published as Preview')

const manifest = readJson(join(bundle, 'preview-release-manifest.json'))
const marker = readJson(join(bundle, 'UNSIGNED-PREVIEW.json'))
for (const [label, value] of [
  ['manifest', manifest],
  ['marker', marker],
]) {
  if (
    value.schemaVersion !== 1 ||
    value.marker !== 'UNSIGNED-PREVIEW' ||
    value.channel !== 'preview' ||
    value.signingStatus !== 'unsigned' ||
    value.notarized !== false ||
    value.tag !== tag ||
    value.commit !== commit ||
    value.runId !== runId
  ) {
    fail(`${label} must declare signingStatus unsigned Preview metadata`)
  }
}
if (manifest.version !== version) fail('Preview manifest version mismatch')

const expectedArtifacts = [
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-arm64.dmg`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-arm64.zip`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-x64.dmg`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-x64.zip`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-windows-x64.exe`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.AppImage`,
  `Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.deb`,
]
const manifestArtifacts = Array.isArray(manifest.artifacts)
  ? manifest.artifacts
  : []
if (
  JSON.stringify(manifestArtifacts.map((item) => item?.name).sort()) !==
  JSON.stringify([...expectedArtifacts].sort())
) {
  fail('Preview manifest artifact inventory mismatch')
}
for (const record of manifestArtifacts) {
  assertRecord(record, join(bundle, record.name), 'manifest artifact')
}
verifyChecksumManifest(
  join(bundle, 'ARTIFACT-SHA256SUMS.txt'),
  expectedArtifacts,
  'artifact checksum',
)

const sbomName = `emperor-agent-${tag}.cdx.json`
const sbom = readJson(join(bundle, sbomName))
if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6')
  fail('Preview SBOM must be CycloneDX 1.6')

const noticeName = 'UNSIGNED-PREVIEW-NOTICE.md'
const notice = readFileSync(join(bundle, noticeName), 'utf8')
for (const text of [
  tag,
  'Unsigned Preview',
  '未签名预览版',
  'signingStatus: unsigned',
  'Open Anyway',
  'More info',
  'https://support.apple.com/en-us/102445',
  'https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app',
]) {
  if (!notice.includes(text))
    fail(`Preview risk disclosure is missing: ${text}`)
}
for (const pattern of [
  /spctl\s+--master-disable/i,
  /disable\s+(Gatekeeper|SmartScreen|Defender)/i,
  /Set-MpPreference/i,
]) {
  if (pattern.test(notice))
    fail('Preview risk disclosure contains a system-wide security bypass')
}

const expectedBundleNames = new Set([
  ...expectedArtifacts,
  'ARTIFACT-SHA256SUMS.txt',
  'UNSIGNED-PREVIEW.json',
  noticeName,
  'preview-release-manifest.json',
  sbomName,
  'SHA256SUMS.txt',
])
const unexpected = names.filter((name) => !expectedBundleNames.has(name))
const missing = [...expectedBundleNames].filter((name) => !names.includes(name))
if (unexpected.length > 0 || missing.length > 0) {
  fail(
    `Preview bundle inventory mismatch; unexpected=${unexpected.sort().join(',')} missing=${missing.sort().join(',')}`,
  )
}
verifyChecksumManifest(
  join(bundle, 'SHA256SUMS.txt'),
  names.filter((name) => name !== 'SHA256SUMS.txt'),
  'full-bundle checksum',
)

console.log('UNSIGNED-PREVIEW publication preflight passed')

function verifyChecksumManifest(path, expectedNames, label) {
  const actual = new Map()
  for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (!match || actual.has(match[2])) fail(`invalid ${label} manifest`)
    actual.set(match[2], match[1].toLowerCase())
  }
  if (actual.size !== expectedNames.length) fail(`${label} coverage mismatch`)
  for (const name of expectedNames) {
    const path = join(bundle, name)
    if (actual.get(name) !== sha256(path)) fail(`${label} mismatch: ${name}`)
  }
}

function assertRecord(record, path, label) {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    record?.sha256 !== sha256(path) ||
    record?.size !== stat.size
  )
    fail(`${label} record mismatch: ${basename(path)}`)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`missing or invalid JSON: ${basename(path)}`)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fail(message) {
  throw new Error(message)
}
