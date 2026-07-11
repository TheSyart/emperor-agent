import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const require = createRequire(import.meta.url)
const releaseEnvNames = [
  'EMPEROR_RELEASE_TARGET',
  'WINDOWS_SIGNING_ENDPOINT',
  'WINDOWS_SIGNING_PROFILE',
  'WINDOWS_SIGNING_ACCOUNT',
  'WINDOWS_SIGNING_PUBLISHER',
] as const
const originalReleaseEnv = Object.fromEntries(
  releaseEnvNames.map((name) => [name, process.env[name]]),
)

afterEach(() => {
  for (const name of releaseEnvNames) {
    const value = originalReleaseEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('trusted release configuration', () => {
  it('hard-gates signed and notarized macOS candidates', () => {
    process.env.EMPEROR_RELEASE_TARGET = 'mac'
    const configFactory = require(
      path.join(desktopRoot, 'electron-builder.release.cjs'),
    ) as () => Record<string, unknown>
    const config = configFactory() as {
      extends?: string
      mac?: Record<string, unknown>
    }

    expect(config.extends).toBe('./electron-builder.yml')
    expect(config.mac).toMatchObject({
      forceCodeSigning: true,
      hardenedRuntime: true,
      minimumSystemVersion: '14.0',
      notarize: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    })
  })

  it('keeps macOS entitlements minimal and suitable for Electron helpers', () => {
    for (const name of [
      'entitlements.mac.plist',
      'entitlements.mac.inherit.plist',
    ]) {
      const content = fs.readFileSync(
        path.join(desktopRoot, 'build', name),
        'utf8',
      )
      expect(content).toContain('com.apple.security.cs.allow-jit')
      expect(content).toContain(
        'com.apple.security.cs.allow-unsigned-executable-memory',
      )
      expect(content).not.toContain('com.apple.security.app-sandbox')
      expect(content).not.toContain(
        'com.apple.security.cs.allow-dyld-environment-variables',
      )
    }
  })

  it('builds macOS arm64 and x64 candidates without publishing from build jobs', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    )

    expect(workflow).toContain('macos-15')
    expect(workflow).toContain('macos-15-intel')
    expect(workflow).toContain('EMPEROR_RELEASE_TARGET: mac')
    expect(workflow).toContain('APPLE_API_KEY_BASE64')
    expect(workflow).toContain('CSC_LINK')
    expect(workflow).toContain('verify-macos-release.sh')
    expect(workflow).not.toContain('desktop-pet/package-lock.json')
    expect(workflow).not.toContain('working-directory: desktop-pet')
    expect(workflow).not.toContain('softprops/action-gh-release')
  })

  it('verifies Developer ID, Gatekeeper, stapling, DMG mount and packaged smoke', () => {
    const verifier = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'verify-macos-release.sh'),
      'utf8',
    )

    expect(verifier).toContain('codesign --verify --deep --strict')
    expect(verifier).toContain('TeamIdentifier=')
    expect(verifier).toContain('spctl --assess')
    expect(verifier).toContain('xcrun stapler validate')
    expect(verifier).toContain('hdiutil attach')
    expect(verifier).toContain('hdiutil detach')
    expect(verifier).toContain('run-packaged-smoke.cjs')
    expect(verifier).toContain('shasum -a 256')
    expect(verifier).toContain('LIPO_ARCH="x86_64"')
  })

  it('hard-gates Azure Artifact Signing for Windows x64', () => {
    process.env.EMPEROR_RELEASE_TARGET = 'win'
    process.env.WINDOWS_SIGNING_ENDPOINT = 'https://eus.codesigning.azure.net/'
    process.env.WINDOWS_SIGNING_PROFILE = 'emperor-release'
    process.env.WINDOWS_SIGNING_ACCOUNT = 'emperor-signing'
    process.env.WINDOWS_SIGNING_PUBLISHER = 'Emperor Agent LLC'
    const configFactory = require(
      path.join(desktopRoot, 'electron-builder.release.cjs'),
    ) as () => Record<string, unknown>
    const config = configFactory() as {
      win?: Record<string, unknown>
      nsis?: Record<string, unknown>
    }

    expect(config.win).toMatchObject({
      forceCodeSigning: true,
      publisherName: ['Emperor Agent LLC'],
      azureSignOptions: {
        endpoint: 'https://eus.codesigning.azure.net/',
        certificateProfileName: 'emperor-release',
        codeSigningAccountName: 'emperor-signing',
      },
    })
    expect(config.win).not.toHaveProperty('signtoolOptions')
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
    })
  })

  it('requires Windows signing metadata before configuration is usable', () => {
    process.env.EMPEROR_RELEASE_TARGET = 'win'
    delete process.env.WINDOWS_SIGNING_ENDPOINT
    const configFactory = require(
      path.join(desktopRoot, 'electron-builder.release.cjs'),
    ) as () => Record<string, unknown>

    expect(() => configFactory()).toThrow(/WINDOWS_SIGNING_ENDPOINT/)
  })

  it('builds and verifies a signed Windows NSIS candidate without publishing', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    )
    const verifier = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'verify-windows-release.ps1'),
      'utf8',
    )

    expect(workflow).toContain('windows-2022')
    expect(workflow).toContain('EMPEROR_RELEASE_TARGET: win')
    expect(workflow).toContain('AZURE_TENANT_ID')
    expect(workflow).toContain('AZURE_CLIENT_ID')
    expect(workflow).toContain('AZURE_CLIENT_SECRET')
    expect(workflow).toContain('verify-windows-release.ps1')
    expect(workflow).not.toContain('softprops/action-gh-release')
    expect(verifier).toContain('Get-AuthenticodeSignature')
    expect(verifier).toContain('X509NameType]::SimpleName')
    expect(verifier).toContain('/S')
    expect(verifier).toContain('/D=')
    expect(verifier).toContain('run-packaged-smoke.cjs')
    expect(verifier).toContain('Uninstall Emperor Agent.exe')
    expect(verifier).toContain('Get-FileHash')
  })
})
