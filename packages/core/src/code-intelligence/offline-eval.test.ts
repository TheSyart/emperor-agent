import { describe, expect, it } from 'vitest'
import { runCodeIntelligenceBenchmark } from './benchmark'
import {
  assertCodeIntelligenceGatePassed,
  decideCodeIntelligenceGate,
} from './eval'

const benchmarkRoot = String(
  process.env.EMPEROR_CODE_BENCHMARK_ROOT ?? '',
).trim()
const benchmarkMaxFiles = Number(
  process.env.EMPEROR_CODE_BENCHMARK_MAX_FILES ?? 200,
)

describe.skipIf(!benchmarkRoot)(
  'code intelligence real-repo evaluation',
  () => {
    it('prints a source-redacted, machine-verifiable report', async () => {
      const report = await runCodeIntelligenceBenchmark({
        sourceRoot: benchmarkRoot,
        maxFiles: benchmarkMaxFiles,
      })
      const decision = decideCodeIntelligenceGate(report)
      process.stdout.write(
        `CODE_INTELLIGENCE_EVALUATION=${JSON.stringify({ report, decision })}\n`,
      )
      assertCodeIntelligenceGatePassed(decision)
      expect(report.indexedFiles).toBeGreaterThanOrEqual(100)
      expect(report.datasetSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(report)).not.toContain(benchmarkRoot)
    }, 120_000)
  },
)
