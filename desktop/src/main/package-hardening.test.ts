import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const desktopRoot = path.resolve(__dirname, '..', '..')
const require = createRequire(import.meta.url)

interface PlanEntry {
  rel: string
  entitlements: string | null
}
interface Hardening {
  APP_IDENTIFIER: string
  CODESIGN: string
  FORBIDDEN_ENTITLEMENTS: string[]
  electronBinaryPath(input: {
    appOutDir: string
    platform: string
    productFilename: string
    executableName?: string
  }): string
  expectedEntitlements(rel: string): string[]
  flipPackagedFuses(binary: string, platform: string): Promise<void>
  macSigningPlan(app: string, entitlements: Record<string, string>): PlanEntry[]
  packagedFuses(platform: string): Record<string, boolean>
  readPackagedFuses(binary: string): Promise<Record<string, unknown>>
}
const hardening = require(
  path.join(desktopRoot, 'scripts', 'harden-package.cjs'),
) as Hardening

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-hardening-'))
  roots.push(root)
  return root
}

/** A stand-in binary with Electron 42's fuse wire (9 fuses, defaults). */
function fuseWire(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // RunAsNode, CookieEncryption, NodeOptions, Inspect, AsarIntegrity,
  // OnlyAsar, BrowserSnapshot, FileProtocol, WasmTrapHandlers
  const defaults = '101100011'
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from('prefix-bytes'),
      Buffer.from(SENTINEL),
      Buffer.from([1, defaults.length]),
      Buffer.from(defaults),
      Buffer.from('suffix-bytes'),
    ]),
  )
}

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
function code(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, MACHO, { mode: 0o755 })
}

describe('packaged Electron fuses (SEC-04)', () => {
  it('turns off Node entry points and file:// privileges, never cookie encryption', () => {
    expect(hardening.packagedFuses('darwin')).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      GrantFileProtocolExtraPrivileges: false,
    })
    // electron-builder writes the asar header hash on macOS only.
    for (const platform of ['linux', 'win32'])
      expect(hardening.packagedFuses(platform)).toMatchObject({
        RunAsNode: false,
        EnableEmbeddedAsarIntegrityValidation: false,
        OnlyLoadAppFromAsar: true,
      })
  })

  it('flips the wire of the Electron Framework inside the app and reads it back', async () => {
    const app = path.join(temp(), 'Emperor Agent.app')
    const framework = path.join(
      app,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    )
    fuseWire(framework)
    expect(await hardening.readPackagedFuses(app)).toMatchObject({
      RunAsNode: true,
      EnableNodeOptionsEnvironmentVariable: true,
      EnableNodeCliInspectArguments: true,
      EnableEmbeddedAsarIntegrityValidation: false,
      OnlyLoadAppFromAsar: false,
      GrantFileProtocolExtraPrivileges: true,
    })
    await hardening.flipPackagedFuses(app, 'darwin')
    expect(await hardening.readPackagedFuses(app)).toEqual(
      hardening.packagedFuses('darwin'),
    )
    // Asar integrity and app-from-asar on; the ninth fuse
    // (WasmTrapHandlers) keeps Electron's default.
    const bytes = fs.readFileSync(framework)
    const wire = bytes.indexOf(SENTINEL) + SENTINEL.length + 2
    expect(bytes.subarray(wire, wire + 9).toString()).toBe('000011001')
  })

  it('names the binary holding the wire on every platform, and fails on a missing one', async () => {
    expect(
      hardening.electronBinaryPath({
        appOutDir: '/out',
        platform: 'darwin',
        productFilename: 'Emperor Agent',
      }),
    ).toBe('/out/Emperor Agent.app')
    expect(
      hardening.electronBinaryPath({
        appOutDir: '/out',
        platform: 'win32',
        productFilename: 'Emperor Agent',
      }),
    ).toBe('/out/Emperor Agent.exe')
    expect(
      hardening.electronBinaryPath({
        appOutDir: '/out',
        platform: 'linux',
        productFilename: 'Emperor Agent',
        executableName: 'emperor-agent',
      }),
    ).toBe('/out/emperor-agent')
    await expect(
      hardening.flipPackagedFuses(path.join(temp(), 'missing'), 'linux'),
    ).rejects.toThrow(/missing/)
  })
})

describe('ad-hoc hardened-runtime seal (SEC-04)', () => {
  const entitlements = {
    app: '/e/app.plist',
    electronHelper: '/e/helper.plist',
    dictation: '/e/dictation.plist',
  }

  function fakeApp(): string {
    const app = path.join(temp(), 'Emperor Agent.app')
    const c = path.join(app, 'Contents')
    code(path.join(c, 'MacOS', 'Emperor Agent'))
    const electron = path.join(
      c,
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
    )
    code(path.join(electron, 'Electron Framework'))
    code(path.join(electron, 'Libraries', 'libEGL.dylib'))
    code(path.join(electron, 'Helpers', 'chrome_crashpad_handler'))
    fs.mkdirSync(path.join(electron, 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(electron, 'Resources', 'Info.plist'), '<plist/>')
    for (const helper of ['', ' (Renderer)'])
      code(
        path.join(
          c,
          'Frameworks',
          `Emperor Agent Helper${helper}.app`,
          'Contents',
          'MacOS',
          `Emperor Agent Helper${helper}`,
        ),
      )
    for (const [bundle, exe] of [
      ['Emperor Computer Helper.app', 'emperor-computer-helper'],
      ['Emperor Dictation Helper.app', 'emperor-dictation-helper'],
    ])
      code(
        path.join(c, 'Library', 'Helpers', bundle!, 'Contents', 'MacOS', exe!),
      )
    code(path.join(c, 'Library', 'Helpers', 'emperor-nm-host'))
    code(path.join(c, 'Resources', 'native', 'credential-auth'))
    code(path.join(c, 'Resources', 'native', 'delegation-scan'))
    // Anthropic's and node-pty's binaries keep their own signatures.
    code(
      path.join(
        c,
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-darwin-arm64',
        'claude',
      ),
    )
    fs.mkdirSync(path.join(c, 'Resources', 'runtime-defaults'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(c, 'Resources', 'runtime-defaults', 'notes.md'),
      'text',
    )
    return app
  }

  it('signs innermost code first and the app last, each with its entitlements', () => {
    const app = fakeApp()
    const plan = hardening.macSigningPlan(app, entitlements)
    const rel = plan.map((entry) => entry.rel)
    expect(rel.at(-1)).toBe('.')
    const index = (name: string) => rel.indexOf(name)
    const framework = path.join(
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
    )
    for (const inner of [
      'Libraries/libEGL.dylib',
      'Helpers/chrome_crashpad_handler',
    ])
      expect(index(path.join(framework, 'Versions', 'A', inner))).toBeLessThan(
        index(framework),
      )
    expect(rel).toEqual(
      expect.arrayContaining([
        path.join(
          'Contents',
          'Library',
          'Helpers',
          'Emperor Computer Helper.app',
        ),
        path.join(
          'Contents',
          'Library',
          'Helpers',
          'Emperor Dictation Helper.app',
        ),
        path.join('Contents', 'Library', 'Helpers', 'emperor-nm-host'),
        path.join('Contents', 'Resources', 'native', 'credential-auth'),
        path.join('Contents', 'Resources', 'native', 'delegation-scan'),
      ]),
    )
    // Main executables are signed through their bundle; third-party code
    // in app.asar.unpacked is never re-signed.
    expect(rel.some((entry) => entry.includes('MacOS'))).toBe(false)
    expect(rel.some((entry) => entry.includes('app.asar.unpacked'))).toBe(false)
    const by = Object.fromEntries(
      plan.map((entry) => [entry.rel, entry.entitlements]),
    )
    expect(by['.']).toBe('/e/app.plist')
    expect(
      by[
        path.join(
          'Contents',
          'Frameworks',
          'Emperor Agent Helper (Renderer).app',
        )
      ],
    ).toBe('/e/helper.plist')
    expect(
      by[
        path.join(
          'Contents',
          'Library',
          'Helpers',
          'Emperor Dictation Helper.app',
        )
      ],
    ).toBe('/e/dictation.plist')
    for (const plain of [
      path.join(
        'Contents',
        'Library',
        'Helpers',
        'Emperor Computer Helper.app',
      ),
      path.join('Contents', 'Library', 'Helpers', 'emperor-nm-host'),
      framework,
    ])
      expect(by[plain]).toBeNull()
  })

  it('refuses code hidden outside the code locations', () => {
    const app = fakeApp()
    code(path.join(app, 'Contents', 'Resources', 'runtime-defaults', 'tool'))
    expect(() => hardening.macSigningPlan(app, entitlements)).toThrow(
      /outside its code locations: .*runtime-defaults/,
    )
  })

  it('ships entitlement files that say exactly what the seal check expects', () => {
    const keys = (file: string) =>
      [
        ...fs
          .readFileSync(file, 'utf8')
          .matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g),
      ]
        .map((match) => match[1])
        .sort()
    const build = path.join(desktopRoot, 'build')
    expect(keys(path.join(build, 'entitlements.preview.mac.plist'))).toEqual(
      hardening.expectedEntitlements('.'),
    )
    expect(
      keys(path.join(build, 'entitlements.preview.mac.inherit.plist')),
    ).toEqual(
      hardening.expectedEntitlements(
        path.join('Contents', 'Frameworks', 'Emperor Agent Helper (GPU).app'),
      ),
    )
    expect(
      keys(
        path.join(
          desktopRoot,
          'native',
          'macos',
          'scripts',
          'dictation-helper.entitlements',
        ),
      ),
    ).toEqual(
      hardening.expectedEntitlements(
        path.join(
          'Contents',
          'Library',
          'Helpers',
          'Emperor Dictation Helper.app',
        ),
      ),
    )
    for (const rel of [
      path.join(
        'Contents',
        'Library',
        'Helpers',
        'Emperor Computer Helper.app',
      ),
      path.join('Contents', 'Library', 'Helpers', 'emperor-nm-host'),
    ])
      expect(hardening.expectedEntitlements(rel)).toEqual([])
    for (const forbidden of hardening.FORBIDDEN_ENTITLEMENTS)
      for (const rel of [
        '.',
        path.join('Contents', 'Frameworks', 'X Helper.app'),
      ])
        expect(hardening.expectedEntitlements(rel)).not.toContain(forbidden)
    expect(hardening.APP_IDENTIFIER).toBe('com.emperor.agent.desktop')
    expect(hardening.CODESIGN).toBe('/usr/bin/codesign')
  })

  it('flips fuses before sealing, and every ad-hoc build signature has the runtime', () => {
    const afterPack = fs.readFileSync(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
      'utf8',
    )
    expect(afterPack.indexOf('await flipPackagedFuses(')).toBeGreaterThan(0)
    expect(afterPack.indexOf('await flipPackagedFuses(')).toBeLessThan(
      afterPack.indexOf('sealMacApp(app, PREVIEW_ENTITLEMENTS)'),
    )
    expect(afterPack).toContain('await verifyMacHardening(app)')
    expect(afterPack).not.toMatch(/['"]codesign['"]/)
    const read = (...parts: string[]) =>
      fs.readFileSync(path.join(desktopRoot, ...parts), 'utf8')
    for (const [file, line] of [
      [
        read('native', 'macos', 'scripts', 'assemble-app.sh'),
        'codesign --force --options runtime --sign - "$app"',
      ],
      [
        read('native', 'macos', 'scripts', 'assemble-dictation-app.sh'),
        'codesign --force --options runtime \\\n    --entitlements "$native_dir/scripts/dictation-helper.entitlements" \\\n    --sign - "$app"',
      ],
      [
        read('native', 'browser-host', 'build.sh'),
        'codesign --force --options runtime --sign - --timestamp=none "$output"',
      ],
      [
        read('scripts', 'build-native-mac.mjs'),
        "['-s', '-', '--force', '--options', 'runtime', output]",
      ],
    ])
      expect(file).toContain(line)
    expect(read('scripts', 'after-sign.cjs')).not.toMatch(
      /checked\(\s*['"](?:codesign|lipo)['"]/,
    )
  })

  it('declares @electron/fuses at an exact version, and the hardening probes', () => {
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(pkg.devDependencies['@electron/fuses']).toBe('1.8.0')
    expect(pkg.scripts['package:probe']).toBe(
      'node scripts/probe-packaged-hardening.cjs',
    )
    const probe = read('scripts/probe-packaged-hardening.cjs')
    // Every launch it makes uses a synthetic home and temp state.
    expect(probe).toContain('CFFIXED_USER_HOME: home')
    expect(probe).not.toMatch(/\.\.\.process\.env/)
    function read(file: string) {
      return fs.readFileSync(path.join(desktopRoot, file), 'utf8')
    }
  })
})
