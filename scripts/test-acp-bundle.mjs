import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const bundle = join(root, 'packages/core/dist/bin/emperor-agent-acp.mjs')
const runtimeRoot = root
const stateRoot = await mkdtemp(join(tmpdir(), 'emperor-acp-smoke-'))

const expectedIds = new Set([1, 2])
const messages = []
let stdoutBuffer = ''

const child = spawn(
  process.execPath,
  [bundle, '--runtime-root', runtimeRoot, '--state-root', stateRoot],
  {
    cwd: root,
    env: { ...process.env, EMPEROR_CONFIG_DIR: stateRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)

let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk
  for (;;) {
    const newline = stdoutBuffer.indexOf('\n')
    if (newline < 0) break
    const line = stdoutBuffer.slice(0, newline).trim()
    stdoutBuffer = stdoutBuffer.slice(newline + 1)
    if (line) messages.push(JSON.parse(line))
  }
})

const waitForResponses = () =>
  new Promise((resolvePromise, rejectPromise) => {
    const deadline = setTimeout(() => {
      rejectPromise(
        new Error(`Timed out waiting for ACP responses. stderr=${stderr}`),
      )
    }, 30_000)
    deadline.unref?.()

    const poll = setInterval(() => {
      const received = new Set(
        messages
          .filter((message) => 'id' in message)
          .map((message) => message.id),
      )
      if ([...expectedIds].every((id) => received.has(id))) {
        clearInterval(poll)
        clearTimeout(deadline)
        child.off('exit', onEarlyExit)
        resolvePromise()
      }
    }, 10)
    poll.unref?.()

    const onEarlyExit = (code, signal) => {
      clearInterval(poll)
      clearTimeout(deadline)
      rejectPromise(
        new Error(
          `ACP process exited before both responses: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      )
    }
    child.once('exit', onEarlyExit)
  })

const waitForExit = () =>
  new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else
        rejectPromise(
          new Error(
            `ACP process failed: code=${code} signal=${signal} stderr=${stderr}`,
          ),
        )
    })
  })

const exit = waitForExit()

try {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`,
  )
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: root, mcpServers: [] },
    })}\n`,
  )

  await waitForResponses()
  child.stdin.end()
  await exit

  const initialize = messages.find((message) => message.id === 1)
  const newSession = messages.find((message) => message.id === 2)
  if (initialize?.result?.protocolVersion !== 1) {
    throw new Error(
      `Unexpected initialize response: ${JSON.stringify(initialize)}`,
    )
  }
  if (typeof newSession?.result?.sessionId !== 'string') {
    throw new Error(
      `Unexpected session/new response: ${JSON.stringify(newSession)}`,
    )
  }
  if (stderr.trim()) {
    throw new Error(`ACP smoke test wrote to stderr: ${stderr}`)
  }

  process.stdout.write('ACP stdio bundle smoke test passed\n')
} finally {
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL')
  await rm(stateRoot, { recursive: true, force: true })
}
