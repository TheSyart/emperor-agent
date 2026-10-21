// SEC-04: binary hardening of a packaged Emperor, shared by after-pack (which
// applies it) and the packaged smoke (which checks it on the built package).
//
// Unsigned is not unsealed: no public build (Preview or Stable) carries a
// Developer ID, but its Electron fuses are flipped and every piece of code
// Emperor ships is sealed ad hoc with the hardened runtime, so no other
// process of the user can run its own code under Emperor's identity
// (cdhash, TCC grants).
const { spawnSync } = require('node:child_process')
const {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} = require('node:fs')
const { join, relative, sep } = require('node:path')

const CODESIGN = '/usr/bin/codesign'

const APP_IDENTIFIER = 'com.emperor.agent.desktop'

/**
 * Fuse states of every packaged build. Cookie encryption stays off: it keys
 * on a Keychain item, and Emperor uses no Keychain (local-secret-store.ts).
 * Embedded ASAR integrity needs the header hash electron-builder writes into
 * Info.plist (ElectronAsarIntegrity), which it does on macOS only, so the
 * fuse is on for macOS only.
 */
function packagedFuses(platform) {
  return {
    RunAsNode: false,
    EnableCookieEncryption: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: platform === 'darwin',
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
  }
}

function fusesModule() {
  return require('@electron/fuses')
}

/** The binary that holds the fuse wire's host: the .app on macOS. */
function electronBinaryPath({
  appOutDir,
  platform,
  productFilename,
  executableName,
}) {
  if (platform === 'darwin') return join(appOutDir, `${productFilename}.app`)
  if (platform === 'win32') return join(appOutDir, `${productFilename}.exe`)
  if (platform === 'linux') return join(appOutDir, executableName)
  throw new Error(`unsupported fuse target platform: ${platform}`)
}

/** Fuse states by name, as the binary has them now. */
async function readPackagedFuses(binary) {
  const { FuseV1Options, getCurrentFuseWire } = fusesModule()
  const wire = await getCurrentFuseWire(binary)
  const states = {}
  for (const name of Object.keys(packagedFuses('darwin'))) {
    const value = wire[FuseV1Options[name]]
    // The wire's bytes: '1' enabled, '0' disabled, 'r' removed.
    states[name] =
      value === 0x31
        ? true
        : value === 0x30
          ? false
          : value === undefined
            ? 'missing'
            : 'removed'
  }
  return states
}

function fuseMismatches(actual, platform) {
  const expected = packagedFuses(platform)
  return Object.entries(expected)
    .filter(([name, value]) => actual[name] !== value)
    .map(([name, value]) => `${name} is ${actual[name]}, expected ${value}`)
}

/** Flips the fuses, then reads them back; any difference fails the build. */
async function flipPackagedFuses(binary, platform) {
  if (!existsSync(binary))
    throw new Error(`Electron binary for fuses is missing: ${binary}`)
  const { FuseV1Options, FuseVersion, flipFuses } = fusesModule()
  const config = { version: FuseVersion.V1, strictlyRequireAllFuses: false }
  for (const [name, value] of Object.entries(packagedFuses(platform)))
    config[FuseV1Options[name]] = value
  await flipFuses(binary, config)
  const mismatches = fuseMismatches(await readPackagedFuses(binary), platform)
  if (mismatches.length)
    throw new Error(`Electron fuses were not flipped: ${mismatches.join('; ')}`)
}

function codesign(args) {
  const result = spawnSync(CODESIGN, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0)
    throw new Error(
      `codesign ${args.slice(0, -1).join(' ')} failed for ${args.at(-1)}: ${String(result.error || result.stderr || result.stdout).trim()}`,
    )
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

/** First bytes of a Mach-O or fat (universal) Mach-O file. */
function isMachO(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    if (readSync(fd, head, 0, 4, 0) !== 4) return false
    const magic = head.readUInt32BE(0)
    return [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
    ].includes(magic)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function walk(root, visit) {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      if (visit(path, true) !== false) walk(path, visit)
    } else if (stat.isFile()) visit(path, false)
  }
}

/**
 * Third-party code keeps its own signature: the Claude Code binary is
 * Anthropic's (Developer ID, hardened runtime), and node-pty's binaries are
 * recorded with their hashes in the ASAR header.
 */
function isUnpackedThirdParty(rel) {
  return rel.startsWith(`Contents${sep}Resources${sep}app.asar.unpacked${sep}`)
}

/** Places Emperor's code may live in its bundle; any other Mach-O is an error. */
function isCodeLocation(rel) {
  return (
    rel === join('Contents', 'MacOS', rel.split(sep).at(-1)) ||
    rel.startsWith(`Contents${sep}Frameworks${sep}`) ||
    rel.startsWith(`Contents${sep}Library${sep}Helpers${sep}`) ||
    rel.startsWith(`Contents${sep}Resources${sep}native${sep}`)
  )
}

/** The bundle a Mach-O file is the main executable of, if any. */
function ownerBundle(rel) {
  const parts = rel.split(sep)
  // Foo.app/Contents/MacOS/Foo
  if (
    parts.length >= 4 &&
    parts.at(-2) === 'MacOS' &&
    parts.at(-3) === 'Contents' &&
    parts.at(-4).endsWith('.app')
  )
    return parts.slice(0, -3).join(sep)
  // Foo.framework/Versions/A/Foo
  if (
    parts.length >= 4 &&
    parts.at(-3) === 'Versions' &&
    parts.at(-4) === `${parts.at(-1)}.framework`
  )
    return parts.slice(0, -3).join(sep)
  return null
}

/**
 * Every piece of code Emperor seals, innermost first, with the entitlements
 * each needs under the hardened runtime:
 * - main app: V8's JIT (MAP_JIT), library validation off (an ad-hoc seal
 *   has no Team ID, so dyld refuses the ad-hoc Electron Framework and
 *   node-pty's pty.node), and the microphone, because the dictation helper
 *   runs as its child and macOS asks for the responsible app;
 * - Electron helpers (renderer, GPU, plugin, utility): the same without the
 *   microphone (getUserMedia is refused, SEC-05);
 * - dictation helper: the microphone only;
 * - Computer Use helper, NM host, credential-auth, delegation-scan and
 *   Electron's frameworks and libraries: none.
 * Never allow-dyld-environment-variables or get-task-allow.
 */
function macSigningPlan(app, entitlements) {
  const targets = []
  const stray = []
  walk(app, (path, isDirectory) => {
    const rel = relative(app, path)
    if (
      isUnpackedThirdParty(rel) ||
      rel === `Contents${sep}Resources${sep}app.asar.unpacked`
    )
      return isDirectory ? false : undefined
    if (isDirectory) {
      if (
        (rel.endsWith('.app') || rel.endsWith('.framework')) &&
        isCodeLocation(rel)
      )
        targets.push(rel)
      return undefined
    }
    if (!isMachO(path) || ownerBundle(rel)) return undefined
    if (rel === join('Contents', 'MacOS', rel.split(sep).at(-1)))
      return undefined
    if (!isCodeLocation(rel)) stray.push(rel)
    else targets.push(rel)
    return undefined
  })
  if (stray.length)
    throw new Error(
      `packaged app has code outside its code locations: ${stray.join(', ')}`,
    )
  const helpers = join('Contents', 'Library', 'Helpers')
  const purpose = (rel) => {
    if (rel === join(helpers, 'Emperor Dictation Helper.app'))
      return entitlements.dictation
    if (
      rel.startsWith(`Contents${sep}Frameworks${sep}`) &&
      rel.split(sep).length === 3 &&
      rel.endsWith('.app')
    )
      return entitlements.electronHelper
    return null
  }
  const depth = (rel) => rel.split(sep).length
  const plan = targets
    .sort(
      (left, right) => depth(right) - depth(left) || (left < right ? -1 : 1),
    )
    .map((rel) => ({ path: join(app, rel), rel, entitlements: purpose(rel) }))
  plan.push({ path: app, rel: '.', entitlements: entitlements.app })
  return plan
}

/** Seals the app ad hoc, innermost code first, all with the hardened runtime. */
function sealMacApp(app, entitlements) {
  const plan = macSigningPlan(app, entitlements)
  for (const target of plan)
    codesign([
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--timestamp=none',
      ...(target.entitlements ? ['--entitlements', target.entitlements] : []),
      target.path,
    ])
  codesign(['--verify', '--deep', '--strict', app])
  return plan
}

/** Signature facts of one piece of code. */
function signatureFacts(path) {
  const detail = codesign(['-dv', '--verbose=4', path])
  const flags = /^CodeDirectory\b[^\n]*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(
    detail,
  )?.[1]
  const raw = spawnSync(
    CODESIGN,
    ['-d', '--entitlements', '-', '--xml', path],
    { encoding: 'utf8' },
  )
  const xml = raw.status === 0 ? raw.stdout || '' : ''
  const entitlements = [...xml.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)]
    .map((match) => match[1])
    .sort()
  return {
    identifier: /^Identifier=(.+)$/m.exec(detail)?.[1] ?? null,
    adHoc: /^Signature=adhoc$/m.test(detail),
    runtime: (flags ?? '').split(',').includes('runtime'),
    entitlements,
  }
}

const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.get-task-allow',
  'com.apple.security.cs.disable-executable-page-protection',
  // V8 allocates its code with MAP_JIT (allow-jit); verified with WebAssembly,
  // optimized JS and WebGL in main and renderer (SEC-04 receipt).
  'com.apple.security.cs.allow-unsigned-executable-memory',
]

const ELECTRON_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.disable-library-validation',
]

/** What each sealed piece of code must carry. */
function expectedEntitlements(rel) {
  if (rel === '.')
    return [
      ...ELECTRON_ENTITLEMENTS,
      'com.apple.security.device.audio-input',
    ].sort()
  if (
    rel ===
    join('Contents', 'Library', 'Helpers', 'Emperor Dictation Helper.app')
  )
    return ['com.apple.security.device.audio-input']
  if (
    rel.startsWith(`Contents${sep}Frameworks${sep}`) &&
    rel.split(sep).length === 3 &&
    rel.endsWith('.app')
  )
    return [...ELECTRON_ENTITLEMENTS].sort()
  return []
}

/**
 * The seal of a built macOS package (SEC-04): codesign --verify --deep
 * --strict, the app's identifier, the hardened runtime and exactly the
 * planned entitlements on every piece of Emperor's code, and the fuses.
 * Returns a path-free summary for the smoke receipt; throws on any gap.
 */
async function verifyMacHardening(app) {
  const problems = []
  try {
    codesign(['--verify', '--deep', '--strict', app])
  } catch (error) {
    problems.push(`codesign --verify --deep --strict failed: ${error.message}`)
  }
  let plan = []
  try {
    plan = macSigningPlan(app, {})
  } catch (error) {
    problems.push(error.message)
  }
  const helpers = {
    'Computer Helper': join(
      'Contents',
      'Library',
      'Helpers',
      'Emperor Computer Helper.app',
    ),
    'Dictation Helper': join(
      'Contents',
      'Library',
      'Helpers',
      'Emperor Dictation Helper.app',
    ),
    'Native Messaging host': join(
      'Contents',
      'Library',
      'Helpers',
      'emperor-nm-host',
    ),
  }
  const runtime = {}
  let identifier = null
  for (const target of plan) {
    let facts
    try {
      facts = signatureFacts(target.path)
    } catch (error) {
      problems.push(`${target.rel} has no readable signature: ${error.message}`)
      continue
    }
    if (target.rel === '.') identifier = facts.identifier
    if (!facts.runtime)
      problems.push(`${target.rel} lacks the hardened runtime`)
    for (const forbidden of FORBIDDEN_ENTITLEMENTS)
      if (facts.entitlements.includes(forbidden))
        problems.push(`${target.rel} has ${forbidden}`)
    const expected = expectedEntitlements(target.rel)
    if (facts.entitlements.join(',') !== expected.join(','))
      problems.push(
        `${target.rel} entitlements are [${facts.entitlements.join(', ')}], expected [${expected.join(', ')}]`,
      )
    for (const [label, rel] of Object.entries(helpers))
      if (rel === target.rel) runtime[label] = facts.runtime
  }
  for (const label of Object.keys(helpers))
    if (runtime[label] !== true) {
      runtime[label] = runtime[label] ?? false
      if (!plan.some((target) => target.rel === helpers[label]))
        problems.push(`${label} is missing from the package`)
    }
  if (identifier !== APP_IDENTIFIER)
    problems.push(`app identifier is ${identifier}, expected ${APP_IDENTIFIER}`)
  let fuses = {}
  try {
    fuses = await readPackagedFuses(app)
    problems.push(...fuseMismatches(fuses, 'darwin'))
  } catch (error) {
    problems.push(`fuses unreadable: ${error.message}`)
  }
  if (problems.length)
    throw new Error(`packaged app seal is invalid:\n- ${problems.join('\n- ')}`)
  return {
    codesignStrict: true,
    identifier,
    sealedCode: plan.length,
    runtime,
    fuses,
  }
}

module.exports = {
  APP_IDENTIFIER,
  CODESIGN,
  FORBIDDEN_ENTITLEMENTS,
  electronBinaryPath,
  expectedEntitlements,
  flipPackagedFuses,
  isMachO,
  macSigningPlan,
  packagedFuses,
  readPackagedFuses,
  sealMacApp,
  verifyMacHardening,
}
