// KRN-04: a stdio server's last 200 stderr lines are readable from 能力 ›
// MCP (`mcp.serverLog`), redacted like the persistent logs (REL-01).
import { afterEach, describe, expect, it } from 'vitest'
import { invokeCoreOperation } from './operations'
import { makeApi, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function fixture(stderr: Record<string, string>): Promise<ApiFixture> {
  const made = await makeApi()
  fixtures.push(made)
  made.api.host.kept.mcpClient.serverStderr = (name: string) =>
    name in stderr ? stderr[name]! : null
  return made
}

describe('mcp.serverLog (KRN-04)', () => {
  it('returns the last stderr lines of a server', async () => {
    const { api } = await fixture({
      notes: 'starting notes server\nError: Cannot find module dep',
    })
    await expect(
      invokeCoreOperation(api, 'mcp.serverLog', [{ name: 'notes' }]),
    ).resolves.toEqual({
      name: 'notes',
      text: 'starting notes server\nError: Cannot find module dep',
    })
  })

  it('redacts keys and tokens the way the logs do', async () => {
    const { api } = await fixture({
      notes:
        'using sk-abcdef1234567890abcdef\nGET https://api.example.test/v1?token=s3cret&q=1\nAuthorization: Bearer abc.def',
    })
    const { text } = await invokeCoreOperation(api, 'mcp.serverLog', [
      { name: 'notes' },
    ])
    expect(text).toContain('sk-***')
    expect(text).toContain('token=***')
    expect(text).not.toContain('s3cret')
    expect(text).not.toContain('abcdef1234567890')
    expect(text).not.toContain('abc.def')
  })

  it('gives null text for a server that is not running', async () => {
    const { api } = await fixture({})
    await expect(
      invokeCoreOperation(api, 'mcp.serverLog', [{ name: 'gone' }]),
    ).resolves.toEqual({ name: 'gone', text: null })
  })

  it('rejects an invalid server name', async () => {
    const { api } = await fixture({})
    await expect(
      invokeCoreOperation(api, 'mcp.serverLog', [{ name: '' }]),
    ).rejects.toThrow()
  })
})
