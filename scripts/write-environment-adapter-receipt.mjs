import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const [adapter, arch, output] = process.argv.slice(2)
if (!adapter || !arch || !output)
  throw new Error(
    'usage: node scripts/write-environment-adapter-receipt.mjs <adapter> <arch> <output>',
  )

const catalogPath = resolve('packages/core/src/environment/tool-catalog.json')
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const catalogRevision = createHash('sha256')
  .update(JSON.stringify(sortJson(catalog)))
  .digest('hex')
const receipt = {
  schemaVersion: 1,
  kind: 'environment_adapter_internal',
  adapter,
  platform: process.platform,
  arch,
  catalogRevision,
  commit: process.env.GITHUB_SHA ?? 'local',
  runner: process.env.RUNNER_NAME ?? 'local',
  node: process.version,
  generatedAt: new Date().toISOString(),
  status: 'passed',
  checks: [
    'environment/macos-adapter.test.ts',
    'environment/download.test.ts',
    'environment/process-runner.test.ts',
    'core:typecheck',
    'core:lint',
  ],
}
const destination = resolve(output)
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  )
}
