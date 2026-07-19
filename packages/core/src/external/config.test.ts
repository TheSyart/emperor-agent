import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effectiveConfigSnapshot } from '../config/resolver'
import {
  parseExternalConfig,
  loadExternalConfig,
  resolveSignedWebhookConfig,
} from './config'

describe('External signed webhook config', () => {
  it('defaults missing adapter config to a network-inert off capability', () => {
    expect(parseExternalConfig({ version: 1 }).signedWebhook).toMatchObject({
      mode: 'off',
      bindHost: '127.0.0.1',
      path: '/v1/external/events',
      requestsPerMinute: 60,
      burst: 10,
      maxBodyBytes: 262_144,
      timestampSkewSeconds: 300,
    })
  })

  it('accepts one exact trusted loopback/HTTPS configuration', () => {
    expect(
      parseExternalConfig({
        version: 1,
        signedWebhook: {
          mode: 'on',
          bindHost: '::1',
          port: 9876,
          path: '/hooks/emperor',
          sessionId: 'session_1',
          keyId: 'operator-key',
          secretEnv: 'EMPEROR_EXTERNAL_WEBHOOK_SECRET',
          outboundUrl: 'https://connector.example/emperor/replies',
          requestsPerMinute: 120,
          burst: 20,
          maxBodyBytes: 131_072,
          timestampSkewSeconds: 120,
          outboundTimeoutMs: 5_000,
        },
      }).signedWebhook,
    ).toEqual({
      mode: 'on',
      bindHost: '::1',
      port: 9876,
      path: '/hooks/emperor',
      sessionId: 'session_1',
      keyId: 'operator-key',
      secretEnv: 'EMPEROR_EXTERNAL_WEBHOOK_SECRET',
      outboundUrl: 'https://connector.example/emperor/replies',
      requestsPerMinute: 120,
      burst: 20,
      maxBodyBytes: 131_072,
      timestampSkewSeconds: 120,
      outboundTimeoutMs: 5_000,
    })
  })

  it.each([
    [{ version: 2 }, /version/i],
    [{ version: 1, surprise: true }, /unknown.*surprise/i],
    [
      {
        version: 1,
        signedWebhook: { mode: 'on', surprise: true },
      },
      /unknown.*surprise/i,
    ],
    [
      {
        version: 1,
        signedWebhook: { mode: 'on', bindHost: '0.0.0.0' },
      },
      /loopback/i,
    ],
    [
      {
        version: 1,
        signedWebhook: {
          mode: 'on',
          outboundUrl: 'http://connector.example/reply',
        },
      },
      /https/i,
    ],
    [
      {
        version: 1,
        signedWebhook: {
          mode: 'on',
          outboundUrl: 'https://user:pass@connector.example/reply',
        },
      },
      /userinfo/i,
    ],
    [
      {
        version: 1,
        signedWebhook: { mode: 'on', secretEnv: '${DYNAMIC}' },
      },
      /environment/i,
    ],
  ])('rejects unsafe or unknown config %#', (raw, error) => {
    expect(() => parseExternalConfig(raw)).toThrow(error)
  })

  it('keeps secrets and routing coordinates out of effective config', () => {
    const parsed = parseExternalConfig({
      version: 1,
      signedWebhook: {
        mode: 'on',
        port: 9876,
        sessionId: 'private-session',
        keyId: 'operator-key',
        secretEnv: 'PRIVATE_EXTERNAL_SECRET',
        outboundUrl: 'https://private.example/reply?tenant=secret',
      },
    })
    const resolution = resolveSignedWebhookConfig([
      {
        source: {
          kind: 'user',
          id: 'external_config.json',
          trust: 'trusted',
        },
        value: parsed.signedWebhook,
      },
    ])
    const serialized = JSON.stringify(effectiveConfigSnapshot([resolution]))

    expect(serialized).toContain('external.signedWebhook')
    expect(serialized).not.toContain('private-session')
    expect(serialized).not.toContain('PRIVATE_EXTERNAL_SECRET')
    expect(serialized).not.toContain('private.example')
    expect(serialized).toContain('[REDACTED]')
  })

  it('isolates invalid startup config but keeps diagnostics-only reads non-mutating', async () => {
    const startupRoot = mkdtempSync(join(tmpdir(), 'emperor-external-config-'))
    const startupPath = join(startupRoot, 'external_config.json')
    writeFileSync(startupPath, '{bad config', 'utf8')

    const startup = await loadExternalConfig(startupRoot)

    expect(startup.config.signedWebhook.mode).toBe('off')
    expect(startup.diagnostics).toMatchObject({
      exists: true,
      status: 'invalid',
      path: startupPath,
    })
    expect(startup.diagnostics.backupPath).toMatch(/\.corrupt-/)
    expect(existsSync(startupPath)).toBe(false)
    expect(readdirSync(startupRoot)).toContain(
      startup.diagnostics.backupPath!.split('/').at(-1),
    )

    const readRoot = mkdtempSync(join(tmpdir(), 'emperor-external-read-'))
    const readPath = join(readRoot, 'external_config.json')
    writeFileSync(readPath, '{bad config', 'utf8')
    const readOnly = await loadExternalConfig(readRoot, {
      preserveInvalid: false,
    })
    expect(readOnly.diagnostics).toMatchObject({
      status: 'invalid',
      backupPath: null,
    })
    expect(existsSync(readPath)).toBe(true)
    expect(readdirSync(readRoot)).toEqual(['external_config.json'])
  })
})
