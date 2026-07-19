import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCodeIntelligenceBenchmark } from './benchmark'
import { decideCodeIntelligenceGate } from './eval'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('runCodeIntelligenceBenchmark', () => {
  it('measures a copied 100+ file source set without mutating the source or leaking its root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-benchmark-source-'))
    roots.push(root)
    const src = join(root, 'src')
    await mkdir(src, { recursive: true })
    for (let index = 0; index < 120; index += 1)
      await writeFile(
        join(src, `module-${String(index).padStart(3, '0')}.ts`),
        `export function sharedSymbol${index % 4}(value: number) { return value + ${index} }\nexport const call${index} = sharedSymbol${index % 4}(${index})\n`,
      )
    const before = await sourceDigest(src)

    const report = await runCodeIntelligenceBenchmark({
      sourceRoot: src,
      maxFiles: 120,
      incrementalRuns: 3,
      fullRebuildRuns: 2,
      indexedQueryRuns: 20,
      diskQueryRuns: 3,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      indexedFiles: 120,
      skippedOversized: 1,
      oversizedFileGateVerified: true,
      snapshotIsolationVerified: true,
      fallbackVerified: true,
    })
    expect(report.datasetSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.cacheBytes).toBeLessThan(report.sourceBytes)
    expect(report.incrementalP95Ms).toBeLessThan(report.fullRebuildP95Ms)
    expect(report.indexedQueryP95Ms).toBeLessThan(report.diskScanQueryP95Ms)
    expect(JSON.stringify(report)).not.toContain(root)
    expect(await sourceDigest(src)).toBe(before)
    expect(decideCodeIntelligenceGate(report).reasons).not.toContain(
      'report_invalid',
    )
  }, 30_000)
})

async function sourceDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (let index = 0; index < 120; index += 1) {
    const name = `module-${String(index).padStart(3, '0')}.ts`
    hash.update(name)
    hash.update(await readFile(join(root, name)))
  }
  return hash.digest('hex')
}
