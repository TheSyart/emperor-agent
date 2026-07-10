import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '..')
const prettierEntry = require.resolve('prettier')
const prettierBin = resolve(dirname(prettierEntry), 'bin/prettier.cjs')

const mode = process.argv[2]
if (mode !== '--check' && mode !== '--write') {
  console.error('Usage: node scripts/run-prettier.mjs --check|--write')
  process.exit(1)
}

const trackedOutput = execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
const trackedFiles = trackedOutput
  .split('\0')
  .filter(Boolean)
  .filter((file) => existsSync(resolve(repoRoot, file)))

if (trackedFiles.length === 0) process.exit(0)

const chunkSize = 200
for (let index = 0; index < trackedFiles.length; index += chunkSize) {
  const chunk = trackedFiles.slice(index, index + chunkSize)
  const result = spawnSync(
    process.execPath,
    [prettierBin, mode, '--ignore-unknown', ...chunk],
    { cwd: repoRoot, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
