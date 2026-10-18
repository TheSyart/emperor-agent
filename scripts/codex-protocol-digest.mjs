#!/usr/bin/env node
// Records the Codex app-server protocol Emperor has verified (AGT-01).
//
//   node scripts/codex-protocol-digest.mjs                 # check the installed codex
//   node scripts/codex-protocol-digest.mjs --write         # add protocol/codex-<version>/
//   node scripts/codex-protocol-digest.mjs --schema <dir> --version 0.153.4
//
// It runs `codex app-server generate-json-schema` into a temporary directory
// (no model call, no login), digests the schema files Emperor's adapter
// depends on, and says whether that digest is already known. --write copies
// those files into packages/core/src/harness/delegation/protocol/
// codex-<version>/ with a digest.json; register the new folder in
// compatibility.ts (KNOWN_CODEX_PROTOCOLS) after the adapter's contract tests
// and a real run pass. The algorithm matches codexProtocolDigest().
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const protocolRoot = resolve(
  import.meta.dirname,
  '../packages/core/src/harness/delegation/protocol',
)

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}

function digest(root, files) {
  const hash = createHash('sha256').update('emperor-codex-protocol/1\n')
  for (const file of [...files].sort()) {
    const path = join(root, file)
    if (!existsSync(path)) return undefined
    hash.update(
      file +
        '\n' +
        canonicalJson(JSON.parse(readFileSync(path, 'utf8'))) +
        '\n',
    )
  }
  return hash.digest('hex')
}

function knownProtocols() {
  return readdirSync(protocolRoot)
    .filter((name) => name.startsWith('codex-'))
    .flatMap((name) => {
      const path = join(protocolRoot, name, 'digest.json')
      return existsSync(path)
        ? [{ name, ...JSON.parse(readFileSync(path, 'utf8')) }]
        : []
    })
}

/** The newest known file list; the original manifest before any digest existed. */
function contractFiles(known) {
  const newest = known.at(-1)
  if (newest) return newest.files
  const manifest = JSON.parse(
    readFileSync(join(protocolRoot, 'codex-0.153.4', 'manifest.json'), 'utf8'),
  )
  return Object.keys(manifest.sha256).sort()
}

const codex = argument('--codex') ?? 'codex'
let schema = argument('--schema')
let version = argument('--version')
let temporary
try {
  if (!version) {
    const output = execFileSync(codex, ['--version'], { encoding: 'utf8' })
    version = /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1]
    if (!version) throw new Error('codex --version did not print a version')
  }
  if (!schema) {
    temporary = mkdtempSync(join(tmpdir(), 'emperor-codex-schema-'))
    mkdirSync(join(temporary, 'home'))
    schema = join(temporary, 'out')
    execFileSync(
      codex,
      ['app-server', 'generate-json-schema', '--out', schema],
      {
        env: { ...process.env, CODEX_HOME: join(temporary, 'home') },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
  }
  const known = knownProtocols()
  const files = contractFiles(known)
  const value = digest(schema, files)
  if (!value) throw new Error('the schema lacks a file Emperor depends on')
  const matches = known.filter((p) => p.digests.includes(value))
  const record = {
    schemaVersion: 1,
    codexVersion: version,
    generatedBy: 'codex app-server generate-json-schema --out <dir>',
    algorithm:
      'sha256("emperor-codex-protocol/1\\n" + per sorted file: path, newline, key-sorted JSON, newline)',
    files,
    digests: [value],
  }
  if (!process.argv.includes('--write')) {
    console.log(JSON.stringify(record, null, 2))
    console.error(
      matches.length
        ? `known: same protocol as ${matches.map((p) => p.name).join(', ')}`
        : 'unknown: no recorded protocol has this digest',
    )
  } else {
    const target = join(protocolRoot, 'codex-' + version)
    for (const file of files) {
      mkdirSync(dirname(join(target, file)), { recursive: true })
      copyFileSync(join(schema, file), join(target, file))
    }
    writeFileSync(
      join(target, 'digest.json'),
      JSON.stringify(record, null, 2) + '\n',
    )
    console.error(
      `wrote ${target}; register it in compatibility.ts and run the contract tests`,
    )
  }
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}
