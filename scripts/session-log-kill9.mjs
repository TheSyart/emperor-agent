#!/usr/bin/env node
// SEC-02's kill -9 acceptance, kept as a script the nightly runs (REL-04):
// a writer process streams turns through the real SessionLogStore (44
// events a turn, 5 ms write batches) and is SIGKILLed 150–500 ms after it
// started writing; a fresh store must then open the log with contiguous
// seqs and every turn closed (crash repair ends an interrupted one), and a
// second fresh store must read the same. The next run appends to the
// repaired log, so the log grows across runs.
//
//   node scripts/session-log-kill9.mjs [--runs 20] [--truncate-tail] [--json] [--keep]
//
// --truncate-tail also cuts 1 B–64 KiB off the end after each kill (the page
// cache lost in a power cut). Exit 0 when every run recovered.
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SESSION = 'kill9-session'

const WRITER = `
import { SessionLogStore } from './store.mjs'
const [root, id] = process.argv.slice(2)
const store = new SessionLogStore({ root, writeBatchMaxDelayMs: 5 })
const session = store.has(id) ? store.open(id) : store.create({ id })
let turn = session.events.filter((event) => event.type === 'turn/start').length
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
process.stdout.write('READY\\n')
for (;;) {
  turn++
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  for (let i = 0; i < 40; i++) {
    session.append('assistant/chunk', {
      turn,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'chunk ' + i + ' of turn ' + turn + ' ' },
    })
    if (i % 8 === 0) await tick()
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  await tick()
}
`

function parseArgs(argv) {
  const options = { runs: 20, truncate: false, json: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runs') options.runs = Number(argv[++i])
    else if (arg === '--truncate-tail') options.truncate = true
    else if (arg === '--json') options.json = true
    else if (arg === '--keep') options.keep = true
    else throw new Error(`unknown option ${arg}`)
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 1)
    throw new Error('--runs needs a positive integer')
  return options
}

/** Starts the writer, kills it 150–500 ms after it is ready. */
function writeThenKill(work, root) {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [join(work, 'writer.mjs'), root, SESSION],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    let killedAfterMs = null
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      if (killedAfterMs !== null || !String(chunk).includes('READY')) return
      killedAfterMs = randomInt(150, 501)
      setTimeout(() => child.kill('SIGKILL'), killedAfterMs)
    })
    const guard = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`writer never became ready: ${stderr.trim()}`))
    }, 30_000)
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      clearTimeout(guard)
      if (killedAfterMs === null)
        return fail(
          new Error(
            `writer exited before it was killed (${code ?? signal}): ${stderr.trim()}`,
          ),
        )
      done({ signal, killedAfterMs })
    })
  })
}

/** Turn numbers that started and never ended. */
function openTurns(events) {
  const open = new Set()
  for (const event of events) {
    if (event.type === 'turn/start') open.add(event.data.turn)
    if (event.type === 'turn/end') open.delete(event.data.turn)
  }
  return open.size
}

function contiguous(events) {
  return events.every((event, index) => event.seq === index)
}

async function main(argv) {
  const options = parseArgs(argv)
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-kill9-')))
  const root = join(work, 'sessions')
  await build({
    stdin: {
      contents:
        "export { SessionLogStore } from './packages/core/src/session-log/store'",
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(work, 'store.mjs'),
    logLevel: 'warning',
  })
  writeFileSync(join(work, 'writer.mjs'), WRITER)
  const { SessionLogStore } = await import(
    pathToFileURL(join(work, 'store.mjs')).href
  )
  const log = join(root, SESSION, 'log.jsonl')
  const results = []
  try {
    for (let run = 1; run <= options.runs; run++) {
      const killed = await writeThenKill(work, root)
      let truncatedBytes = 0
      if (options.truncate) {
        const size = statSync(log).size
        const header = readFileSync(log, 'utf8').indexOf('\n') + 1
        truncatedBytes = Math.min(randomInt(1, 65_537), size - header)
        if (truncatedBytes > 0) truncateSync(log, size - truncatedBytes)
      }
      const states = []
      let result
      try {
        const store = new SessionLogStore({
          root,
          onLogState: (state) => states.push(state),
        })
        const session = store.open(SESSION)
        const events = [...session.events]
        store.closeAll()
        // What the repair wrote must read back the same in a fresh store.
        const again = new SessionLogStore({ root }).readSnapshot(SESSION)
        const ok =
          contiguous(events) &&
          openTurns(events) === 0 &&
          again.events.length === events.length &&
          contiguous(again.events) &&
          openTurns(again.events) === 0
        result = {
          run,
          ok,
          signal: killed.signal,
          killedAfterMs: killed.killedAfterMs,
          events: events.length,
          openTurns: openTurns(events),
          repaired: states
            .filter((state) => state.state === 'repaired')
            .map((state) => state.kind),
          ...(options.truncate ? { truncatedBytes } : {}),
        }
      } catch (error) {
        result = {
          run,
          ok: false,
          signal: killed.signal,
          killedAfterMs: killed.killedAfterMs,
          error: error instanceof Error ? error.message : String(error),
          ...(options.truncate ? { truncatedBytes } : {}),
        }
      }
      results.push(result)
      if (!options.json)
        console.log(
          `${result.ok ? 'ok  ' : 'FAIL'} run ${run}: killed after ${result.killedAfterMs} ms, ${result.events ?? '?'} events${result.repaired?.length ? `, repaired ${result.repaired.join('+')}` : ''}${options.truncate ? `, cut ${truncatedBytes} B` : ''}${result.error ? ` — ${result.error}` : ''}`,
        )
    }
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true })
    else console.error(`kept ${work}`)
  }
  const recovered = results.filter((result) => result.ok).length
  const summary = {
    runs: options.runs,
    recovered,
    mode: options.truncate ? 'sigkill+truncate' : 'sigkill',
    events: results.at(-1)?.events ?? 0,
    results,
  }
  if (options.json) console.log(JSON.stringify(summary))
  else
    console.log(
      `${recovered}/${options.runs} reopened with contiguous seqs and every turn closed (${summary.mode}, ${summary.events} events)`,
    )
  return recovered === options.runs ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  },
)
