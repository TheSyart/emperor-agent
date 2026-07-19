import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalAuditStore } from './audit'

describe('ExternalAuditStore', () => {
  it('persists exact redacted records and bounds archive count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-external-audit-'))
    const store = new ExternalAuditStore(root, {
      maxHotBytes: 350,
      maxArchives: 2,
      clock: () => 1_700_000_000,
    })

    for (let index = 0; index < 12; index += 1)
      await store.append({
        adapter: 'signed-webhook',
        direction: 'ingress',
        outcome: index % 2 ? 'rejected' : 'accepted',
        reasonCode: index % 2 ? 'invalid_signature' : 'accepted',
        messageIdDigest: `${index}`.padStart(64, '0'),
        keyIdDigest: 'a'.repeat(64),
        remoteDigest: 'b'.repeat(64),
        statusCode: index % 2 ? 401 : 202,
        durationMs: index,
      })

    const diagnostics = await store.diagnostics()
    expect(diagnostics).toMatchObject({
      exists: true,
      maxHotBytes: 350,
      maxArchives: 2,
    })
    expect(diagnostics.archives).toHaveLength(2)
    const replay = await store.replay({ limit: 20 })
    expect(replay.records.length).toBeGreaterThan(0)
    expect(replay.records.at(-1)).toMatchObject({
      adapter: 'signed-webhook',
      reasonCode: 'invalid_signature',
    })
    expect(replay.badLines).toEqual([])

    const dir = join(root, 'external')
    const allAudit = readdirSync(dir)
      .filter((name) => name.includes('audit'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
    expect(allAudit).not.toContain('secret')
    expect(allAudit).not.toContain('message body')
    expect(existsSync(store.auditPath)).toBe(true)
  })
})
