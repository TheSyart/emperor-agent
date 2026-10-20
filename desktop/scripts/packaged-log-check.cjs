// REL-01 test 1: after the packaged smoke, the app's main.log exists and
// holds its startup record. The smoke sets EMPEROR_CONFIG_DIR, so the log
// is in `<stateRoot>/logs/main.log`, never in ~/Library/Logs.
const { existsSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const STARTUP = /\[info\] Emperor Agent \S+ starting/

function checkStartupLog(stateRoot) {
  const path = join(stateRoot, 'logs', 'main.log')
  if (!existsSync(path))
    throw new Error(`packaged main.log is missing: ${path}`)
  const startLine = readFileSync(path, 'utf8')
    .split('\n')
    .find((line) => STARTUP.test(line))
  if (!startLine)
    throw new Error(`packaged main.log has no startup record: ${path}`)
  return { path, bytes: statSync(path).size, startLine }
}

module.exports = { checkStartupLog }
