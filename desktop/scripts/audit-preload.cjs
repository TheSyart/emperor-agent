#!/usr/bin/env node

const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const MAX_PRELOAD_BYTES = 64 * 1024

function validatePreloadSource(value) {
  validateSandboxedPreloadSource(value, 'emperor')
}

function validatePetPreloadSource(value) {
  validateSandboxedPreloadSource(value, 'emperorPet')
}

function validateRecoveryPreloadSource(value) {
  validateSandboxedPreloadSource(value, 'emperorRecovery')
}

function validateSandboxedPreloadSource(value, bridgeName) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
  if (!bytes.length || bytes.length > MAX_PRELOAD_BYTES)
    throw new Error('sandbox preload bundle size is invalid')
  const source = bytes.toString('utf8')
  if (
    /(^|\n)\s*(?:import|export)\s/m.test(source) ||
    /\bimport\s*\(/.test(source)
  )
    throw new Error('sandbox preload bundle must be CommonJS')
  const required = [
    ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1])
  if (!required.length || required.some((name) => name !== 'electron'))
    throw new Error('sandbox preload bundle contains a forbidden module')
  const bridgePattern = new RegExp(
    `contextBridge\\.exposeInMainWorld\\(['"]${bridgeName}['"]`,
  )
  if (!bridgePattern.test(source))
    throw new Error(
      `sandbox preload bundle is missing the ${bridgeName} bridge`,
    )
}

function auditPreloadPath(path) {
  validatePreloadSource(readFileSync(path))
}

function auditRecoveryPreloadPath(path) {
  validateRecoveryPreloadSource(readFileSync(path))
}

if (require.main === module) {
  const mainPath = resolve(process.argv[2] || 'out/preload/index.cjs')
  const recoveryPath = resolve(process.argv[3] || 'out/preload/recovery.cjs')
  auditPreloadPath(mainPath)
  auditRecoveryPreloadPath(recoveryPath)
  console.log(`sandbox preload audit passed: ${mainPath}`)
  console.log(`sandbox recovery preload audit passed: ${recoveryPath}`)
}

module.exports = {
  MAX_PRELOAD_BYTES,
  auditPreloadPath,
  auditRecoveryPreloadPath,
  validatePetPreloadSource,
  validatePreloadSource,
  validateRecoveryPreloadSource,
}
