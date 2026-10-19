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
  validateRecoveryPreloadSource,
} = require('./audit-preload.cjs')
const {
  electronBinaryPath,
  flipPackagedFuses,
  sealMacApp,
  verifyMacHardening,
} = require('./harden-package.cjs')

/** Entitlements of the ad-hoc Preview seal (harden-package.cjs). */
const PREVIEW_ENTITLEMENTS = {
  app: join(__dirname, '..', 'build', 'entitlements.preview.mac.plist'),
  electronHelper: join(
    __dirname,
    '..',
    'build',
    'entitlements.preview.mac.inherit.plist',
  ),
  dictation: join(
    __dirname,
    '..',
    'native',
    'macos',
    'scripts',
    'dictation-helper.entitlements',
  ),
}

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

function isAllowedNodeModuleEntry(
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  // The Claude Agent SDK and the binary for this build's platform and
  // architecture only (AGT-01) ship for Claude Code; nothing else from
  // @anthropic-ai is allowed in.
  const sdkNested = '/node_modules/@anthropic-ai/claude-agent-sdk/node_modules'
  if (entry === sdkNested) return true
  if (entry.startsWith(sdkNested + '/'))
    entry = '/node_modules' + entry.slice(sdkNested.length)
  if (entry === '/node_modules/@anthropic-ai') return true
  const target = /^[a-z0-9]+$/.test(platform) && /^[a-z0-9]+$/.test(arch)
  if (
    target &&
    new RegExp(
      `^/node_modules/@anthropic-ai/claude-agent-sdk(?:-${platform}-${arch}(?:-musl)?)?(?:/(?:package\\.json|sdk\\.mjs|manifest(?:\\.zst)?\\.json|claude(?:\\.exe)?))?$`,
    ).test(entry)
  )
    return true
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
    '/out/preload/recovery.cjs',
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
        !isAllowedNodeModuleEntry(entry, platform, arch)) ||
      /(?:^|\/)(?:fixtures|tests|desktop-pet)(?:\/|$)/i.test(entry) ||
      /(?:\.py|requirements[^/]*\.txt)$/i.test(entry)
    )
      throw new Error(`packaged app contains forbidden ASAR entry: ${entry}`)
    if (
      entry !== '/package.json' &&
      entry !== '/out' &&
      !entry.startsWith('/out/') &&
      !isAllowedNodeModuleEntry(entry, platform, arch)
    )
      throw new Error(`packaged app contains unexpected ASAR entry: ${entry}`)
  }

  const packageJson = JSON.parse(
    extractFile(asarPath, 'package.json').toString('utf8'),
  )
  if (packageJson?.main !== 'out/main/index.js')
    throw new Error('packaged app main entry is invalid')
  validatePreloadSource(extractFile(asarPath, 'out/preload/index.cjs'))
  validateRecoveryPreloadSource(
    extractFile(asarPath, 'out/preload/recovery.cjs'),
  )
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
  validatePackagedClaudeSdk(resourcesRoot, entries, platform, arch)
  if (platform === 'darwin') {
    const auth = join(resourcesRoot, 'native', 'credential-auth')
    assertRegularFile(auth, 'native/credential-auth')
    if ((lstatSync(auth).mode & 0o111) === 0)
      throw new Error('credential-auth is not executable')
    const helpersRoot = join(resourcesRoot, '..', 'Library', 'Helpers')
    const expectedHelpers = [
      'Emperor Computer Helper.app',
      'Emperor Dictation Helper.app',
      'emperor-nm-host',
    ]
    const actualHelpers = readdirSync(helpersRoot).sort()
    if (
      actualHelpers.length !== expectedHelpers.length ||
      actualHelpers.some((name, index) => name !== expectedHelpers[index])
    )
      throw new Error('packaged Computer Use helpers do not match allowlist')
    const helper = join(helpersRoot, 'Emperor Computer Helper.app')
    if (
      !existsSync(helper) ||
      !lstatSync(helper).isDirectory() ||
      lstatSync(helper).isSymbolicLink()
    )
      throw new Error('packaged Computer Use helper app is missing or unsafe')
    const info = join(helper, 'Contents', 'Info.plist')
    const executable = join(
      helper,
      'Contents',
      'MacOS',
      'emperor-computer-helper',
    )
    assertRegularFile(info, 'Computer Use helper Info.plist')
    assertRegularFile(executable, 'Computer Use helper executable')
    if (
      !readFileSync(info, 'utf8').includes(
        '<string>com.emperor.agent.desktop.computer-helper</string>',
      ) ||
      (lstatSync(executable).mode & 0o111) === 0
    )
      throw new Error('packaged Computer Use helper identity is invalid')
    validateHelperIcon(helper, 'Computer Use helper')
    validateDictationHelper(join(helpersRoot, 'Emperor Dictation Helper.app'))
    const messagingHost = join(helpersRoot, 'emperor-nm-host')
    assertRegularFile(messagingHost, 'Native Messaging host')
    if ((lstatSync(messagingHost).mode & 0o111) === 0)
      throw new Error('Native Messaging host is not executable')
    validateBrowserExtension(join(resourcesRoot, 'browser-extension'))
  }

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

  for (const forbidden of ['backend', 'node_modules']) {
    if (existsSync(join(resourcesRoot, forbidden)))
      throw new Error(`packaged resources contain forbidden path: ${forbidden}`)
  }
}

/**
 * Claude Code runs the binary bundled with the Agent SDK (AGT-01): the SDK
 * is in the archive, and exactly this build's binary is unpacked and
 * executable. Another architecture's 200+ MB binary must not ride along.
 */
function validatePackagedClaudeSdk(resourcesRoot, entries, platform, arch) {
  if (platform !== 'darwin') return
  const sdk = '/node_modules/@anthropic-ai/claude-agent-sdk'
  for (const file of ['package.json', 'sdk.mjs', 'manifest.json'])
    if (!entries.includes(`${sdk}/${file}`))
      throw new Error(`packaged app is missing the Claude Agent SDK ${file}`)
  const scope = join(
    resourcesRoot,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
  )
  const expected = `claude-agent-sdk-${platform}-${arch}`
  const found = []
  for (const directory of [
    scope,
    join(scope, 'claude-agent-sdk', 'node_modules', '@anthropic-ai'),
  ])
    if (existsSync(directory))
      for (const name of readdirSync(directory))
        if (name.startsWith('claude-agent-sdk-'))
          found.push(join(directory, name))
  const stray = found.find((path) => !path.endsWith(`/${expected}`))
  if (stray)
    throw new Error(
      `packaged Claude binary for ${stray.slice(stray.lastIndexOf('claude-agent-sdk-') + 'claude-agent-sdk-'.length)} must not ship in a ${platform}-${arch} build`,
    )
  if (!found.length)
    throw new Error(
      `packaged app is missing the Claude Code binary for ${platform}-${arch}`,
    )
  for (const directory of found) {
    const binary = join(directory, 'claude')
    assertRegularFile(binary, `Claude Code binary for ${platform}-${arch}`)
    if ((lstatSync(binary).mode & 0o111) === 0)
      throw new Error('packaged Claude Code binary is not executable')
  }
}

const BROWSER_EXTENSION_FILES = [
  'manifest.json',
  'service-worker.js',
  // The worker imports it (the Agent's tabs, navigation, downloads).
  'agent.js',
  'welcome.html',
  'icons/icon-128.png',
]

/**
 * The Chrome/Edge extension Settings installs: regular files only, none of
 * its tests or docs, and a Manifest V3 with the key that pins its ID.
 */
function validateBrowserExtension(root) {
  const fail = (why) => {
    throw new Error(`packaged browser-extension ${why}`)
  }
  if (!existsSync(root) || lstatSync(root).isSymbolicLink())
    fail('is missing or unsafe')
  if (!lstatSync(root).isDirectory()) fail('is not a directory')
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(path)
      if (
        name.startsWith('.') ||
        relative === 'tests' ||
        relative === 'README.md' ||
        name.endsWith('.test.js')
      )
        fail(`contains a file that must not ship: ${relative}`)
      if (stat.isDirectory()) walk(path, relative)
      else if (!stat.isFile()) fail(`contains a non-regular entry: ${relative}`)
    }
  }
  walk(root, '')
  for (const file of BROWSER_EXTENSION_FILES)
    if (!existsSync(join(root, file)) || !lstatSync(join(root, file)).isFile())
      fail(`is missing ${file}`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  } catch {
    fail('has an unreadable manifest.json')
  }
  if (manifest?.manifest_version !== 3 || typeof manifest?.key !== 'string')
    fail('manifest.json is not the pinned Manifest V3')
}

/** Editor dictation helper: its identity and the two usage strings. */
function validateDictationHelper(helper) {
  if (
    !existsSync(helper) ||
    !lstatSync(helper).isDirectory() ||
    lstatSync(helper).isSymbolicLink()
  )
    throw new Error('packaged dictation helper app is missing or unsafe')
  const info = join(helper, 'Contents', 'Info.plist')
  const executable = join(
    helper,
    'Contents',
    'MacOS',
    'emperor-dictation-helper',
  )
  assertRegularFile(info, 'dictation helper Info.plist')
  assertRegularFile(executable, 'dictation helper executable')
  const plist = readFileSync(info, 'utf8')
  if (
    !plist.includes(
      '<string>com.emperor.agent.desktop.dictation-helper</string>',
    ) ||
    !plist.includes('<key>NSMicrophoneUsageDescription</key>') ||
    !plist.includes('<key>NSSpeechRecognitionUsageDescription</key>') ||
    (lstatSync(executable).mode & 0o111) === 0
  )
    throw new Error('packaged dictation helper identity is invalid')
  validateHelperIcon(helper, 'dictation helper')
}

/**
 * A helper names its icon in Info.plist and carries it in Resources (RV-07);
 * without it macOS shows a blank icon in the permission prompts and in
 * System Settings › Privacy & Security.
 */
function validateHelperIcon(helper, label) {
  const plist = readFileSync(join(helper, 'Contents', 'Info.plist'), 'utf8')
  const name = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(
    plist,
  )?.[1]
  if (!name || name.includes('/') || name.startsWith('.'))
    throw new Error(`packaged ${label} icon is not named in Info.plist`)
  const icon = join(
    helper,
    'Contents',
    'Resources',
    name.endsWith('.icns') ? name : `${name}.icns`,
  )
  assertRegularFile(icon, `${label} icon`)
  if (readFileSync(icon).subarray(0, 4).toString('latin1') !== 'icns')
    throw new Error(`packaged ${label} icon is not an icns file`)
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
  // node-pty builds spawn-helper for macOS only; Linux forks directly.
  if (platform === 'linux')
    return {
      binding: join(root, 'build', 'Release', 'pty.node'),
      helper: null,
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
  // SEC-04: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, no app
  // outside app.asar, and on macOS an asar whose header hash must match
  // Info.plist. Flipped before any signature: it rewrites Electron's binary.
  await flipPackagedFuses(
    electronBinaryPath({
      appOutDir: context.appOutDir,
      platform,
      productFilename: appInfo.productFilename,
      executableName: context.packager.executableName,
    }),
    platform,
  )
  // Preview has no developer certificate. Seal the bundle ad hoc, every
  // piece of code with the hardened runtime, so the main executable has a
  // stable bundle identifier, the helper can bind a local peer to this exact
  // build's cdhash, and no DYLD_* variable loads foreign code into a process
  // that holds Emperor's TCC grants. This remains an untrusted Preview for
  // Gatekeeper and needs TCC re-authorization after every changed build.
  if (
    platform === 'darwin' &&
    context.packager.config?.mac?.identity === null
  ) {
    const app = join(context.appOutDir, `${appInfo.productFilename}.app`)
    sealMacApp(app, PREVIEW_ENTITLEMENTS)
    require('./after-sign.cjs').validateMacPackage(app, arch)
    await verifyMacHardening(app)
  }
}

function electronBuilderArch(value) {
  if (typeof value === 'string' && value) return value
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }[value] || process.arch
}

module.exports = afterPack
module.exports.validatePackagedAppResources = validatePackagedAppResources
module.exports.validatePackagedClaudeSdk = validatePackagedClaudeSdk
module.exports.isAllowedNodeModuleEntry = isAllowedNodeModuleEntry
module.exports.targetNodePtyFiles = targetNodePtyFiles
module.exports.prunePackagedNodePty = prunePackagedNodePty
module.exports.PET_RESOURCE_FILES = PET_RESOURCE_FILES
module.exports.PREVIEW_ENTITLEMENTS = PREVIEW_ENTITLEMENTS
