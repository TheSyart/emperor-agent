/**
 * KRN-09: workflow scripts run in a contained Node child process, not an
 * eval'd worker thread. These probes run raw code in the same launcher the
 * engine uses, so they test the OS containment itself (defence in depth
 * behind the script realm): no writes outside its temp folder, no network,
 * a memory ceiling, and a terminate that leaves no process behind.
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContainmentBackend } from '../../sandbox/policy'
import {
  spawnWorkflowProcess,
  type WorkflowWorkerHandle,
} from './process-worker'

const roots: string[] = []
const handles: WorkflowWorkerHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.terminate()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-krn09-'))
  roots.push(root)
  return root
}

/** A process source that runs `body` once its init arrives and reports. */
function probe(body: string): string {
  return [
    '"use strict";',
    "process.once('message', async (init) => {",
    '  let report',
    `  try { report = await (async () => { ${body} })(init) } catch (error) { report = { thrown: String(error && error.code || error) } }`,
    "  process.send({ type: 'report', report })",
    '});',
  ].join('\n')
}

function start(
  source: string,
  init: unknown = {},
  options: { maxOldSpaceMb?: number } = {},
) {
  const handle = spawnWorkflowProcess({
    source,
    init,
    containment: new ContainmentBackend(),
    tempRoot: tempRoot(),
    ...options,
  })
  handles.push(handle)
  return handle
}

function nextReport(handle: WorkflowWorkerHandle): Promise<any> {
  return new Promise((resolve, reject) => {
    handle.on('message', (message: any) => {
      if (message?.type === 'report') resolve(message.report)
    })
    handle.on('exit', (code) => reject(new Error(`exited ${code}`)))
  })
}

function exitCode(handle: WorkflowWorkerHandle): Promise<number> {
  return new Promise((resolve) => handle.on('exit', resolve))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.runIf(process.platform === 'darwin')(
  'workflow process containment (KRN-09)',
  () => {
    it('2 · cannot write outside its own temp folder', async () => {
      const outside = join(tempRoot(), 'escaped.txt')
      const handle = start(
        probe(
          "const fs = require('node:fs'); fs.writeFileSync(init.path, 'x'); return { wrote: true }",
        ),
        { path: outside },
      )
      const report = await nextReport(handle)
      expect(report.thrown).toMatch(/EPERM|EACCES/)
      expect(existsSync(outside)).toBe(false)
    })

    it('may write inside its own temp folder', async () => {
      const handle = start(
        probe(
          "const fs = require('node:fs'); const p = require('node:path').join(require('node:os').tmpdir(), 'ok.txt'); fs.writeFileSync(p, 'x'); return { wrote: fs.readFileSync(p, 'utf8') }",
        ),
      )
      expect((await nextReport(handle)).wrote).toBe('x')
    })

    it('3 · cannot reach the network', async () => {
      let requests = 0
      const server = createServer((_req, res) => {
        requests++
        res.end('reached')
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      const port = (server.address() as { port: number }).port
      try {
        const handle = start(
          probe(
            "const r = await fetch('http://127.0.0.1:' + init.port + '/'); return { body: await r.text() }",
          ),
          { port },
        )
        const report = await nextReport(handle)
        expect(report.body).toBeUndefined()
        expect(requests).toBe(0)
      } finally {
        server.close()
      }
    })

    it('5 · is stopped when it allocates past its memory ceiling', async () => {
      const handle = start(
        probe(
          'const hold = []; for (;;) hold.push(new Array(1 << 20).fill(1.5))',
        ),
        {},
        { maxOldSpaceMb: 64 },
      )
      expect(await exitCode(handle)).not.toBe(0)
    })

    it('7 · terminate leaves no process behind', async () => {
      // A timer keeps it alive, as the run's message listener does.
      const handle = start(
        probe('setInterval(() => {}, 1000); await new Promise(() => {})'),
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      const pid = handle.pid!
      expect(alive(pid)).toBe(true)
      await handle.terminate()
      expect(alive(pid)).toBe(false)
    })

    it('carries structured messages both ways over its channel', async () => {
      const handle = start(
        [
          '"use strict";',
          "process.once('message', () => {",
          "  process.on('message', (m) => process.send({ type: 'report', report: { echoed: m } }));",
          "  process.send({ type: 'ready' });",
          '});',
        ].join('\n'),
      )
      await new Promise<void>((resolve) =>
        handle.on('message', (m: any) => m?.type === 'ready' && resolve()),
      )
      const report = nextReport(handle)
      handle.postMessage({ big: 1n, when: new Date(0), list: [1, 2] })
      expect((await report).echoed).toEqual({
        big: 1n,
        when: new Date(0),
        list: [1, 2],
      })
    })
  },
)

const electronBinary = join(
  __dirname,
  '../../../../../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
)

describe.runIf(process.platform === 'darwin' && existsSync(electronBinary))(
  'workflow process on the app runtime (KRN-09)',
  () => {
    it('runs on the Electron binary as Node inside the sandbox', async () => {
      const handle = spawnWorkflowProcess({
        source: probe(
          'return { electron: process.versions.electron ?? null, node: process.versions.node }',
        ),
        init: {},
        containment: new ContainmentBackend(),
        tempRoot: tempRoot(),
        execPath: electronBinary,
      })
      handles.push(handle)
      const report = await nextReport(handle)
      expect(report.electron).toEqual(expect.any(String))
      expect(report.node).toEqual(expect.any(String))
    }, 30_000)
  },
)
