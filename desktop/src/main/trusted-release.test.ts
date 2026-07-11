import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const require = createRequire(import.meta.url)
const originalTarget = process.env.EMPEROR_RELEASE_TARGET

afterEach(() => {
  if (originalTarget === undefined) delete process.env.EMPEROR_RELEASE_TARGET
  else process.env.EMPEROR_RELEASE_TARGET = originalTarget
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
})
