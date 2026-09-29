const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const EXPECTED_LABELS = [
  'app',
  'Electron Framework',
  'Computer Helper',
  'Native Messaging host',
  'credential-auth',
]

function checked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed for ${args.at(-1)}: ${String(result.error || result.stderr || result.stdout).trim()}`,
    )
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function signatureEntry(label, signedPath, executablePath) {
  const detail = checked('codesign', ['-dv', '--verbose=4', signedPath])
  const architectures = checked('lipo', ['-archs', executablePath])
    .trim()
    .split(/\s+/)
  return {
    label,
    architectures,
    teamId: /^TeamIdentifier=(.+)$/m.exec(detail)?.[1] || null,
    authority: /^Authority=(.+)$/m.exec(detail)?.[1] || null,
    adHoc: /^Signature=adhoc$/m.test(detail),
  }
}

function validateMacSignatureEntries(entries, arch) {
  if (
    entries.length !== EXPECTED_LABELS.length ||
    entries.some((entry, index) => entry.label !== EXPECTED_LABELS[index])
  )
    throw new Error('Computer Use signature inventory is incomplete')
  const binaryArch = arch === 'x64' ? 'x86_64' : arch
  for (const entry of entries)
    if (!entry.architectures.includes(binaryArch))
      throw new Error(`${entry.label} has the wrong architecture for ${arch}`)

  const first = entries[0]
  for (const entry of entries) {
    if (entry.adHoc !== first.adHoc)
      throw new Error(`${entry.label} has a different signing identity`)
    if (first.adHoc) {
      if (entry.authority || (entry.teamId && entry.teamId !== 'not set'))
        throw new Error(`${entry.label} has a different signing identity`)
    } else if (
      !first.authority ||
      !first.teamId ||
      first.teamId === 'not set' ||
      entry.authority !== first.authority ||
      entry.teamId !== first.teamId
    )
      throw new Error(`${entry.label} has a different signing identity`)
  }
}

function validateMacPackage(app, arch) {
  checked('codesign', ['--verify', '--deep', '--strict', app])
  const contents = join(app, 'Contents')
  const framework = join(contents, 'Frameworks', 'Electron Framework.framework')
  const helper = join(
    contents,
    'Library',
    'Helpers',
    'Emperor Computer Helper.app',
  )
  const host = join(contents, 'Library', 'Helpers', 'emperor-nm-host')
  const credentialAuth = join(
    contents,
    'Resources',
    'native',
    'credential-auth',
  )
  const entries = [
    signatureEntry('app', app, join(contents, 'MacOS', 'Emperor Agent')),
    signatureEntry(
      'Electron Framework',
      framework,
      join(framework, 'Versions', 'A', 'Electron Framework'),
    ),
    signatureEntry(
      'Computer Helper',
      helper,
      join(helper, 'Contents', 'MacOS', 'emperor-computer-helper'),
    ),
    signatureEntry('Native Messaging host', host, host),
    signatureEntry('credential-auth', credentialAuth, credentialAuth),
  ]
  validateMacSignatureEntries(entries, arch)
  return entries
}

function electronBuilderArch(value) {
  if (typeof value === 'string' && value) return value
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }[value] || process.arch
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  validateMacPackage(app, electronBuilderArch(context.arch))
}

module.exports = afterSign
module.exports.validateMacPackage = validateMacPackage
module.exports.validateMacSignatureEntries = validateMacSignatureEntries
