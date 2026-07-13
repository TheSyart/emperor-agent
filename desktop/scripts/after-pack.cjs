const { existsSync, lstatSync, readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { extractFile, listPackage } = require('@electron/asar')
const { validateRuntimeManifest } = require('./before-pack.cjs')

const PET_RESOURCE_FILES = [
  'event-mapper.js',
  'idle-scenes.js',
  'preload.js',
  'renderer.css',
  'renderer.html',
  'renderer.js',
]

function validatePackagedAppResources(resourcesRoot) {
  const asarPath = join(resourcesRoot, 'app.asar')
  assertRegularFile(asarPath, 'app.asar')
  const entries = listPackage(asarPath).map((entry) =>
    entry.replace(/\\/g, '/'),
  )
  const required = [
    '/out/main/index.js',
    '/out/preload/index.mjs',
    '/out/renderer/index.html',
    '/package.json',
  ]
  for (const entry of required) {
    if (!entries.includes(entry))
      throw new Error(`packaged app is missing required ASAR entry: ${entry}`)
  }
  for (const entry of entries) {
    if (
      entry === '/node_modules' ||
      entry.startsWith('/node_modules/') ||
      /(?:^|\/)(?:fixtures|tests|skills-catalog|desktop-pet)(?:\/|$)/i.test(
        entry,
      ) ||
      /(?:\.py|requirements[^/]*\.txt)$/i.test(entry)
    )
      throw new Error(`packaged app contains forbidden ASAR entry: ${entry}`)
    if (
      entry !== '/package.json' &&
      entry !== '/out' &&
      !entry.startsWith('/out/')
    )
      throw new Error(`packaged app contains unexpected ASAR entry: ${entry}`)
  }

  const packageJson = JSON.parse(
    extractFile(asarPath, 'package.json').toString('utf8'),
  )
  if (packageJson?.main !== 'out/main/index.js')
    throw new Error('packaged app main entry is invalid')
  assertNoDevelopmentPaths(asarPath, entries)

  const petRoot = join(resourcesRoot, 'desktop-pet')
  if (!existsSync(petRoot) || !lstatSync(petRoot).isDirectory())
    throw new Error('packaged desktop-pet resources are missing')
  if (lstatSync(petRoot).isSymbolicLink())
    throw new Error('packaged desktop-pet resources must not be a symlink')
  const actualPetFiles = readdirSync(petRoot).sort()
  if (
    actualPetFiles.length !== PET_RESOURCE_FILES.length ||
    actualPetFiles.some((name, index) => name !== PET_RESOURCE_FILES[index])
  )
    throw new Error('packaged desktop-pet resources do not match allowlist')
  for (const name of actualPetFiles)
    assertRegularFile(join(petRoot, name), `desktop-pet/${name}`)

  for (const forbidden of ['backend', 'node_modules', 'skills-catalog']) {
    if (existsSync(join(resourcesRoot, forbidden)))
      throw new Error(`packaged resources contain forbidden path: ${forbidden}`)
  }
}

function assertNoDevelopmentPaths(asarPath, entries) {
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+\//,
    /\/home\/[A-Za-z0-9._-]+\//,
    /[A-Za-z]:\\Users\\[^\\]+\\/,
  ]
  for (const entry of entries) {
    if (
      !entry.startsWith('/out/') ||
      !/\.(?:css|html|js|json|mjs)$/.test(entry)
    )
      continue
    const content = extractFile(asarPath, entry.slice(1))
    if (content.byteLength > 8 * 1024 * 1024)
      throw new Error(
        `packaged ASAR text entry exceeds inspection limit: ${entry}`,
      )
    const text = content.toString('utf8')
    if (patterns.some((pattern) => pattern.test(text)))
      throw new Error(
        `packaged ASAR contains a development-machine path: ${entry}`,
      )
  }
}

function assertRegularFile(path, label) {
  if (!existsSync(path))
    throw new Error(`packaged resource is missing: ${label}`)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`packaged resource must be a regular file: ${label}`)
}

async function afterPack(context) {
  const appInfo = context.packager.appInfo
  const macResources = join(
    context.appOutDir,
    `${appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  )
  const resourcesRoot = existsSync(macResources)
    ? macResources
    : join(context.appOutDir, 'resources')
  validateRuntimeManifest(
    join(resourcesRoot, 'runtime-defaults'),
    appInfo.version,
  )
  validatePackagedAppResources(resourcesRoot)
}

module.exports = afterPack
module.exports.validatePackagedAppResources = validatePackagedAppResources
module.exports.PET_RESOURCE_FILES = PET_RESOURCE_FILES
