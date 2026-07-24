#!/usr/bin/env node

const { chmodSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const packageRoot = join(__dirname, '..', 'node_modules', 'node-pty')
const helpers = [
  join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
  join(packageRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
  join(packageRoot, 'build', 'Release', 'spawn-helper'),
]

for (const helper of helpers) {
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
