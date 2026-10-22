// REL-04 additions to the packaged smoke runner: the Native Messaging host
// handshake, a clean quit, nothing left running, and the 0.1.0-preview.4
// upgrade fixture (desktop/scripts/packaged-smoke-extras.cjs).
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const extras = require(
  path.resolve(__dirname, '..', '..', 'scripts', 'packaged-smoke-extras.cjs'),
) as {
  NM_EXTENSION_ORIGIN: string
  UPGRADE_FIXTURE: string
  encodeNativeMessage(value: unknown): Buffer
  decodeNativeMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer }
  nmHostHandshake(
    hostPath: string,
    options: { liveSocketPath: string; required?: boolean; timeoutMs?: number },
  ): Promise<Record<string, unknown>>
  checkCleanQuit(stateRoot: string): { quitLine: string }
  findLeftoverProcesses(psOutput: string, needles: string[]): string[]
  findLaunchServicesLeftovers(dump: string, needles: string[]): string[]
  waitForNoLaunchServicesLeftovers(
    needles: string[],
    options?: { timeoutMs?: number; read?: () => string[] },
  ): Promise<string[]>
  prepareUpgradeHome(fixtureRoot: string, stateRoot: string): UpgradeManifest
  checkUpgradeReceipt(receipt: unknown, manifest: UpgradeManifest): void
}

interface UpgradeManifest {
  appVersion: string
  expect: {
    sessions: Array<{
      id: string
      title: string
      userMessages: number
      assistantMessages: number
      lastAssistantText: string
    }>
    model: { modelId: string; displayName: string }
    /** A line of MEMORY.local.md that must survive the upgrade. */
    memoryLine: string
  }
}

const tempDir = (prefix: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix))

const walkFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walkFiles(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    )

/** A stand-in for emperor-nm-host: answers the way the real one does. */
function fakeHost(body: string): string {
  const dir = tempDir('emperor-fake-nm-host-')
  const file = path.join(dir, 'emperor-nm-host')
  fs.writeFileSync(
    file,
    `#!${process.execPath}\n` +
      `const origin = process.argv[2] || ''\n` +
      `const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]) }\n` +
      `const valid = /^chrome-extension:\\/\\/[a-p]{32}\\/?$/.test(origin)\n` +
      body,
    { mode: 0o755 },
  )
  return file
}

const REAL_HOST_BEHAVIOUR = `
if (!valid) { process.stderr.write('emperor-nm-host: EXTENSION_ORIGIN_REJECTED\\n'); process.exit(1) }
process.stdin.resume()
process.stdin.on('end', () => {})
process.stdout.write(frame({ type: 'response', id: 0, ok: false, error: { code: 'EMPEROR_NOT_RUNNING', message: 'EMPEROR_NOT_RUNNING', retryable: true } }))
process.stderr.write('emperor-nm-host: EMPEROR_NOT_RUNNING\\n')
process.exit(1)
`

describe('Native Messaging host handshake', () => {
  it('frames messages the way Chrome does (native-endian u32 length)', () => {
    const frame = extras.encodeNativeMessage({ type: 'hello', n: 1 })
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4)
    const decoded = extras.decodeNativeMessages(
      Buffer.concat([frame, frame, Buffer.from([1, 0])]),
    )
    expect(decoded.messages).toEqual([
      { type: 'hello', n: 1 },
      { type: 'hello', n: 1 },
    ])
    expect(decoded.rest).toEqual(Buffer.from([1, 0]))
  })

  it('accepts the fixed EMPEROR_NOT_RUNNING frame and a refused foreign origin', async () => {
    const receipt = await extras.nmHostHandshake(
      fakeHost(REAL_HOST_BEHAVIOUR),
      {
        liveSocketPath: path.join(tempDir('emperor-nm-'), 'absent.sock'),
      },
    )
    expect(receipt).toEqual({
      ok: true,
      extensionOrigin: extras.NM_EXTENSION_ORIGIN,
      answered: 'EMPEROR_NOT_RUNNING',
      foreignOriginRefused: true,
    })
  })

  it('fails when the host answers with anything else', async () => {
    const wrong = fakeHost(`
process.stdout.write(frame({ type: 'response', id: 0, ok: true }))
process.exit(0)
`)
    await expect(
      extras.nmHostHandshake(wrong, {
        liveSocketPath: path.join(tempDir('emperor-nm-'), 'absent.sock'),
      }),
    ).rejects.toThrow(/EMPEROR_NOT_RUNNING/)
  })

  it('fails when the host accepts a foreign origin', async () => {
    const lax = fakeHost(`
process.stdout.write(frame({ type: 'response', id: 0, ok: false, error: { code: 'EMPEROR_NOT_RUNNING' } }))
process.exit(1)
`)
    await expect(
      extras.nmHostHandshake(lax, {
        liveSocketPath: path.join(tempDir('emperor-nm-'), 'absent.sock'),
      }),
    ).rejects.toThrow(/foreign origin/)
  })

  it('never talks to a running Emperor: skips beside a live socket, fails when required', async () => {
    const dir = tempDir('emperor-nm-')
    const live = path.join(dir, 'nm.sock')
    fs.writeFileSync(live, '')
    const host = fakeHost(REAL_HOST_BEHAVIOUR)
    expect(
      await extras.nmHostHandshake(host, { liveSocketPath: live }),
    ).toEqual({
      ok: true,
      skipped: 'an Emperor owns the Native Messaging socket',
    })
    await expect(
      extras.nmHostHandshake(host, { liveSocketPath: live, required: true }),
    ).rejects.toThrow(/Native Messaging socket/)
  })
})

describe('clean quit', () => {
  const home = (log: string) => {
    const root = tempDir('emperor-quit-')
    fs.mkdirSync(path.join(root, 'logs'))
    fs.writeFileSync(path.join(root, 'logs', 'main.log'), log)
    return root
  }
  const start =
    '2026-10-21T08:00:00.000Z [info] Emperor Agent 0.2.0 starting {"packaged":true}\n'

  it('finds the quit record written after the last start', () => {
    expect(
      extras.checkCleanQuit(
        home(
          `${start}2026-10-21T08:00:05.000Z [info] Core ready; opening the main window\n2026-10-21T08:00:09.000Z [info] quit\n`,
        ),
      ),
    ).toEqual({ quitLine: '2026-10-21T08:00:09.000Z [info] quit' })
  })

  it.each([
    ['no quit record (app.exit, a crash)', start, /no quit record/],
    [
      'a quit from an earlier run only',
      `2026-10-21T07:00:00.000Z [info] quit\n${start}`,
      /no quit record/,
    ],
    [
      'a Core that did not close',
      `${start}2026-10-21T08:00:09.000Z [error] failed to close CoreApi: boom\n2026-10-21T08:00:09.100Z [info] quit\n`,
      /failed to close CoreApi/,
    ],
    [
      'a shutdown past its deadline',
      `${start}2026-10-21T08:00:19.000Z [error] failed to close CoreApi: shutdown did not finish within 10000ms\n2026-10-21T08:00:19.100Z [info] quit\n`,
      /did not finish/,
    ],
  ])('fails on %s', (_name, log, message) => {
    expect(() => extras.checkCleanQuit(home(log))).toThrow(message)
  })

  it('lists processes still running from the app or the smoke folder', () => {
    const ps = [
      '  101 /Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent',
      '  202 /x/dist/mac-arm64/Emperor Agent.app/Contents/Frameworks/Emperor Agent Helper (Renderer).app/Contents/MacOS/Emperor Agent Helper (Renderer) --type=renderer',
      '  303 /private/var/folders/t/emperor-packaged-smoke-1/state/native-helpers/abc/Emperor Computer Helper.app/Contents/MacOS/emperor-computer-helper',
      '  404 /bin/zsh',
    ].join('\n')
    expect(
      extras.findLeftoverProcesses(ps, [
        '/x/dist/mac-arm64/Emperor Agent.app/',
        '/private/var/folders/t/emperor-packaged-smoke-1',
      ]),
    ).toEqual([ps.split('\n')[1]!.trim(), ps.split('\n')[2]!.trim()])
  })
})

describe('LaunchServices leftovers', () => {
  it('waits for an asynchronous unregister to settle without hiding persistent registrations', async () => {
    vi.useFakeTimers()
    try {
      const helper = '/tmp/smoke/helper.app'
      const read = vi.fn().mockReturnValueOnce([helper]).mockReturnValue([])
      const settling = extras.waitForNoLaunchServicesLeftovers(
        ['/tmp/smoke/'],
        {
          timeoutMs: 500,
          read,
        },
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(await settling).toEqual([])
      expect(read.mock.calls.length).toBeGreaterThan(1)

      const persistent = extras.waitForNoLaunchServicesLeftovers(
        ['/tmp/smoke/'],
        {
          timeoutMs: 500,
          read: () => [helper],
        },
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(await persistent).toEqual([helper])
      await expect(
        extras.waitForNoLaunchServicesLeftovers(['/tmp/smoke/'], {
          read: () => {
            throw new Error('lsregister failed')
          },
        }),
      ).rejects.toThrow('lsregister failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('finds the helper copies a smoke run left registered', () => {
    const dump = [
      'path:                       /private/var/folders/t/emperor-packaged-smoke-1/state/native-helpers/abc/Emperor Computer Helper.app (0xdbac)',
      'path:                       /Applications/Emperor Agent.app (0x1234)',
      'path:                       /private/var/folders/t/emperor-packaged-smoke-1/up/native-helpers/abc/Emperor Computer Helper.app (0xdbb4)',
      'name:                       Emperor Computer Helper',
      'path:                       /private/var/folders/t/emperor-packaged-smoke-1/state/native-helpers/abc/Emperor Computer Helper.app (0xdbac)',
    ].join('\n')
    expect(
      extras.findLaunchServicesLeftovers(dump, [
        '/private/var/folders/t/emperor-packaged-smoke-1/',
      ]),
    ).toEqual([
      '/private/var/folders/t/emperor-packaged-smoke-1/state/native-helpers/abc/Emperor Computer Helper.app',
      '/private/var/folders/t/emperor-packaged-smoke-1/up/native-helpers/abc/Emperor Computer Helper.app',
    ])
  })
})

describe('0.1.0-preview.4 upgrade fixture (REL-04 test 7)', () => {
  it('copies the Emperor Home preview.4 wrote, with its own paths filled in', () => {
    const stateRoot = path.join(tempDir('emperor-upgrade-'), 'state')
    const manifest = extras.prepareUpgradeHome(
      extras.UPGRADE_FIXTURE,
      stateRoot,
    )
    expect(manifest.appVersion).toBe('0.1.0-preview.4')
    const installation = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'installation.json'), 'utf8'),
    )
    expect(installation).toMatchObject({
      appVersion: '0.1.0-preview.4',
      emperorHomeSource: 'default',
    })
    for (const session of manifest.expect.sessions) {
      const log = fs.readFileSync(
        path.join(stateRoot, 'sessions', session.id, 'log.jsonl'),
        'utf8',
      )
      expect(log).toContain(session.lastAssistantText)
      expect(log).not.toContain('__EMPEROR_HOME__')
      expect(log).toContain(`"cwd":"${stateRoot}/workspace"`)
    }
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(dir, entry.name))
            : [path.join(dir, entry.name)],
        )
    for (const file of walk(stateRoot))
      expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(
        /__EMPEROR_HOME__|__PREVIEW4_RUNTIME__/,
      )
    // The secret files keep the owner-only mode preview.4 gave them.
    expect(
      fs.statSync(path.join(stateRoot, 'model_config.json')).mode & 0o777,
    ).toBe(0o600)
  })

  // FIX-08: git keeps only 100644 / 100755, so a fresh checkout has every
  // fixture file at 0644 whatever preview.4 wrote; the modes come from
  // fixture.json, never from the checkout.
  it('gives each file the mode fixture.json records, not the checkout mode', () => {
    const checkout = path.join(tempDir('emperor-upgrade-checkout-'), 'fixture')
    fs.cpSync(extras.UPGRADE_FIXTURE, checkout, { recursive: true })
    const home = path.join(checkout, 'home')
    const files = walkFiles(home).map((file) => path.relative(home, file))
    for (const file of files) fs.chmodSync(path.join(home, file), 0o644)
    const modes = (
      JSON.parse(
        fs.readFileSync(path.join(checkout, 'fixture.json'), 'utf8'),
      ) as { modes?: Record<string, string> }
    ).modes
    // Every file of the fixture has its mode recorded.
    expect(Object.keys(modes ?? {}).sort()).toEqual([...files].sort())

    const stateRoot = path.join(tempDir('emperor-upgrade-'), 'state')
    extras.prepareUpgradeHome(checkout, stateRoot)
    for (const file of files)
      expect(
        (fs.statSync(path.join(stateRoot, file)).mode & 0o777).toString(8),
        file,
      ).toBe(modes![file])
    for (const secret of [
      'model_config.json',
      'settings.json',
      'installation.json',
      'sessions/index.json',
    ])
      expect(fs.statSync(path.join(stateRoot, secret)).mode & 0o777).toBe(0o600)
  })

  it('refuses a fixture file whose mode fixture.json does not record', () => {
    const checkout = path.join(tempDir('emperor-upgrade-checkout-'), 'fixture')
    fs.cpSync(extras.UPGRADE_FIXTURE, checkout, { recursive: true })
    fs.writeFileSync(path.join(checkout, 'home', 'unrecorded.json'), '{}')
    expect(() =>
      extras.prepareUpgradeHome(
        checkout,
        path.join(tempDir('emperor-upgrade-'), 'state'),
      ),
    ).toThrow(/unrecorded\.json/)
  })

  function goodReceipt(manifest: UpgradeManifest) {
    return {
      schemaVersion: 1,
      scenario: 'upgrade',
      exitCode: 0,
      sessions: manifest.expect.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        userMessages: session.userMessages,
        assistantMessages: session.assistantMessages,
        lastAssistantSha256: createHash('sha256')
          .update(session.lastAssistantText)
          .digest('hex'),
        rendered: true,
      })),
      model: { count: 1, active: { ...manifest.expect.model } },
      // Hashes, not text: the receipt carries no memory content.
      memory: {
        bytes: 100,
        lineSha256: [
          createHash('sha256').update(manifest.expect.memoryLine).digest('hex'),
        ],
      },
    }
  }

  it('accepts a receipt that read every session, the model and the memory', () => {
    const stateRoot = path.join(tempDir('emperor-upgrade-'), 'state')
    const manifest = extras.prepareUpgradeHome(
      extras.UPGRADE_FIXTURE,
      stateRoot,
    )
    expect(() =>
      extras.checkUpgradeReceipt(goodReceipt(manifest), manifest),
    ).not.toThrow()
  })

  it.each([
    [
      'a missing session',
      (r: ReturnType<typeof goodReceipt>) => r.sessions.pop(),
      /session .* was not read/,
    ],
    [
      'a lost reply',
      (r: ReturnType<typeof goodReceipt>) => {
        r.sessions[0]!.assistantMessages -= 1
      },
      /assistant messages/,
    ],
    [
      'a session the window did not show',
      (r: ReturnType<typeof goodReceipt>) => {
        r.sessions[0]!.rendered = false
      },
      /not shown/,
    ],
    [
      'another model',
      (r: ReturnType<typeof goodReceipt>) => {
        r.model.active.modelId = 'other'
      },
      /model/,
    ],
    [
      'lost memory',
      (r: ReturnType<typeof goodReceipt>) => {
        r.memory.lineSha256 = []
      },
      /memory/,
    ],
  ])('rejects %s', (_name, edit, message) => {
    const stateRoot = path.join(tempDir('emperor-upgrade-'), 'state')
    const manifest = extras.prepareUpgradeHome(
      extras.UPGRADE_FIXTURE,
      stateRoot,
    )
    const receipt = goodReceipt(manifest)
    edit(receipt)
    expect(() => extras.checkUpgradeReceipt(receipt, manifest)).toThrow(message)
  })
})
