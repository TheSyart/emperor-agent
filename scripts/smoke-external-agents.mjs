#!/usr/bin/env node
import { build } from 'esbuild'
import { writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  smokeOptions,
  seedScenario,
  runScenario,
} from './external-agent-scenario.mjs'
const options = smokeOptions(process.argv.slice(2)),
  seed = seedScenario(options)
const bundle = join(options.receipts, 'core-smoke.mjs')
if (!existsSync(join(options.receipts, 'node_modules')))
  symlinkSync(
    resolve('node_modules'),
    join(options.receipts, 'node_modules'),
    'dir',
  )
await build({
  stdin: {
    contents:
      'export {CoreApi} from "./packages/core/src/api/core-api";export{invokeCoreOperation}from"./packages/core/src/api/operations";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
})
const { CoreApi, invokeCoreOperation } = await import(
  pathToFileURL(bundle).href
)
const receipt = {
  startedAt: new Date().toISOString(),
  runtime: 'real Node/CoreApi',
  parentInference: true,
  model: seed.model,
  initialHead: seed.head,
  state: options.state,
  workspace: options.workspace,
  checks: [],
}
const api = await CoreApi.create({
  root: process.cwd(),
  stateRoot: options.state,
  enableFirstRunOnboarding: false,
  initializeMcp: false,
  eventSink: () => {},
})
const timer = setTimeout(() => void api.close(), 600000)
try {
  await runScenario(
    (op, ...args) => invokeCoreOperation(api, op, args),
    options,
    receipt,
  )
} catch (error) {
  receipt.ok = false
  receipt.error = String(error)
  process.exitCode = 1
  console.error(String(error))
} finally {
  clearTimeout(timer)
  await api.close()
  writeFileSync(
    join(options.receipts, 'scenario.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
}
