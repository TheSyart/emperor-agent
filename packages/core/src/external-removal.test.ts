import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coreOperationKeys } from './api/operations'

describe('External Bridge removal', () => {
  it('removes the executable module and public Core operation', () => {
    expect(existsSync(join(__dirname, 'external'))).toBe(false)
    expect(coreOperationKeys()).not.toContain('external.get')
  })

  it('removes named bridge contracts from production surfaces', () => {
    const productionFiles = [
      'api/core-api.ts',
      'api/operations.ts',
      'api/services/diagnostics-service.ts',
      'api/services/effective-config-service.ts',
      'index.ts',
      'runtime/events.ts',
      'runtime/types.ts',
    ]

    for (const relativePath of productionFiles) {
      const content = readFileSync(join(__dirname, relativePath), 'utf8')
      expect(content, relativePath).not.toMatch(
        /ExternalBridge|external\.get|external\.signedWebhook|external_(?:inbound|queued|outbound)/,
      )
    }
  })
})
