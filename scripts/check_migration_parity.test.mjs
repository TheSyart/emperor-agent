#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('migration parity check runs from a checkout without docs', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'emperor-parity-'))

  try {
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true })
    copyFileSync(join(root, 'scripts', 'check_migration_parity.mjs'), join(tempRoot, 'scripts', 'check_migration_parity.mjs'))
    copyFileSync(join(root, 'scripts', 'migration_parity_manifest.json'), join(tempRoot, 'scripts', 'migration_parity_manifest.json'))

    const manifest = JSON.parse(readFileSync(join(tempRoot, 'scripts', 'migration_parity_manifest.json'), 'utf8'))
    const mappedTests = new Set(manifest.mappings.flatMap((mapping) => mapping.parityTests))

    for (const path of mappedTests) {
      mkdirSync(dirname(join(tempRoot, path)), { recursive: true })
      writeFileSync(join(tempRoot, path), '')
    }

    assert.equal(existsSync(join(tempRoot, 'docs')), false)

    const output = execFileSync(process.execPath, ['scripts/check_migration_parity.mjs'], {
      cwd: tempRoot,
      encoding: 'utf8',
    })

    assert.match(output, /Migration parity manifest covers 84 frozen Python test files/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
