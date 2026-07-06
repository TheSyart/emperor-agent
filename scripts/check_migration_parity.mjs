#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const manifestPath = join(root, 'scripts', 'migration_parity_manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const mappings = Array.isArray(manifest.mappings) ? manifest.mappings : []

const sourceTests = mappings
  .map((mapping) => mapping.pythonTest)
  .filter(Boolean)
  .sort()
const duplicateSourceTests = duplicates(sourceTests)

const discoveredPythonTests = walk(join(root, 'tests'))
  .filter((path) => /(^|\/)test_[^/]+\.py$/.test(rel(path)))
  .map(rel)
  .sort()

const missingDiscoveredPython = discoveredPythonTests.filter((path) => !sourceTests.includes(path))

const mappedTests = mappings
  .flatMap((mapping) => (Array.isArray(mapping.parityTests) ? mapping.parityTests : []))
  .filter(Boolean)
const missingMapped = [...new Set(mappedTests)]
  .filter((path) => !existsSync(join(root, path)))
  .sort()

if (!sourceTests.length || duplicateSourceTests.length || missingDiscoveredPython.length || missingMapped.length) {
  if (!sourceTests.length) {
    console.error('migration_parity_manifest.json does not contain a frozen Python test inventory.')
  }
  if (duplicateSourceTests.length) {
    console.error('migration_parity_manifest.json contains duplicate Python test mappings:')
    for (const path of duplicateSourceTests) console.error(`  - ${path}`)
  }
  if (missingDiscoveredPython.length) {
    console.error('migration_parity_manifest.json is missing discovered Python test mappings:')
    for (const path of missingDiscoveredPython) console.error(`  - ${path}`)
  }
  if (missingMapped.length) {
    console.error('migration_parity_manifest.json references missing TS/JS tests:')
    for (const path of missingMapped) console.error(`  - ${path}`)
  }
  process.exit(1)
}

console.log(
  `Migration parity manifest covers ${sourceTests.length} frozen Python test files and references ${new Set(mappedTests).size} TS/JS test files.`,
)

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (name === '__pycache__') continue
      out.push(...walk(path))
    } else {
      out.push(path)
    }
  }
  return out
}

function rel(path) {
  return path.slice(root.length + 1).replace(/\\/g, '/')
}

function duplicates(values) {
  const seen = new Set()
  const dupes = new Set()
  for (const value of values) {
    if (seen.has(value)) dupes.add(value)
    seen.add(value)
  }
  return [...dupes].sort()
}
