// REL-02 on CoreApi: `updates.*` through the operation registry, the
// switch in settings.json, the events on the host wire and the
// diagnostics block. A local fake GitHub stands in for the real one.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, waitFor } from './test-helpers'

const VIEW = {}
const apis: CoreApi[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()))
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  )
})

async function feed(): Promise<string> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify([
        {
          tag_name: 'v0.2.1',
          name: 'Emperor Agent v0.2.1',
          draft: false,
          prerelease: false,
          body: '<!-- emperor-release electron=46.0.0 -->',
          assets: [],
        },
      ]),
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/repos/TheSyart/emperor-agent/releases`
}

describe('updates.* (REL-02)', () => {
  it('without a desktop host Core never checks and says so', async () => {
    const { api } = await makeApi()
    apis.push(api)
    const status = await invokeCoreOperation(api, 'updates.status', [], VIEW)
    expect(status).toMatchObject({
      supported: false,
      automatic: false,
      disabledReason: 'unsupported',
      enabled: true,
      available: null,
      download: { phase: 'idle' },
      feedOverride: null,
    })
    await expect(
      invokeCoreOperation(api, 'updates.check', [], VIEW),
    ).rejects.toMatchObject({ code: 'update_unsupported' })
  })

  it('the switch is settings.json `updates.check`, announced on the host wire', async () => {
    const downloads = tmp('emperor-updates-dl-')
    const { api, events, stateRoot } = await makeApi({
      extra: {
        appVersion: '0.2.0',
        updates: {
          electronVersion: '42.2.0',
          arch: 'arm64',
          downloadsDir: downloads,
          tempDir: tmp('emperor-updates-tmp-'),
          reveal: () => {},
          feedOverride: await feed(),
          automatic: true,
        },
      },
    })
    apis.push(api)
    await invokeCoreOperation(api, 'updates.setEnabled', [false], VIEW)
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'settings.json'), 'utf8'))
        .updates,
    ).toEqual({ check: false })
    expect(events.at(-1)).toMatchObject({
      event: 'update_status',
      seq: 0,
      status: { enabled: false },
    })
    await invokeCoreOperation(api, 'updates.setEnabled', [true], VIEW)
    const checked = await invokeCoreOperation(api, 'updates.check', [], VIEW)
    // No DMG for this Mac in the release: nothing to offer, but the check
    // worked and the Electron reference came with it.
    expect(checked).toMatchObject({ available: null, lastError: null })
    await waitFor(() => events.some((e) => e.event === 'update_status'))
    const diagnostics = await api.diagnostics.get({ sessionId: null })
    expect(diagnostics.updates).toMatchObject({
      enabled: true,
      feedOverride: expect.stringContaining('http://127.0.0.1:'),
      electron: { current: '42.2.0', latest: '46.0.0', outdated: true },
    })
    await expect(
      invokeCoreOperation(api, 'updates.setEnabled', ['yes' as never], VIEW),
    ).rejects.toThrow()
  })
})
