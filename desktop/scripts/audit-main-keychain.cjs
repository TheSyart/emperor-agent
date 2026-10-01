#!/usr/bin/env node

// After every build: the main-process bundle must not reach for Electron's
// safeStorage, which on macOS means the Keychain and its "Safe Storage"
// prompt. Emperor seals secrets with its own key instead (plan rev 5 §3;
// src/main/local-secret-store.ts). The sources are held to the same rule by
// src/main/keychain-free.test.ts.

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

// A word of its own: Chrome-import helpers such as safeStorageService or
// readSafeStoragePassword name Chrome's key, not Electron's API.
const SAFE_STORAGE = /\bsafeStorage\b/

/** 1-based line numbers that name Electron's safeStorage. */
function findSafeStorage(source) {
  return String(source)
    .split('\n')
    .flatMap((line, index) => (SAFE_STORAGE.test(line) ? [index + 1] : []))
}

function bundleFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return bundleFiles(path)
    return /\.(?:c|m)?js$/.test(entry.name) ? [path] : []
  })
}

function auditMainBundle(root) {
  if (!existsSync(join(root, 'index.js')))
    throw new Error(`no built main bundle at ${root}`)
  const files = bundleFiles(root)
  const hits = files.flatMap((path) =>
    findSafeStorage(readFileSync(path, 'utf8')).map(
      (line) => `${path}:${line}`,
    ),
  )
  if (hits.length > 0)
    throw new Error(
      `the main bundle reaches for Electron safeStorage (the macOS Keychain):\n${hits.join('\n')}`,
    )
  return files.length
}

if (require.main === module) {
  const root = resolve(process.argv[2] || 'out/main')
  const checked = auditMainBundle(root)
  console.log(`main bundle Keychain audit passed: ${checked} files in ${root}`)
}

module.exports = { auditMainBundle, findSafeStorage }
