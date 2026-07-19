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
  it('keeps Frozen Stable manual, tag-verified and environment-protected', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    )

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*push:\s*$/m)
    expect(workflow).toContain('release-policy:')
    expect(workflow).toContain('git cat-file -t "refs/tags/$STABLE_TAG"')
    expect(workflow).toContain('git merge-base --is-ancestor')
    expect(workflow.indexOf('commit="$(git rev-parse')).toBeLessThan(
      workflow.indexOf('version="$(git show'),
    )
    expect(workflow).toContain('needs: release-policy')
    expect(workflow).toContain(
      "if: inputs.publish == true && vars.EMPEROR_STABLE_RELEASE_ENABLED == 'true'",
    )
    expect(workflow).toContain('environment: stable-release')
  })

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

  it('builds both AppImage and DEB from the trusted Linux configuration', () => {
    process.env.EMPEROR_RELEASE_TARGET = 'linux'
    const configFactory = require(
      path.join(desktopRoot, 'electron-builder.release.cjs'),
    ) as () => Record<string, unknown>
    const config = configFactory() as {
      linux?: Record<string, unknown>
    }

    expect(config.linux).toMatchObject({
      target: ['AppImage', 'deb'],
      artifactName: 'Emperor-Agent-${version}-linux-x64.${ext}',
      maintainer: 'Emperor Agent maintainers',
      vendor: 'Emperor Agent',
    })
  })

  it('provides the package metadata required by DEB', () => {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as { author?: string; homepage?: string }

    expect(metadata.author).toBe('Emperor Agent maintainers')
    expect(metadata.homepage).toBe('https://github.com/TheSyart/emperor-agent')
  })

  it('builds once on Ubuntu 22.04 and smokes on Ubuntu 22.04 and 24.04', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    )

    expect(workflow).toContain('linux-build:')
    expect(workflow).toContain('linux-smoke:')
    expect(workflow).toContain('ubuntu-22.04')
    expect(workflow).toContain('ubuntu-24.04')
    expect(workflow).toContain('EMPEROR_RELEASE_TARGET: linux')
    expect(workflow).toContain('--linux AppImage deb --x64')
    expect(workflow).toContain('verify-linux-release.sh prepare')
    expect(workflow).toContain('verify-linux-release.sh smoke')
    expect(workflow).not.toContain('softprops/action-gh-release')
  })

  it('verifies Linux metadata, checksums, AppImage and DEB lifecycle receipts', () => {
    const verifier = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'verify-linux-release.sh'),
      'utf8',
    )
    const runner = fs.readFileSync(
      path.join(desktopRoot, 'scripts', 'run-packaged-smoke.cjs'),
      'utf8',
    )

    expect(verifier).toContain('dpkg-deb --info')
    expect(verifier).toContain('sha256sum --check')
    expect(verifier).toContain('APPIMAGE_EXTRACT_AND_RUN=1')
    expect(verifier).toContain('run-packaged-smoke.cjs')
    expect(verifier).toContain(
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes "$DEB"',
    )
    expect(verifier).toContain('sudo apt-get remove --yes "$DEB_PACKAGE"')
    expect(verifier).not.toContain('sudo dpkg --install')
    expect(verifier).toContain('AppImage wrapper/FUSE failure')
    expect(verifier).toContain('Chromium sandbox failure')
    expect(runner).toContain("APPIMAGE_EXTRACT_AND_RUN: '1'")
  })

  it('attests a complete candidate bundle before the publish job can run', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    )

    expect(workflow).toContain('release-aggregate:')
    expect(workflow).toContain('publish-release:')
    expect(workflow).toContain('needs: [release-policy, release-aggregate]')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('attestations: write')
    expect(workflow).toContain('artifact-metadata: write')
    expect(workflow).toContain('@cyclonedx/cyclonedx-npm@6.0.0')
    expect(workflow).toContain('scripts/merge-cyclonedx-sboms.mjs')
    expect(workflow.match(/actions\/attest@v4/g)?.length).toBe(2)
    expect(workflow).toContain('subject-checksums:')
    expect(workflow).toContain('sbom-path:')
    expect(workflow).toContain('gh attestation verify')
    expect(workflow).toContain('scripts/assemble-release-bundle.mjs')
    expect(workflow).toContain('scripts/publish-release.sh')
    expect(workflow).not.toContain('softprops/action-gh-release')
  })

  it('keeps unsigned internal packages manual, short-lived and unpublishable', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release-internal.yml'),
      'utf8',
    )

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).toContain('UNSIGNED-INTERNAL')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toContain('gh release')
  })

  it('fails closed on incomplete, unsigned or receipt-less release bundles', () => {
    const assembler = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'assemble-release-bundle.mjs'),
      'utf8',
    )
    const publisher = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'publish-release.sh'),
      'utf8',
    )

    expect(assembler).toContain('UNSIGNED-INTERNAL')
    expect(assembler).toContain('macos-arm64.json')
    expect(assembler).toContain('windows-x64.json')
    expect(assembler).toContain('24.04-lifecycle.json')
    expect(assembler).toContain('ARTIFACT-SHA256SUMS.txt')
    expect(assembler).toContain('release-manifest.json')
    expect(publisher).toContain('gh release create')
    expect(publisher).toContain('--draft')
    expect(publisher).toContain('gh release upload')
    expect(publisher).toContain('gh release edit')
    expect(publisher).toContain('--draft=false')
    expect(publisher).toContain('gh release delete')
  })
})
