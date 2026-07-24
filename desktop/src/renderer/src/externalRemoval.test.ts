import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('External Bridge renderer removal', () => {
  it('removes named bridge projections and diagnostics', () => {
    const rendererRoot = join(__dirname)
    const productionFiles = [
      'types.ts',
      'composables/useRuntime.ts',
      'components/panels/diagnosticsPanelModel.ts',
    ]

    for (const relativePath of productionFiles) {
      const content = readFileSync(join(rendererRoot, relativePath), 'utf8')
      expect(content, relativePath).not.toMatch(
        /ExternalDiagnosticsPayload|external-bridge|external_(?:inbound|queued|outbound)/,
      )
    }
  })
})
