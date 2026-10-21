/**
 * Versions and channels for the update check (REL-02). Emperor's tags are
 * `vX.Y.Z` (Stable) and `vX.Y.Z-preview.N` (Preview); the running app's
 * version is `app.getVersion()` without the `v`. A build whose version has
 * any prerelease part is a preview build: it is offered Preview and Stable
 * releases, a Stable build only Stable ones.
 */

import type { UpdateChannel } from './types'

export type { UpdateChannel } from './types'

export interface AppVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers (`['preview', '3']`), or none. */
  prerelease: string[]
  text: string
}

const VERSION =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseAppVersion(value: unknown): AppVersion | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const match = VERSION.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    text: value,
  }
}

export function versionChannel(version: AppVersion): UpdateChannel {
  return version.prerelease.length ? 'preview' : 'stable'
}

/** Semantic version order: a prerelease sorts below its own release. */
export function compareVersions(a: AppVersion, b: AppVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const)
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  if (!a.prerelease.length || !b.prerelease.length)
    return b.prerelease.length - a.prerelease.length === 0
      ? 0
      : a.prerelease.length
        ? -1
        : 1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumber = /^\d+$/.test(left)
    const rightNumber = /^\d+$/.test(right)
    if (leftNumber && rightNumber) return Number(left) < Number(right) ? -1 : 1
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-preview\.(?:0|[1-9]\d{0,5}))?)$/

/** A release tag Emperor publishes, with its version and channel. */
export function releaseChannelOf(
  tag: unknown,
): { version: AppVersion; channel: UpdateChannel } | null {
  if (typeof tag !== 'string') return null
  const match = RELEASE_TAG.exec(tag)
  const version = match ? parseAppVersion(match[1]) : null
  return version ? { version, channel: versionChannel(version) } : null
}
