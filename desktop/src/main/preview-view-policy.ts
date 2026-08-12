import type { Rectangle } from 'electron'

export function normalizedPreviewBounds(value: unknown): Rectangle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(raw[key]))
  if (numbers.some((entry) => !Number.isFinite(entry))) return null
  const [x, y, width, height] = numbers as [number, number, number, number]
  if (width < 120 || height < 80 || width > 10_000 || height > 10_000)
    return null
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

export function previewNavigationAllowed(
  target: string,
  ownedUrl: string,
): boolean {
  try {
    const next = new URL(target)
    const owned = new URL(ownedUrl)
    return (
      ['http:', 'https:'].includes(next.protocol) &&
      next.origin === owned.origin &&
      isLoopback(next.hostname) &&
      !next.username &&
      !next.password
    )
  } catch {
    return false
  }
}

export function previewExternalNavigationEligible(target: string): boolean {
  try {
    const url = new URL(target)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !isLoopback(url.hostname) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}
