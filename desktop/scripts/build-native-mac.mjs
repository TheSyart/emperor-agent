import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Native build directories use Mach-O architecture names, as the Swift
// scripts and `uname -m` do. Keep in sync with macosNativeArch() in
// src/main/computer-use/macos-launcher.ts.
const MACOS_NATIVE_ARCH = { arm64: 'arm64', x64: 'x86_64' }

if (process.platform === 'darwin') {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const arch = MACOS_NATIVE_ARCH[process.arch]
  if (!arch)
    throw new Error(`Unsupported macOS native architecture: ${process.arch}`)
  const source = resolve(desktop, 'native/macos/CredentialAuth/main.swift')
  const output = resolve(desktop, 'out/native/credential-auth')
  mkdirSync(dirname(output), { recursive: true })
  for (const [command, args] of [
    ['swiftc', [source, '-o', output]],
    ['codesign', ['-s', '-', '--force', output]],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit' })
    if (result.status !== 0)
      throw new Error(`${command} failed while building credential-auth`)
  }
  const assemble = resolve(desktop, 'native/macos/scripts/assemble-app.sh')
  const result = spawnSync('bash', [assemble, arch], {
    stdio: 'inherit',
  })
  if (result.status !== 0)
    throw new Error('macOS Computer Use helper build failed')
  const helper = resolve(desktop, 'out/native/Emperor Computer Helper.app')
  rmSync(helper, { recursive: true, force: true })
  cpSync(
    resolve(desktop, `native/macos/build/${arch}/Emperor Computer Helper.app`),
    helper,
    { recursive: true },
  )

  const nativeMessagingBuild = resolve(desktop, 'native/browser-host/build.sh')
  const nativeMessaging = spawnSync(
    'bash',
    [nativeMessagingBuild, arch, 'release'],
    { stdio: 'inherit' },
  )
  if (nativeMessaging.status !== 0)
    throw new Error('macOS Native Messaging host build failed')
  const host = resolve(desktop, 'out/native/emperor-nm-host')
  rmSync(host, { force: true })
  cpSync(
    resolve(
      desktop,
      `native/browser-host/build/${arch}/release/emperor-nm-host`,
    ),
    host,
  )
}
