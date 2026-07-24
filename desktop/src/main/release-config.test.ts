import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { createPackage, getRawHeader } from '@electron/asar'
import { validateRuntimeManifest } from '@emperor/core'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const require = createRequire(import.meta.url)

interface RuntimeManifestHook {
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

describe('desktop release packaging (MIG-REL-001)', () => {
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
    expect(config).toContain('runtime-defaults-manifest.json')
    expect(config).toContain('!node_modules{,/**/*}')
    expect(config).toContain('node_modules/typescript/package.json')
    expect(config).toContain('node_modules/typescript/lib/typescript.js')
    expect(config).toContain('node_modules/node-pty/package.json')
    expect(config).toContain('node_modules/node-pty/lib/**/*.js')
    expect(config).toContain("'!node_modules/node-pty/lib/**/*.test.js'")
    expect(config).toContain('node_modules/node-pty/prebuilds/**/*')
    expect(config).toContain('node_modules/node-pty/build/Release/**/*')
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
    expect(pkg.scripts?.['package:verify']).toContain('package:dir')
    expect(pkg.scripts?.['package:verify']).toContain('package:smoke')
    expect(pkg.dependencies?.typescript).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.devDependencies?.typescript).toBeUndefined()
    expect(viteConfig).toContain('externalizeDepsPlugin')
    expect(viteConfig).toContain("include: ['typescript', 'node-pty']")
    expect(pkg.scripts?.['terminal:smoke']).toContain('smoke-node-pty.cjs')
    expect(pkg.scripts?.build).toContain('node scripts/audit-preload.cjs')
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
    expect(hook.targetNodePtyFiles('/native', 'linux', 'x64')).toEqual({
      binding: path.join('/native', 'build', 'Release', 'pty.node'),
      helper: path.join('/native', 'build', 'Release', 'spawn-helper'),
    })
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
      fs.cpSync(source, destination, { recursive: true })
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
    expect(generated.files.length).toBeGreaterThan(30)
    expect(generated.builtInSkills).toEqual(['skill-creator'])
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
    expect(
      hook.SOURCE_MAPPINGS.some((mapping) =>
        mapping.source.includes('skills-catalog'),
      ),
    ).toBe(false)
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

    const afterPack = require(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
    ) as AfterPackHook & PackagedResourceHook
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

    expect(() =>
      afterPack.validatePackagedAppResources(
        path.join(appOutDir, 'resources'),
        'darwin',
        'arm64',
      ),
    ).not.toThrow()
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
