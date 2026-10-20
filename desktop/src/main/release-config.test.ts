import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { createPackage, getRawHeader } from '@electron/asar'
import { validateRuntimeManifest } from '@emperor/core/host-capabilities'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const require = createRequire(import.meta.url)

interface RuntimeManifestHook {
  OS_METADATA_FILES: ReadonlySet<string>
  createRuntimeManifest(opts: {
    repoRoot: string
    appVersion: string
    outputPath: string
  }): {
    schemaVersion: number
    appVersion: string
    runtimeRevision: string
    builtInSkills: string[]
    files: Array<{ path: string; sha256: string; size: number }>
  }
  SOURCE_MAPPINGS: Array<{ source: string; target: string }>
  TEMPLATE_RUNTIME_FILES: string[]
}

type AfterPackHook = (context: {
  appOutDir: string
  electronPlatformName: string
  arch: string | number
  packager: {
    appInfo: { version: string; productFilename: string }
  }
}) => Promise<void>

interface PackagedResourceHook {
  validatePackagedAppResources(
    resourcesRoot: string,
    platform?: string,
    arch?: string,
  ): void
  targetNodePtyFiles(
    root: string,
    platform: string,
    arch: string,
  ): { binding: string; helper: string | null }
}

interface PreloadAudit {
  validatePetPreloadSource(value: string | Buffer): void
  validatePreloadSource(value: string | Buffer): void
  validateRecoveryPreloadSource(value: string | Buffer): void
}

const petResourceFiles = [
  'event-mapper.js',
  'idle-scenes.js',
  'preload.js',
  'renderer.css',
  'renderer.html',
  'renderer.js',
]

function regularFileBytes(root: string): number {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .reduce((total, entry) => {
      const target = path.join(root, entry.name)
      if (entry.isDirectory()) return total + regularFileBytes(target)
      if (entry.isFile()) return total + fs.statSync(target).size
      throw new Error(`unexpected ASAR fixture entry: ${target}`)
    }, 0)
}

async function waitForCompleteAsar(
  archivePath: string,
  payloadBytes: number,
): Promise<void> {
  const deadline = Date.now() + 2_000
  let expectedBytes = Number.POSITIVE_INFINITY
  do {
    try {
      const { headerSize } = getRawHeader(archivePath)
      expectedBytes = 8 + headerSize + payloadBytes
      if (fs.statSync(archivePath).size >= expectedBytes) return
    } catch {
      // @electron/asar 3.4.1 can resolve createPackage before its write stream
      // has flushed the header. Keep yielding until the deterministic size is met.
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  } while (Date.now() < deadline)
  throw new Error(
    `ASAR fixture did not finish writing: expected ${expectedBytes} bytes`,
  )
}

describe('macOS helper icons (RV-07)', () => {
  const scripts = path.join(desktopRoot, 'native', 'macos', 'scripts')
  const read = (name: string) =>
    fs.readFileSync(path.join(scripts, name), 'utf8')

  it('gives both helpers the icon before their bundle is sealed', () => {
    // Computer Use's own logo for its Helper (what macOS shows in the
    // permission lists); the Dictation Helper keeps Emperor's.
    const logo = 'assets/generated/plugin-logos/computer-use.png'
    expect(fs.existsSync(path.join(desktopRoot, '..', logo))).toBe(true)
    expect(read('assemble-app.sh')).toContain(
      `"$native_dir/scripts/helper-icon.sh" "$app/Contents/Resources/icon.icns" "$native_dir/../../../${logo}"`,
    )
    expect(read('assemble-dictation-app.sh')).toMatch(
      /"\$native_dir\/scripts\/helper-icon\.sh" "\$app\/Contents\/Resources\/icon\.icns"\n/,
    )
    for (const name of ['assemble-app.sh', 'assemble-dictation-app.sh']) {
      const script = read(name)
      expect(script, name).toContain(
        '"$native_dir/scripts/helper-icon.sh" "$app/Contents/Resources/icon.icns"',
      )
      expect(script, name).toContain(
        '<key>CFBundleIconFile</key><string>icon</string>',
      )
      expect(script.indexOf('helper-icon.sh'), name).toBeLessThan(
        script.indexOf('codesign --force'),
      )
    }
    const icon = read('helper-icon.sh')
    expect(icon).toContain('build/icon.png')
    expect(icon).toMatch(/\bsips\b/)
    expect(icon).toMatch(/\biconutil\b/)
  })

  it.runIf(process.platform === 'darwin')(
    'makes the icon from build/icon.png, and stops on a missing or broken image',
    () => {
      const script = path.join(scripts, 'helper-icon.sh')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-icon-'))
      const run = (...args: string[]) =>
        spawnSync('bash', [script, ...args], { encoding: 'utf8' })
      try {
        const output = path.join(dir, 'Resources', 'icon.icns')
        const made = run(output)
        expect(made.status, made.stderr).toBe(0)
        const bytes = fs.readFileSync(output)
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('icns')
        expect(bytes.byteLength).toBeGreaterThan(10_000)

        const missing = path.join(dir, 'missing.icns')
        expect(run(missing, path.join(dir, 'nothing.png')).status).not.toBe(0)
        expect(fs.existsSync(missing)).toBe(false)
        fs.writeFileSync(path.join(dir, 'broken.png'), 'not an image')
        const broken = path.join(dir, 'broken.icns')
        const failed = run(broken, path.join(dir, 'broken.png'))
        expect(failed.status).not.toBe(0)
        expect(failed.stderr).toMatch(/helper-icon/)
        expect(fs.existsSync(broken)).toBe(false)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('names the fixture stand-in, gives it the icon, and has LaunchServices forget it', () => {
    const script = read('fixture-integration.sh')
    // The helper checks its parent's bundle ID, so the stand-in keeps it.
    expect(script).toContain(
      '<key>CFBundleIdentifier</key><string>com.emperor.agent.desktop</string>',
    )
    expect(script).toContain(
      '<key>CFBundleDisplayName</key><string>Emperor Agent（测试替身）</string>',
    )
    expect(script).toContain('<key>CFBundleIconFile</key><string>icon</string>')
    expect(script).toContain(
      '"$native_dir/scripts/helper-icon.sh" "$main_app/Contents/Resources/icon.icns"',
    )
    expect(script.indexOf('helper-icon.sh')).toBeLessThan(
      script.indexOf('codesign --force --options runtime'),
    )
    // Every exit, an error or ⌃C included, unregisters the stand-in.
    expect(script).toMatch(/"\$lsregister" -u "\$main_app"/)
    expect(script).toMatch(/\ntrap cleanup EXIT\n/)
    expect(script).toMatch(/\ntrap 'exit 130' INT\n/)
    expect(script).toMatch(/\ntrap 'exit 143' TERM\n/)
    expect(script.indexOf('main_app=')).toBeLessThan(
      script.indexOf('trap cleanup EXIT'),
    )
  })

  it('has LaunchServices forget the socket smoke copies before they are deleted', () => {
    const script = read('socket-smoke.sh')
    for (const bundle of [
      '$fixture/Emperor Agent.app',
      '$fixture/Emperor Agent.app/Contents/Library/Helpers/Emperor Computer Helper.app',
      '$fixture/helper-build/Emperor Computer Helper.app',
    ])
      expect(script).toContain(`"${bundle}"`)
    expect(script).toMatch(/"\$lsregister" -u "\$bundle"/)
    expect(script.indexOf('"$lsregister" -u')).toBeLessThan(
      script.indexOf('rm -rf "$fixture"'),
    )
    expect(script).toMatch(/\ntrap cleanup EXIT\n/)
  })
})

describe('desktop release packaging (MIG-REL-001)', () => {
  it('says why dictation needs the microphone and speech recognition', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    expect(config).toMatch(
      /extendInfo:\r?\n\s+NSMicrophoneUsageDescription: \S/,
    )
    expect(config).toMatch(/\n\s+NSSpeechRecognitionUsageDescription: \S/)
    for (const file of [
      'entitlements.mac.plist',
      'entitlements.mac.inherit.plist',
    ])
      expect(
        fs.readFileSync(path.join(desktopRoot, 'build', file), 'utf8'),
      ).toMatch(
        /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
      )
    const assemble = fs.readFileSync(
      path.join(
        desktopRoot,
        'native',
        'macos',
        'scripts',
        'assemble-dictation-app.sh',
      ),
      'utf8',
    )
    expect(assemble).toContain('com.emperor.agent.desktop.dictation-helper')
    expect(assemble).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(assemble).toContain('<key>NSSpeechRecognitionUsageDescription</key>')
    expect(
      fs.readFileSync(
        path.join(desktopRoot, 'scripts', 'build-native-mac.mjs'),
        'utf8',
      ),
    ).toContain('assemble-dictation-app.sh')
  })

  it('lays out the DMG window on the brand background (UI-S12)', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    const dmg = config.slice(config.indexOf('\ndmg:'), config.indexOf('\nwin:'))
    expect(dmg).toContain('  background: build/background.tiff')
    expect(dmg).toMatch(/window:\r?\n\s+width: 660\r?\n\s+height: 400/)
    expect(dmg).toMatch(/- x: 165\r?\n\s+y: 185\r?\n\s+type: file/)
    expect(dmg).toMatch(
      /- x: 495\r?\n\s+y: 185\r?\n\s+type: link\r?\n\s+path: \/Applications/,
    )
    // One TIFF carries both scales, so Retina Finder windows stay sharp.
    const tiff = fs.readFileSync(
      path.join(desktopRoot, 'build', 'background.tiff'),
    )
    expect(tiff.subarray(0, 4).toString('latin1')).toMatch(/^(MM\0\*|II\*\0)$/)
    const info = spawnSync(
      'tiffutil',
      ['-info', path.join(desktopRoot, 'build', 'background.tiff')],
      {
        encoding: 'utf8',
      },
    )
    if (info.status === 0) {
      expect(info.stdout).toContain('Image Width: 660 Image Length: 400')
      expect(info.stdout).toContain('Image Width: 1320 Image Length: 800')
    }
  })

  it('uses the 1024px brand icon for the app bundle', () => {
    const icon = fs.readFileSync(path.join(desktopRoot, 'build', 'icon.png'))
    expect(icon.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(icon.readUInt32BE(16)).toBe(1024)
    expect(icon.readUInt32BE(20)).toBe(1024)
  })

  it('ships the Chrome/Edge extension on macOS, without its tests', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    const mac = config.slice(config.indexOf('\nmac:'), config.indexOf('\nwin:'))
    // Settings copies it into ~/.emperor/browser-extension for Chrome to load.
    expect(mac).toContain(
      [
        '    - from: extension',
        '      to: browser-extension',
        '      filter:',
        "        - '**/*'",
        "        - '!tests{,/**/*}'",
        "        - '!README.md'",
        "        - '!**/.*'",
      ].join('\n'),
    )
    expect(config.slice(0, config.indexOf('\nmac:'))).not.toContain(
      'browser-extension',
    )
  })

  it('does not bundle the legacy Python backend by default', () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )

    expect(config).not.toContain('build/backend')
    expect(config).not.toContain('to: backend')
    expect(config).toContain('runtime-defaults')
    expect(config).toContain('beforePack: scripts/before-pack.cjs')
    expect(config).toContain('afterPack: scripts/after-pack.cjs')
    expect(config).toContain('afterSign: scripts/after-sign.cjs')
    expect(config).toContain('runtime-defaults-manifest.json')
    expect(config).toContain('!node_modules{,/**/*}')
    expect(config).toContain('node_modules/typescript/package.json')
    expect(config).toContain('node_modules/typescript/lib/typescript.js')
    expect(config).toContain('node_modules/node-pty/package.json')
    expect(config).toContain('node_modules/node-pty/lib/**/*.js')
    expect(config).toContain("'!node_modules/node-pty/lib/**/*.test.js'")
    expect(config).toContain('node_modules/node-pty/prebuilds/**/*')
    expect(config).toContain('node_modules/node-pty/build/Release/**/*')
    expect(config).toContain('from: out/native/Emperor Computer Helper.app')
    expect(config).toContain('from: out/native/emperor-nm-host')
    expect(config).toContain('from: out/native/Emperor Dictation Helper.app')
    expect(config).not.toContain('node_modules/node-pty/**/*')
    expect(config).toContain('from: ../assets/desktop-pet')
    expect(config).toContain(
      'from: ../config/examples/model_config.example.json',
    )
    expect(config).toContain('from: ../config/examples/mcp_config.example.json')
    expect(config).not.toMatch(/from:\s+\.\.\/model_config\.example\.json/)
    expect(config).not.toMatch(/from:\s+\.\.\/mcp_config\.example\.json/)
    expect(config).toMatch(
      /linux:\r?\n(?:[ \t].*\r?\n)*[ \t]+executableName: emperor-agent/m,
    )
    expect(config).not.toMatch(/from:\s+\.\.\/assets\s*$/m)
    expect(
      fs.existsSync(path.join(desktopRoot, 'scripts', 'before-pack.cjs')),
    ).toBe(true)
    expect(
      fs.existsSync(path.join(desktopRoot, 'scripts', 'after-pack.cjs')),
    ).toBe(true)
  })

  it('defines a packaged smoke command instead of treating package:dir as proof', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const viteConfig = fs.readFileSync(
      path.join(desktopRoot, 'electron.vite.config.ts'),
      'utf8',
    )

    expect(pkg.scripts?.['package:smoke']).toBe(
      'node scripts/run-packaged-smoke.cjs',
    )
    expect(pkg.scripts?.['package:dir']).toContain(
      '--config electron-builder.preview.cjs',
    )
    expect(pkg.scripts?.['package:verify']).toContain('package:dir')
    expect(pkg.scripts?.['package:verify']).toContain('package:smoke')
    expect(pkg.dependencies?.typescript).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.devDependencies?.typescript).toBeUndefined()
    expect(viteConfig).toContain('externalizeDepsPlugin')
    expect(viteConfig).toContain("include: ['typescript', 'node-pty']")
    expect(pkg.scripts?.['terminal:smoke']).toContain('smoke-node-pty.cjs')
    expect(pkg.scripts?.build).toContain('node scripts/audit-preload.cjs')
  })

  it("8. ships only the build architecture's Claude SDK binary (AGT-01)", () => {
    const config = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    )
    // electron-builder expands ${arch} per build, so an arm64 package never
    // picks up an installed x64 binary (or the reverse).
    expect(config).toContain(
      '  - node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude',
    )
    expect(config).not.toMatch(/claude-agent-sdk-\*/)
    const hook = require(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
    ) as {
      isAllowedNodeModuleEntry(
        entry: string,
        platform: string,
        arch: string,
      ): boolean
      validatePackagedClaudeSdk(
        resourcesRoot: string,
        entries: string[],
        platform: string,
        arch: string,
      ): void
    }
    const sdk = '/node_modules/@anthropic-ai/claude-agent-sdk'
    const binary = (arch: string) =>
      `/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`
    expect(
      hook.isAllowedNodeModuleEntry(binary('arm64'), 'darwin', 'arm64'),
    ).toBe(true)
    expect(
      hook.isAllowedNodeModuleEntry(binary('x64'), 'darwin', 'arm64'),
    ).toBe(false)
    expect(
      hook.isAllowedNodeModuleEntry(
        sdk + '/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude',
        'darwin',
        'arm64',
      ),
    ).toBe(false)
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-claude-sdk-'))
    try {
      const entries = [
        sdk,
        sdk + '/package.json',
        sdk + '/sdk.mjs',
        sdk + '/manifest.json',
      ]
      const unpacked = (arch: string) =>
        path.join(
          temp,
          'app.asar.unpacked',
          'node_modules',
          '@anthropic-ai',
          `claude-agent-sdk-darwin-${arch}`,
        )
      for (const arch of ['arm64', 'x64']) {
        fs.mkdirSync(unpacked(arch), { recursive: true })
        fs.writeFileSync(path.join(unpacked(arch), 'claude'), 'native', {
          mode: 0o755,
        })
      }
      const validate = () =>
        hook.validatePackagedClaudeSdk(temp, entries, 'darwin', 'arm64')
      expect(validate).toThrow(/darwin-x64/)
      fs.rmSync(unpacked('x64'), { recursive: true })
      expect(validate).not.toThrow()
      fs.chmodSync(path.join(unpacked('arm64'), 'claude'), 0o644)
      expect(validate).toThrow(/not executable/)
      fs.rmSync(unpacked('arm64'), { recursive: true })
      expect(validate).toThrow(/darwin-arm64/)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('selects the node-pty runtime for every supported package target', () => {
    const hook = require(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
    ) as PackagedResourceHook

    expect(hook.targetNodePtyFiles('/native', 'darwin', 'arm64')).toEqual({
      binding: path.join('/native', 'prebuilds', 'darwin-arm64', 'pty.node'),
      helper: path.join('/native', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    })
    expect(hook.targetNodePtyFiles('/native', 'win32', 'x64')).toEqual({
      binding: path.join('/native', 'prebuilds', 'win32-x64', 'pty.node'),
      helper: null,
    })
    // node-pty builds spawn-helper for macOS only.
    expect(hook.targetNodePtyFiles('/native', 'linux', 'x64')).toEqual({
      binding: path.join('/native', 'build', 'Release', 'pty.node'),
      helper: null,
    })
  })

  it('rejects inconsistent Computer Use signatures and wrong helper architecture', () => {
    const signing = require(
      path.join(desktopRoot, 'scripts', 'after-sign.cjs'),
    ) as {
      validateMacSignatureEntries: (
        entries: Array<{
          label: string
          architectures: string[]
          teamId: string | null
          authority: string | null
          adHoc: boolean
        }>,
        arch: string,
      ) => void
    }
    const entries = [
      'app',
      'Electron Framework',
      'Computer Helper',
      'Dictation Helper',
      'Native Messaging host',
      'credential-auth',
    ].map((label) => ({
      label,
      architectures: ['arm64'],
      teamId: 'ABCDE12345',
      authority: 'Apple Distribution: Example Developer (ABCDE12345)',
      adHoc: false,
    }))
    expect(() =>
      signing.validateMacSignatureEntries(entries, 'arm64'),
    ).not.toThrow()
    expect(() =>
      signing.validateMacSignatureEntries(
        entries.map((entry) =>
          entry.label === 'Computer Helper'
            ? { ...entry, authority: 'Apple Development: different' }
            : entry,
        ),
        'arm64',
      ),
    ).toThrow(/signing identity/i)
    expect(() =>
      signing.validateMacSignatureEntries(
        entries.map((entry) =>
          entry.label === 'Native Messaging host'
            ? { ...entry, architectures: ['x86_64'] }
            : entry,
        ),
        'arm64',
      ),
    ).toThrow(/architecture/i)
    expect(() =>
      signing.validateMacSignatureEntries(
        entries.map((entry) => ({ ...entry, architectures: ['x86_64'] })),
        'x64',
      ),
    ).not.toThrow()
  })

  it('rejects ESM, Node builtins and oversized sandbox preload bundles', () => {
    const audit = require(
      path.join(desktopRoot, 'scripts', 'audit-preload.cjs'),
    ) as PreloadAudit
    expect(() =>
      audit.validatePreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).not.toThrow()
    expect(() =>
      audit.validatePreloadSource(
        'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).toThrow(/CommonJS/i)
    expect(() =>
      audit.validatePreloadSource(
        'const fs=require("node:fs"); const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).toThrow(/forbidden module/i)
    expect(() =>
      audit.validatePreloadSource(
        `const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {});${'x'.repeat(70 * 1024)}`,
      ),
    ).toThrow(/size/i)
    expect(() =>
      audit.validatePetPreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperorPet", {})',
      ),
    ).not.toThrow()
    expect(() =>
      audit.validatePetPreloadSource(
        'const fs=require("fs"); const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperorPet", {})',
      ),
    ).toThrow(/forbidden module/i)
    expect(() =>
      audit.validateRecoveryPreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperorRecovery", {})',
      ),
    ).not.toThrow()
    expect(() =>
      audit.validateRecoveryPreloadSource(
        'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})',
      ),
    ).toThrow(/emperorRecovery/i)
  })

  it('runs the packaged binary headlessly with a minimal non-shell environment', () => {
    const runner = fs.readFileSync(
      path.join(desktopRoot, 'scripts', 'run-packaged-smoke.cjs'),
      'utf8',
    )

    expect(runner).toContain("args.unshift('--headless'")
    expect(runner).toContain("args.unshift('--no-sandbox')")
    expect(runner).not.toContain('process.getuid')
    expect(runner).toContain('shell: false')
    expect(runner).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)
    expect(runner).toContain('PATH: emptyBin')
    // Secrets need no Keychain: macOS runs with the synthetic HOME too.
    expect(runner).toMatch(/\n\s+HOME: homeRoot,\n/)
    expect(runner).not.toContain('process.env.HOME || homeRoot')
    expect(runner).toContain("APPDATA: join(homeRoot, 'AppData', 'Roaming')")
    expect(runner).toContain("LOCALAPPDATA: join(homeRoot, 'AppData', 'Local')")
    expect(runner).toContain('TEMP: tempRoot')
    expect(runner).toContain('TMP: tempRoot')
  })

  it('build_desktop_release does not require the Python backend bundle', () => {
    const script = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'build_desktop_release.sh'),
      'utf8',
    )

    expect(
      fs.existsSync(path.join(repoRoot, 'scripts', 'build_backend_bundle.sh')),
    ).toBe(false)
    expect(script).not.toContain('build_backend_bundle.sh')
    expect(script).not.toContain('PYTHON_BIN')
  })

  it('generates and afterPack-validates the final resource tree', async () => {
    const hook = require(
      path.join(desktopRoot, 'scripts', 'before-pack.cjs'),
    ) as RuntimeManifestHook
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), 'emperor-runtime-package-'),
    )
    const appOutDir = path.join(temp, 'app-out')
    const runtimeRoot = path.join(appOutDir, 'resources', 'runtime-defaults')
    const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json')
    const appStage = path.join(temp, 'app-stage')

    for (const mapping of hook.SOURCE_MAPPINGS) {
      const source = path.join(repoRoot, mapping.source)
      const destination = path.join(runtimeRoot, mapping.target)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      // Like electron-builder, the packaged tree never carries OS metadata files.
      fs.cpSync(source, destination, {
        recursive: true,
        filter: (file) => !hook.OS_METADATA_FILES.has(path.basename(file)),
      })
    }
    const generated = hook.createRuntimeManifest({
      repoRoot,
      appVersion: '0.1.0',
      outputPath: manifestPath,
    })
    const validated = validateRuntimeManifest(runtimeRoot, {
      expectedAppVersion: '0.1.0',
    })

    expect(validated).toEqual(generated)
    // Every desktop-pet frame strip ships: the pet window loads them by name.
    const petStrips = fs
      .readdirSync(path.join(repoRoot, 'assets', 'desktop-pet', 'xiaodan'))
      .filter((file) => file.endsWith('.webp'))
    expect(petStrips.length).toBeGreaterThan(0)
    const packagedPaths = new Set(generated.files.map((file) => file.path))
    for (const strip of petStrips)
      expect(packagedPaths).toContain(`assets/desktop-pet/xiaodan/${strip}`)
    // computer-use lives in its managed plugin now (plugin contract §5).
    expect(generated.builtInSkills).toEqual(['skill-creator'])
    // Plugins shipped with Emperor ride along, hash-checked like every file.
    expect(hook.SOURCE_MAPPINGS).toContainEqual({
      source: 'packages/core/bundled-plugins',
      target: 'bundled-plugins',
    })
    expect(
      fs.readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8'),
    ).toContain(
      '- from: ../packages/core/bundled-plugins\n    to: runtime-defaults/bundled-plugins',
    )
    expect(packagedPaths).toContain('bundled-plugins/github/plugin.json')
    expect(packagedPaths).toContain('bundled-plugins/computer-use/plugin.json')
    for (const file of [
      'bundled-plugins/computer-use/.app.json',
      'bundled-plugins/computer-use/skills/computer-use/SKILL.md',
      'bundled-plugins/github/.app.json',
      'bundled-plugins/github/skills/github/SKILL.md',
    ])
      expect(packagedPaths).toContain(file)
    expect(
      generated.files
        .filter((file) => file.path.startsWith('skills/'))
        .map((file) => file.path),
    ).toEqual(['skills/skill-creator/SKILL.md'])
    expect(generated.files.some((file) => file.path.endsWith('.py'))).toBe(
      false,
    )
    expect(
      generated.files.some(
        (file) =>
          file.path.endsWith('.local.md') ||
          file.path === 'templates/USER.local.md',
      ),
    ).toBe(false)
    expect(
      generated.files
        .filter((file) => file.path.startsWith('templates/'))
        .map((file) => file.path.slice('templates/'.length)),
    ).toEqual([...hook.TEMPLATE_RUNTIME_FILES].sort())
    for (const template of hook.TEMPLATE_RUNTIME_FILES)
      expect(
        fs.readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8'),
      ).toContain(`- ${template}`)
    expect(hook.SOURCE_MAPPINGS).toEqual(
      expect.arrayContaining([
        {
          source: 'config/examples/model_config.example.json',
          target: 'model_config.example.json',
        },
        {
          source: 'config/examples/mcp_config.example.json',
          target: 'mcp_config.example.json',
        },
      ]),
    )
    expect(generated.files.every((file) => !path.isAbsolute(file.path))).toBe(
      true,
    )
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toContain(repoRoot)

    fs.mkdirSync(path.join(appStage, 'out', 'main'), { recursive: true })
    fs.mkdirSync(path.join(appStage, 'out', 'preload'), { recursive: true })
    fs.mkdirSync(path.join(appStage, 'out', 'renderer'), { recursive: true })
    fs.writeFileSync(path.join(appStage, 'out', 'main', 'index.js'), 'void 0\n')
    fs.writeFileSync(
      path.join(appStage, 'out', 'preload', 'index.cjs'),
      'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperor", {})\n',
    )
    fs.writeFileSync(
      path.join(appStage, 'out', 'preload', 'recovery.cjs'),
      'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperorRecovery", {})\n',
    )
    fs.writeFileSync(
      path.join(appStage, 'out', 'renderer', 'index.html'),
      '<!doctype html>\n',
    )
    fs.writeFileSync(
      path.join(appStage, 'package.json'),
      JSON.stringify({
        name: 'emperor-agent-desktop',
        main: 'out/main/index.js',
        dependencies: { typescript: '5.9.3', 'node-pty': '1.1.0' },
      }),
    )
    const parserStage = path.join(appStage, 'node_modules', 'typescript', 'lib')
    fs.mkdirSync(parserStage, { recursive: true })
    fs.copyFileSync(
      path.join(desktopRoot, 'node_modules', 'typescript', 'package.json'),
      path.join(appStage, 'node_modules', 'typescript', 'package.json'),
    )
    fs.copyFileSync(
      path.join(
        desktopRoot,
        'node_modules',
        'typescript',
        'lib',
        'typescript.js',
      ),
      path.join(parserStage, 'typescript.js'),
    )
    const ptyStage = path.join(appStage, 'node_modules', 'node-pty')
    fs.mkdirSync(path.join(ptyStage, 'lib'), { recursive: true })
    fs.copyFileSync(
      path.join(desktopRoot, 'node_modules', 'node-pty', 'package.json'),
      path.join(ptyStage, 'package.json'),
    )
    fs.writeFileSync(
      path.join(ptyStage, 'lib', 'index.js'),
      'module.exports={};\n',
    )
    // AGT-01: the Agent SDK in the archive, this architecture's Claude
    // binary unpacked beside it.
    const sdkStage = path.join(
      appStage,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
    )
    fs.mkdirSync(sdkStage, { recursive: true })
    for (const file of ['package.json', 'sdk.mjs', 'manifest.json'])
      fs.writeFileSync(path.join(sdkStage, file), '{}\n')
    const claudeUnpacked = path.join(
      appOutDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-darwin-arm64',
    )
    fs.mkdirSync(claudeUnpacked, { recursive: true })
    fs.writeFileSync(path.join(claudeUnpacked, 'claude'), 'native-fixture', {
      mode: 0o755,
    })
    const asarPath = path.join(appOutDir, 'resources', 'app.asar')
    const payloadBytes = regularFileBytes(appStage)
    await createPackage(appStage, asarPath)
    await waitForCompleteAsar(asarPath, payloadBytes)
    const ptyUnpacked = path.join(
      appOutDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'prebuilds',
      'darwin-arm64',
    )
    fs.mkdirSync(ptyUnpacked, { recursive: true })
    fs.writeFileSync(path.join(ptyUnpacked, 'pty.node'), 'native-fixture')
    fs.writeFileSync(path.join(ptyUnpacked, 'spawn-helper'), 'helper', {
      mode: 0o755,
    })
    const petRoot = path.join(appOutDir, 'resources', 'desktop-pet')
    fs.mkdirSync(petRoot, { recursive: true })
    for (const file of petResourceFiles)
      fs.writeFileSync(
        path.join(petRoot, file),
        file === 'preload.js'
          ? 'const electron=require("electron"); electron.contextBridge.exposeInMainWorld("emperorPet", {})\n'
          : 'fixture\n',
      )
    const authRoot = path.join(appOutDir, 'resources', 'native')
    fs.mkdirSync(authRoot, { recursive: true })
    fs.writeFileSync(path.join(authRoot, 'credential-auth'), 'native-fixture', {
      mode: 0o755,
    })
    const helper = path.join(
      appOutDir,
      'Library',
      'Helpers',
      'Emperor Computer Helper.app',
      'Contents',
    )
    fs.mkdirSync(path.join(helper, 'MacOS'), { recursive: true })
    // RV-07: each helper carries Emperor's icon (an .icns starts with "icns").
    const iconKey = '<key>CFBundleIconFile</key><string>icon</string>'
    const icon = Buffer.concat([Buffer.from('icns'), Buffer.alloc(28)])
    const helperInfo = [
      '<string>com.emperor.agent.desktop.computer-helper</string>',
      iconKey,
    ].join('\n')
    fs.writeFileSync(path.join(helper, 'Info.plist'), helperInfo)
    fs.mkdirSync(path.join(helper, 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(helper, 'Resources', 'icon.icns'), icon)
    fs.writeFileSync(
      path.join(helper, 'MacOS', 'emperor-computer-helper'),
      'native-fixture',
      { mode: 0o755 },
    )
    const dictation = path.join(
      appOutDir,
      'Library',
      'Helpers',
      'Emperor Dictation Helper.app',
      'Contents',
    )
    fs.mkdirSync(path.join(dictation, 'MacOS'), { recursive: true })
    const dictationInfo = [
      '<string>com.emperor.agent.desktop.dictation-helper</string>',
      '<key>NSMicrophoneUsageDescription</key>',
      '<key>NSSpeechRecognitionUsageDescription</key>',
      iconKey,
    ].join('\n')
    fs.writeFileSync(path.join(dictation, 'Info.plist'), dictationInfo)
    fs.mkdirSync(path.join(dictation, 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(dictation, 'Resources', 'icon.icns'), icon)
    fs.writeFileSync(
      path.join(dictation, 'MacOS', 'emperor-dictation-helper'),
      'native-fixture',
      { mode: 0o755 },
    )
    const messagingHost = path.join(
      appOutDir,
      'Library',
      'Helpers',
      'emperor-nm-host',
    )
    fs.writeFileSync(messagingHost, 'native-fixture', { mode: 0o755 })
    // The extension as the yml filter ships it: no tests, no README.
    const extensionRoot = path.join(appOutDir, 'resources', 'browser-extension')
    fs.cpSync(path.join(desktopRoot, 'extension'), extensionRoot, {
      recursive: true,
      filter: (file) => {
        const inside = path.relative(path.join(desktopRoot, 'extension'), file)
        return (
          inside.split(path.sep)[0] !== 'tests' &&
          inside !== 'README.md' &&
          !path.basename(file).startsWith('.')
        )
      },
    })

    const afterPack = require(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
    ) as AfterPackHook & PackagedResourceHook
    // SEC-04: after-pack flips the fuses of Electron's binary; a stand-in
    // with Electron 42's nine-fuse wire (all defaults).
    const fuseHost = path.join(
      appOutDir,
      'Emperor Agent.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    )
    fs.mkdirSync(path.dirname(fuseHost), { recursive: true })
    fs.writeFileSync(
      fuseHost,
      Buffer.concat([
        Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
        Buffer.from([1, 9]),
        Buffer.from('101100011'),
      ]),
    )
    await expect(
      afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        arch: 3,
        packager: {
          appInfo: { version: '0.1.0', productFilename: 'Emperor Agent' },
        },
      }),
    ).resolves.toBeUndefined()
    expect(fs.readFileSync(fuseHost).subarray(34).toString()).toBe('000011001')

    expect(() =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      ),
    ).not.toThrow()
    fs.rmSync(messagingHost)
    expect(() =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      ),
    ).toThrow(/allowlist/i)
    fs.writeFileSync(messagingHost, 'native-fixture', { mode: 0o755 })
    // The dictation helper must keep both usage strings.
    fs.writeFileSync(
      path.join(dictation, 'Info.plist'),
      '<string>com.emperor.agent.desktop.dictation-helper</string>',
    )
    expect(() =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      ),
    ).toThrow(/dictation helper/i)
    fs.writeFileSync(path.join(dictation, 'Info.plist'), dictationInfo)
    // RV-07: without an icon macOS shows a blank one in permission prompts.
    const validate = () =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      )
    fs.rmSync(path.join(dictation, 'Resources', 'icon.icns'))
    expect(validate).toThrow(/dictation helper icon/i)
    fs.writeFileSync(path.join(dictation, 'Resources', 'icon.icns'), 'PNG')
    expect(validate).toThrow(/dictation helper icon/i)
    fs.writeFileSync(path.join(dictation, 'Resources', 'icon.icns'), icon)
    fs.writeFileSync(
      path.join(helper, 'Info.plist'),
      '<string>com.emperor.agent.desktop.computer-helper</string>',
    )
    expect(validate).toThrow(/Computer Use helper icon/i)
    fs.writeFileSync(path.join(helper, 'Info.plist'), helperInfo)
    expect(validate).not.toThrow()
    const strayHelper = path.join(appOutDir, 'Library', 'Helpers', 'unexpected')
    fs.writeFileSync(strayHelper, 'x')
    expect(() =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      ),
    ).toThrow(/allowlist/i)
    fs.rmSync(strayHelper)
    // The packaged extension: no test files, a real manifest, no symlinks.
    fs.mkdirSync(path.join(extensionRoot, 'tests'))
    fs.writeFileSync(path.join(extensionRoot, 'tests', 'worker.test.js'), '')
    expect(validate).toThrow(/browser-extension/i)
    fs.rmSync(path.join(extensionRoot, 'tests'), { recursive: true })
    fs.renameSync(
      path.join(extensionRoot, 'manifest.json'),
      path.join(temp, 'manifest.json'),
    )
    expect(validate).toThrow(/browser-extension/i)
    fs.renameSync(
      path.join(temp, 'manifest.json'),
      path.join(extensionRoot, 'manifest.json'),
    )
    // The worker imports agent.js (RV-09): a build without it must fail.
    fs.renameSync(
      path.join(extensionRoot, 'agent.js'),
      path.join(temp, 'agent.js'),
    )
    expect(validate).toThrow(/agent\.js/)
    fs.renameSync(
      path.join(temp, 'agent.js'),
      path.join(extensionRoot, 'agent.js'),
    )
    fs.symlinkSync('/etc/hosts', path.join(extensionRoot, 'hosts.js'))
    expect(validate).toThrow(/browser-extension/i)
    fs.rmSync(path.join(extensionRoot, 'hosts.js'))
    expect(validate).not.toThrow()
    fs.writeFileSync(path.join(petRoot, 'package.json'), '{}')
    expect(() =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      ),
    ).toThrow(/desktop-pet/i)
    fs.rmSync(path.join(petRoot, 'package.json'))

    fs.writeFileSync(path.join(runtimeRoot, 'unexpected-after-pack.txt'), 'x')
    await expect(
      afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        arch: 3,
        packager: {
          appInfo: { version: '0.1.0', productFilename: 'Emperor Agent' },
        },
      }),
    ).rejects.toThrow(/does not match manifest/i)
  })
})
