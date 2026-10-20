import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** REL-03: the data version `migrations/<from>-<to>.ts` bring a home to. */
export const CURRENT_DATA_VERSION = 1

export function dataVersionOf(value: { dataVersion?: unknown } | null): number {
  const version = value?.dataVersion
  return typeof version === 'number' && Number.isInteger(version) && version > 0
    ? version
    : 0
}

/** The data version of an Emperor Home (0 before any migration ran). */
export function readInstalledDataVersion(emperorHome: string): number {
  try {
    return dataVersionOf(
      JSON.parse(readFileSync(join(emperorHome, 'installation.json'), 'utf8')),
    )
  } catch {
    return 0
  }
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** semver order of two releases; null when one is not a release (0.0.0-*, development). */
export function compareAppVersions(a: string, b: string): number | null {
  const [x, y] = [RELEASE.exec(a), RELEASE.exec(b)]
  if (!x || !y || /^0\.0\.0/.test(a) || /^0\.0\.0/.test(b)) return null
  for (const index of [1, 2, 3]) {
    const diff = Number(x[index]) - Number(y[index])
    if (diff) return Math.sign(diff)
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0
  const [p, q] = [x[4].split('.'), y[4].split('.')]
  for (let index = 0; index < Math.max(p.length, q.length); index += 1) {
    const [l, r] = [p[index], q[index]]
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1
    if (l === r) continue
    const [ln, rn] = [/^\d+$/.test(l), /^\d+$/.test(r)]
    if (ln && rn) return Math.sign(Number(l) - Number(r))
    return ln ? -1 : rn ? 1 : l < r ? -1 : 1
  }
  return 0
}
