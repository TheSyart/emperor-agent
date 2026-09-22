/**
 * The workflow worker's entry, as eval'd CommonJS source.
 *
 * dsh spawns a separate `worker.cjs` bundle (or a tsx data-URL bootstrap in
 * source mode). Emperor runs the same TypeScript in two very different hosts —
 * vitest over TS sources and electron-vite's single `out/main` bundle inside
 * an asar — so a file-path entry would need per-host resolution. Instead the
 * worker-side code is written as SELF-CONTAINED factories (`createRealmKit`,
 * `createJsonSchemaKit`, `createExecutionKit`, `createSessionKit`) whose
 * compiled function text is concatenated here and started with
 * `new Worker(source, { eval: true })`. Whatever transpiler produced the
 * running host code also produced this text, so it is always plain JS for the
 * current runtime; the factories take every dependency as an argument, so the
 * text references nothing outside itself except `require` of Node builtins.
 */

import { createJsonSchemaKit } from '../tools/json-schema'
import { createRealmKit } from './realm'
import { createExecutionKit } from './runtime'
import { createSessionKit } from './session'

/** Transpiler helpers that would leak an outer-scope reference into serialized source. */
const FOREIGN_HELPERS =
  /\b__(?:name|publicField|privateGet|privateSet|privateAdd|decorateClass|async|spreadValues|objRest)\(/

let cached: string | undefined

/** The eval'd worker entry: boots `runWorkerSession` on `parentPort` with `workerData`. */
export function workflowWorkerSource(): string {
  if (cached !== undefined) return cached
  const factories = {
    createRealmKit: createRealmKit.toString(),
    createJsonSchemaKit: createJsonSchemaKit.toString(),
    createExecutionKit: createExecutionKit.toString(),
    createSessionKit: createSessionKit.toString(),
  }
  for (const [name, text] of Object.entries(factories)) {
    const helper = FOREIGN_HELPERS.exec(text)
    if (helper !== null)
      throw new Error(
        `workflow worker factory ${name} was transpiled with an outer helper (${helper[0]}); it cannot be serialized`,
      )
  }
  cached = [
    '"use strict";',
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const vm = require('node:vm');",
    `const realm = (${factories.createRealmKit})();`,
    `const schema = (${factories.createJsonSchemaKit})();`,
    `const execution = (${factories.createExecutionKit})({ vm, realm, schema });`,
    `const session = (${factories.createSessionKit})({ execution, realm });`,
    "if (parentPort === null) throw new Error('the workflow worker entry must be loaded inside a worker thread (no parentPort)');",
    'void session.runWorkerSession(parentPort, workerData);',
  ].join('\n')
  return cached
}
