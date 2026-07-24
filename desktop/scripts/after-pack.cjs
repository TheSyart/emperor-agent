const {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} = require('node:fs')
const { join } = require('node:path')
const { extractFile, listPackage } = require('@electron/asar')
const { validateRuntimeManifest } = require('./before-pack.cjs')
const {
  validatePetPreloadSource,
  validatePreloadSource,
} = require('./audit-preload.cjs')

const PET_RESOURCE_FILES = [
  'event-mapper.js',
  'idle-scenes.js',
  'preload.js',
  'renderer.css',
  'renderer.html',
  'renderer.js',
]

const TYPESCRIPT_ASAR_ENTRIES = new Set([
  '/node_modules',
  '/node_modules/typescript',
  '/node_modules/typescript/lib',
  '/node_modules/typescript/lib/typescript.js',
  '/node_modules/typescript/package.json',
])

function isAllowedNodeModuleEntry(entry) {
  const nodePtyRoot = '/node_modules/node-pty'
  const nodePtyLib = `${nodePtyRoot}/lib`
  const nodePtyPrebuilds = `${nodePtyRoot}/prebuilds`
  const nodePtyBuild = `${nodePtyRoot}/build`
  return (
    TYPESCRIPT_ASAR_ENTRIES.has(entry) ||
    entry === nodePtyRoot ||
    entry === `${nodePtyRoot}/package.json` ||
    entry === nodePtyLib ||
    (entry.startsWith(`${nodePtyLib}/`) &&
      (/(?:^|\/)[^/.]+$/.test(entry) ||
        (entry.endsWith('.js') && !entry.endsWith('.test.js')))) ||
    entry === nodePtyPrebuilds ||
    entry.startsWith(`${nodePtyPrebuilds}/`) ||
    entry === nodePtyBuild ||
    entry === `${nodePtyBuild}/Release` ||
    entry.startsWith(`${nodePtyBuild}/Release/`)
  )
}

function validatePackagedAppResources(
  resourcesRoot,
  platform = process.platform,
  arch = process.arch,
) {
  const asarPath = join(resourcesRoot, 'app.asar')
  assertRegularFile(asarPath, 'app.asar')
  const archiveEntries = listPackage(asarPath)
  const entries = archiveEntries.map(normalizeArchiveEntry)
  const required = [
    '/out/main/index.js',
    '/out/preload/index.cjs',
    '/out/renderer/index.html',
    '/package.json',
    '/node_modules/typescript/package.json',
    '/node_modules/typescript/lib/typescript.js',
    '/node_modules/node-pty/package.json',
    '/node_modules/node-pty/lib/index.js',
  ]
  for (const entry of required) {
    if (!entries.includes(entry))
      throw new Error(`packaged app is missing required ASAR entry: ${entry}`)
  }
  for (const entry of entries) {
    if (
      ((entry === '/node_modules' || entry.startsWith('/node_modules/')) &&
        !isAllowedNodeModuleEntry(entry)) ||
      /(?:^|\/)(?:fixtures|tests|skills-catalog|desktop-pet)(?:\/|$)/i.test(
        entry,
      ) ||
      /(?:\.py|requirements[^/]*\.txt)$/i.test(entry)
    )
      throw new Error(`packaged app contains forbidden ASAR entry: ${entry}`)
    if (
      entry !== '/package.json' &&
      entry !== '/out' &&
      !entry.startsWith('/out/') &&
      !isAllowedNodeModuleEntry(entry)
    )
      throw new Error(`packaged app contains unexpected ASAR entry: ${entry}`)
  }

  const packageJson = JSON.parse(
    extractFile(asarPath, 'package.json').toString('utf8'),
  )
  if (packageJson?.main !== 'out/main/index.js')
    throw new Error('packaged app main entry is invalid')
  validatePreloadSource(extractFile(asarPath, 'out/preload/index.cjs'))
  const typescriptPackage = JSON.parse(
    extractFile(asarPath, 'node_modules/typescript/package.json').toString(
      'utf8',
    ),
  )
  if (
    packageJson?.dependencies?.typescript !== typescriptPackage?.version ||
    typescriptPackage?.main !== './lib/typescript.js'
  )
    throw new Error('packaged TypeScript parser version is invalid')
  const parserBytes = extractFile(
    asarPath,
    'node_modules/typescript/lib/typescript.js',
  ).byteLength
  if (parserBytes < 1_000_000 || parserBytes > 15 * 1024 * 1024)
    throw new Error('packaged TypeScript parser size is invalid')
  assertNoDevelopmentPaths(asarPath, archiveEntries)
  validatePackagedNodePty(resourcesRoot, platform, arch)

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
  validatePetPreloadSource(readFileSync(join(petRoot, 'preload.js')))

  for (const forbidden of ['backend', 'node_modules', 'skills-catalog']) {
    if (existsSync(join(resourcesRoot, forbidden)))
      throw new Error(`packaged resources contain forbidden path: ${forbidden}`)
  }
}

function validatePackagedNodePty(resourcesRoot, platform, arch) {
  const unpacked = join(
    resourcesRoot,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  )
  if (!existsSync(unpacked) || !lstatSync(unpacked).isDirectory())
    throw new Error('packaged node-pty native runtime is missing')
  const target = targetNodePtyFiles(unpacked, platform, arch)
  assertRegularFile(target.binding, `node-pty binding for ${platform}-${arch}`)
  if (target.helper) {
    assertRegularFile(
      target.helper,
      `node-pty spawn-helper for ${platform}-${arch}`,
    )
    if ((lstatSync(target.helper).mode & 0o111) === 0)
      throw new Error('packaged node-pty spawn-helper is not executable')
  }
}

function targetNodePtyFiles(root, platform, arch) {
  if (platform === 'darwin') {
    const nativeRoot = join(root, 'prebuilds', `darwin-${arch}`)
    return {
      binding: join(nativeRoot, 'pty.node'),
      helper: join(nativeRoot, 'spawn-helper'),
    }
  }
  if (platform === 'win32')
    return {
      binding: join(root, 'prebuilds', `win32-${arch}`, 'pty.node'),
      helper: null,
    }
  if (platform === 'linux')
    return {
      binding: join(root, 'build', 'Release', 'pty.node'),
      helper: join(root, 'build', 'Release', 'spawn-helper'),
    }
  throw new Error(`unsupported node-pty package target: ${platform}-${arch}`)
}

function prunePackagedNodePty(resourcesRoot, platform, arch) {
  const unpacked = join(
    resourcesRoot,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  )
  if (!existsSync(unpacked)) return
  const prebuilds = join(unpacked, 'prebuilds')
  const build = join(unpacked, 'build')
  if (platform === 'linux') {
    rmSync(prebuilds, { recursive: true, force: true })
    return
  }
  rmSync(build, { recursive: true, force: true })
  if (!existsSync(prebuilds)) return
  const keep = `${platform}-${arch}`
  for (const entry of readdirSync(prebuilds))
    if (entry !== keep)
      rmSync(join(prebuilds, entry), { recursive: true, force: true })
}

function assertNoDevelopmentPaths(asarPath, archiveEntries) {
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+\//,
    /\/home\/[A-Za-z0-9._-]+\//,
    /[A-Za-z]:\\Users\\[^\\]+\\/,
  ]
  for (const archiveEntry of archiveEntries) {
    const entry = normalizeArchiveEntry(archiveEntry)
    if (
      !entry.startsWith('/out/') ||
      !/\.(?:cjs|css|html|js|json|mjs)$/.test(entry)
    )
      continue
    const content = extractFile(asarPath, archiveEntry.replace(/^[/\\]/, ''))
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

function normalizeArchiveEntry(entry) {
  return entry.replace(/\\/g, '/')
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
  const platform = context.electronPlatformName || process.platform
  const arch = electronBuilderArch(context.arch)
  prunePackagedNodePty(resourcesRoot, platform, arch)
  validatePackagedAppResources(resourcesRoot, platform, arch)
}

function electronBuilderArch(value) {
  if (typeof value === 'string' && value) return value
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }[value] || process.arch
}

module.exports = afterPack
module.exports.validatePackagedAppResources = validatePackagedAppResources
module.exports.targetNodePtyFiles = targetNodePtyFiles
module.exports.prunePackagedNodePty = prunePackagedNodePty
module.exports.PET_RESOURCE_FILES = PET_RESOURCE_FILES
