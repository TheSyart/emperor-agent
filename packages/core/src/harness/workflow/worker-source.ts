/**
 * The workflow worker's entry, as eval'd CommonJS source.
 *
 * dsh spawns a separate `worker.cjs` bundle (or a tsx data-URL bootstrap in
 * source mode). Emperor runs the same TypeScript in two very different hosts —
 * vitest over TS sources and electron-vite's single `out/main` bundle inside
 * an asar — so a file-path entry would need per-host resolution. Instead the
 * worker-side code is written as SELF-CONTAINED factories (`createRealmKit`,
 * `createJsonSchemaKit`, `createExecutionKit`, `createSessionKit`) whose
 * compiled function text is concatenated here and run as the entry of the
 * contained script process (KRN-09, process-worker.ts). Whatever transpiler produced the
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

/**
 * The script process's entry: the first IPC message is the run's init; the
 * session talks over a port that forwards to `process.send` and buffers
 * host messages until it listens. The process ends with its channel.
 */
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
    "const vm = require('node:vm');",
    `const realm = (${factories.createRealmKit})();`,
    `const schema = (${factories.createJsonSchemaKit})();`,
    `const execution = (${factories.createExecutionKit})({ vm, realm, schema });`,
    `const session = (${factories.createSessionKit})({ execution, realm });`,
    "if (typeof process.send !== 'function') throw new Error('the workflow entry must run as a child process with an IPC channel');",
    'const pending = [];',
    'let deliver = null;',
    "const port = { postMessage: (message) => process.send(message), on: (event, listener) => { if (event !== 'message') return; deliver = listener; for (const message of pending.splice(0)) listener(message); } };",
    "process.on('disconnect', () => process.exit(0));",
    "const fatal = (error) => { const message = String((error && error.stack) || error); try { process.send({ type: '__fatal', message }, () => process.exit(1)); } catch { process.exit(1); } };",
    "process.on('uncaughtException', fatal);",
    "process.on('unhandledRejection', fatal);",
    "process.once('message', (init) => {",
    "  process.on('message', (message) => { if (deliver) deliver(message); else pending.push(message); });",
    '  void session.runWorkerSession(port, init);',
    '});',
  ].join('\n')
  return cached
}
