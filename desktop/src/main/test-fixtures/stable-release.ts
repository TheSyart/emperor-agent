// REL-05: one macOS Stable candidate as scripts/verify-macos-release.sh
// leaves it in desktop/dist (and the release job downloads it): the DMG and
// ZIP, their SHA256SUMS, the packaged smoke receipt and the candidate receipt.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packagedSmokeFixture } from './packaged-smoke'

export const STABLE_VERSION = '0.2.0'
export const STABLE_TAG = `v${STABLE_VERSION}`

export type StableArch = 'arm64' | 'x64'

export function stableArtifactNames(
  arch: StableArch,
  version = STABLE_VERSION,
): [string, string] {
  return [
    `Emperor-Agent-${version}-macos-${arch}.dmg`,
    `Emperor-Agent-${version}-macos-${arch}.zip`,
  ]
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileRecord(path: string, name: string) {
  const body = readFileSync(path)
  return {
    name,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  }
}

export interface StableCandidateReceipt {
  schemaVersion: number
  channel: string
  signingStatus: string
  notarized: boolean
  version: string
  commit: string
  platform: string
  arch: string
  seal: {
    adHoc: boolean
    codesignStrict: boolean
    identifier: string
    sealedCode: number
    hardenedRuntime: boolean
    fusesVerified: boolean
  }
  dmgMounted: boolean
  zipExtracted: boolean
  packagedSmoke: string
  artifacts: Array<{ name: string; sha256: string; size: number }>
  [key: string]: unknown
}

export function candidatePaths(dist: string, arch: StableArch) {
  return {
    checksums: join(dist, `SHA256SUMS-macos-${arch}.txt`),
    smoke: join(dist, 'packaged-smoke', `darwin-${arch}.json`),
    receipt: join(dist, 'release-receipts', `macos-${arch}.json`),
  }
}

/** Writes one candidate the way the macOS release job produces it. */
export function writeStableCandidate(
  dist: string,
  arch: StableArch,
  commit: string,
  version = STABLE_VERSION,
): void {
  const names = stableArtifactNames(arch, version)
  const paths = candidatePaths(dist, arch)
  mkdirSync(join(dist, 'packaged-smoke'), { recursive: true })
  mkdirSync(join(dist, 'release-receipts'), { recursive: true })
  for (const name of names) writeFileSync(join(dist, name), `fixture:${name}\n`)
  writeFileSync(
    paths.checksums,
    `${names.map((name) => `${sha256File(join(dist, name))}  ${name}`).join('\n')}\n`,
  )
  writeFileSync(
    paths.smoke,
    `${JSON.stringify(packagedSmokeFixture('darwin', arch, version, commit), null, 2)}\n`,
  )
  const receipt: StableCandidateReceipt = {
    schemaVersion: 1,
    channel: 'stable',
    signingStatus: 'unsigned',
    notarized: false,
    version,
    commit,
    platform: 'macos',
    arch,
    seal: {
      adHoc: true,
      codesignStrict: true,
      identifier: 'com.emperor.agent.desktop',
      sealedCode: 20,
      hardenedRuntime: true,
      fusesVerified: true,
    },
    dmgMounted: true,
    zipExtracted: true,
    packagedSmoke: `darwin-${arch}.json`,
    artifacts: names.map((name) => fileRecord(join(dist, name), name)),
  }
  writeFileSync(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
}

export function readCandidateReceipt(
  dist: string,
  arch: StableArch,
): StableCandidateReceipt {
  return JSON.parse(
    readFileSync(candidatePaths(dist, arch).receipt, 'utf8'),
  ) as StableCandidateReceipt
}

export function writeCandidateReceipt(
  dist: string,
  arch: StableArch,
  receipt: StableCandidateReceipt,
): void {
  writeFileSync(
    candidatePaths(dist, arch).receipt,
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
}

/** A minimal CycloneDX 1.6 document, as generate-release-sbom.sh writes. */
export function writeSbomFixture(path: string): void {
  writeFileSync(
    path,
    `${JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: [] }, null, 2)}\n`,
  )
}
