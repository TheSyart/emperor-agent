/**
 * The GitHub release list, read for the update check (REL-02).
 *
 * A release counts when it is published (not a draft), its tag is one of
 * Emperor's two forms (`vX.Y.Z`, `vX.Y.Z-preview.N`; a Stable tag marked
 * pre-release does not count), and its assets link to this repository's
 * own release downloads (or the test feed's origin). REL-05 names the DMG
 * `Emperor-Agent-<version>-macos-<arch>.dmg` (Preview:
 * `…-<version>-UNSIGNED-PREVIEW-macos-<arch>.dmg`) and lists every file in
 * `SHA256SUMS.txt`; a release missing either for this Mac is skipped.
 *
 * The Stable release notes end with `<!-- emperor-release electron=X.Y.Z -->`
 * (the Electron that release bundles): the newest one in the list is what
 * the diagnostics page compares the running Electron against, so the
 * reminder needs no request of its own.
 */
import { UPDATE_REPOSITORY, type UpdateUrlPolicy } from './http'
import {
  compareVersions,
  parseAppVersion,
  releaseChannelOf,
  versionChannel,
  type AppVersion,
  type UpdateChannel,
} from './version'
import type { UpdateRelease } from './types'

export interface FeedAsset {
  name: string
  size: number
  url: string
}

export interface FeedRelease {
  tag: string
  version: AppVersion
  channel: UpdateChannel
  name: string
  publishedAt: string | null
  assets: FeedAsset[]
  /** The Electron the release bundles (its notes' marker), if recorded. */
  electron: string | null
}

/** An update, with the two download links the service needs. */
export interface SelectedUpdate extends UpdateRelease {
  assetUrl: string
  checksumsUrl: string
}

const MAX_RELEASES = 100
const MAX_ASSETS = 100
const ELECTRON_MARKER =
  /<!--\s*emperor-release\b[^>]*?\belectron=(\d{1,4}\.\d{1,4}\.\d{1,4})\b[^>]*-->/
export const CHECKSUMS_FILE = 'SHA256SUMS.txt'

export function parseReleases(
  input: unknown,
  options: { policy: UpdateUrlPolicy },
): FeedRelease[] {
  if (!Array.isArray(input)) return []
  const releases: FeedRelease[] = []
  for (const raw of input.slice(0, MAX_RELEASES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.draft === true) continue
    const tag = releaseChannelOf(item.tag_name)
    if (!tag) continue
    if (tag.channel === 'stable' && item.prerelease === true) continue
    const tagName = item.tag_name as string
    const assets: FeedAsset[] = []
    for (const entry of Array.isArray(item.assets)
      ? item.assets.slice(0, MAX_ASSETS)
      : []) {
      const asset = feedAsset(entry, tagName, options.policy)
      if (asset) assets.push(asset)
    }
    const body = typeof item.body === 'string' ? item.body : ''
    releases.push({
      tag: tagName,
      version: tag.version,
      channel: tag.channel,
      name:
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim().slice(0, 200)
          : tagName,
      publishedAt:
        typeof item.published_at === 'string' ? item.published_at : null,
      assets,
      electron: ELECTRON_MARKER.exec(body)?.[1] ?? null,
    })
  }
  return releases
}

function feedAsset(
  entry: unknown,
  tag: string,
  policy: UpdateUrlPolicy,
): FeedAsset | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name : ''
  const size = Number(raw.size)
  const link =
    typeof raw.browser_download_url === 'string' ? raw.browser_download_url : ''
  if (!name || !/^[\w.() -]{1,200}$/.test(name)) return null
  if (!Number.isSafeInteger(size) || size <= 0) return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (!policy.allows(url)) return null
  const testFeed = policy.testFeed
  const fromTestFeed = testFeed !== null && url.origin === testFeed.origin
  if (
    !fromTestFeed &&
    url.href !==
      `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  )
    return null
  return { name, size, url: url.href }
}

function dmgName(
  version: string,
  channel: UpdateChannel,
  arch: string,
): string {
  return channel === 'preview'
    ? `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-${arch}.dmg`
    : `Emperor-Agent-${version}-macos-${arch}.dmg`
}

/**
 * The newest release above `currentVersion` on the build's channel (a
 * preview build: Preview and Stable; a Stable build: Stable) that has this
 * architecture's DMG and SHA256SUMS.txt; null when there is none.
 */
export function selectUpdate(
  releases: readonly FeedRelease[],
  currentVersion: string,
  arch: 'arm64' | 'x64',
): SelectedUpdate | null {
  const current = parseAppVersion(currentVersion)
  if (!current) return null
  const channel = versionChannel(current)
  const candidates = releases
    .filter(
      (release) =>
        (channel === 'preview' || release.channel === 'stable') &&
        compareVersions(release.version, current) > 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version))
  for (const release of candidates) {
    const name = dmgName(release.version.text, release.channel, arch)
    const dmg = release.assets.find((asset) => asset.name === name)
    const sums = release.assets.find((asset) => asset.name === CHECKSUMS_FILE)
    if (!dmg || !sums) continue
    return {
      version: release.version.text,
      tag: release.tag,
      channel: release.channel,
      name: release.name,
      publishedAt: release.publishedAt,
      notesUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag)}`,
      asset: { name: dmg.name, size: dmg.size },
      assetUrl: dmg.url,
      checksumsUrl: sums.url,
    }
  }
  return null
}

/** The newest Electron any listed release records, or null. */
export function electronReference(
  releases: readonly FeedRelease[],
): string | null {
  let best: AppVersion | null = null
  for (const release of releases) {
    const version = parseAppVersion(release.electron)
    if (version && (!best || compareVersions(version, best) > 0)) best = version
  }
  return best?.text ?? null
}

/**
 * `SHA256SUMS.txt`: `<sha256>  <file>` per line (`*` marks binary mode,
 * `./` may lead the name). A file listed twice with different digests has
 * no usable digest.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  const conflicts = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](?:\.\/)?(.+)$/.exec(line.trim())
    if (!match) continue
    const digest = match[1]!.toLowerCase()
    const name = match[2]!.trim()
    const known = sums.get(name)
    if (known !== undefined && known !== digest) conflicts.add(name)
    sums.set(name, digest)
  }
  for (const name of conflicts) sums.delete(name)
  return sums
}
