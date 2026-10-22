#!/usr/bin/env node
// Records the Codex app-server protocol Emperor has verified (AGT-01).
//
//   node scripts/codex-protocol-digest.mjs                 # check the installed codex
//   node scripts/codex-protocol-digest.mjs --codex <path>  # check another codex
//   node scripts/codex-protocol-digest.mjs --write         # add protocol/codex-<version>/
//   node scripts/codex-protocol-digest.mjs --schema <dir> --version 0.153.4
//   ... --file v2/Foo.json                                 # depend on one more file
//
// It runs `codex app-server generate-json-schema` into a temporary directory
// (private HOME and CODEX_HOME; no model call, no login), digests the schema
// files Emperor's adapter depends on — the newest recorded protocol's list,
// plus any --file — and says whether that digest is already known. --write
// copies those files into packages/core/src/harness/delegation/protocol/
// codex-<version>/ with a digest.json and, when it ran the binary, a
// features.json: `codex features list` with no overrides, the defaults the
// adapter's feature overrides are checked against (AGT-13). Format them with
// prettier, then
// register the new folder in compatibility.ts (KNOWN_CODEX_PROTOCOLS) after
// the adapter's contract tests, scripts/codex-protocol-handshake.mjs and a
// real run pass. The algorithm matches codexProtocolDigest().
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

function argumentsOf(name) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  )
}

function versionKey(text) {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(text) ?? [0, 0, 0, 0]).slice(1).map(Number)
}

function compareVersions(a, b) {
  const x = versionKey(a),
    y = versionKey(b)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
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

/** Recorded protocols, oldest first by version. */
function knownProtocols() {
  return readdirSync(protocolRoot)
    .filter((name) => name.startsWith('codex-'))
    .flatMap((name) => {
      const path = join(protocolRoot, name, 'digest.json')
      return existsSync(path)
        ? [{ name, ...JSON.parse(readFileSync(path, 'utf8')) }]
        : []
    })
    .sort((a, b) => compareVersions(a.codexVersion, b.codexVersion))
}

/**
 * The newest known file list (the original manifest before any digest
 * existed), plus the files named with --file.
 */
function contractFiles(known) {
  const newest = known.at(-1)
  const files = newest
    ? newest.files
    : Object.keys(
        JSON.parse(
          readFileSync(
            join(protocolRoot, 'codex-0.153.4', 'manifest.json'),
            'utf8',
          ),
        ).sha256,
      )
  return [...new Set([...files, ...argumentsOf('--file')])].sort()
}

const codex = argument('--codex') ?? 'codex'
let schema = argument('--schema')
let version = argument('--version')
/** `codex features list` (private HOME and CODEX_HOME): name → stage, default. */
function featureDefaults(home) {
  const output = execFileSync(codex, ['features', 'list'], {
    env: { ...process.env, HOME: home, CODEX_HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const features = {}
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const [name, stage, state, ...rest] = line.trim().split(/\s{2,}/)
    if (!name || !stage || !['true', 'false'].includes(state) || rest.length)
      throw new Error('unreadable `codex features list` line: ' + line)
    features[name] = { stage, enabled: state === 'true' }
  }
  return features
}

let temporary, features
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
        env: {
          ...process.env,
          HOME: join(temporary, 'home'),
          CODEX_HOME: join(temporary, 'home'),
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
    features = featureDefaults(join(temporary, 'home'))
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
    if (features)
      writeFileSync(
        join(target, 'features.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            codexVersion: version,
            generatedBy:
              'codex features list (private HOME and CODEX_HOME, no overrides)',
            features,
          },
          null,
          2,
        ) + '\n',
      )
    console.error(
      `wrote ${target}; register it in compatibility.ts and run the contract tests`,
    )
  }
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}
