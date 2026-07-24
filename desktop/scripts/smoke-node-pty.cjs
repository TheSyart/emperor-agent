#!/usr/bin/env node

const pty = require('node-pty')

const isWindows = process.platform === 'win32'
const executable = isWindows
  ? process.env.ComSpec || 'powershell.exe'
  : process.env.SHELL || '/bin/sh'
const args = isWindows && !process.env.ComSpec ? ['-NoLogo'] : []
const marker = 'EMPEROR_PTY_OK'
const command = isWindows
  ? `Write-Output ${marker}\r`
  : `printf '${marker}\\n'\r`

let processHandle
let output = ''
let settled = false
let timer

function finish(code, detail) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  try {
    processHandle?.kill()
  } catch {
    // The smoke result is already known.
  }
  if (detail) console.error(detail)
  process.exit(code)
}

try {
  processHandle = pty.spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
  })
  processHandle.onData((data) => {
    output += data
    if (output.includes(marker)) {
      console.log('node-pty native smoke passed')
      finish(0)
    }
  })
  processHandle.write(command)
} catch (error) {
  finish(1, error instanceof Error ? error.stack : String(error))
}

timer = setTimeout(() => {
  finish(2, `node-pty smoke timed out; output=${JSON.stringify(output)}`)
}, 5_000)
