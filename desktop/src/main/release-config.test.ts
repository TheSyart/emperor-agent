import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { createPackage } from '@electron/asar'
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
  packager: {
    appInfo: { version: string; productFilename: string }
  }
}) => Promise<void>

interface PackagedResourceHook {
  validatePackagedAppResources(resourcesRoot: string): void
}

const petResourceFiles = [
  'event-mapper.js',
  'idle-scenes.js',
  'preload.js',
  'renderer.css',
  'renderer.html',
  'renderer.js',
]

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
    expect(config).toContain('from: ../assets/desktop-pet')
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
    ) as { scripts?: Record<string, string> }

    expect(pkg.scripts?.['package:smoke']).toBe(
      'node scripts/run-packaged-smoke.cjs',
    )
    expect(pkg.scripts?.['package:verify']).toContain('package:dir')
    expect(pkg.scripts?.['package:verify']).toContain('package:smoke')
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
    expect(generated.files.every((file) => !path.isAbsolute(file.path))).toBe(
      true,
    )
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toContain(repoRoot)

    fs.mkdirSync(path.join(appStage, 'out', 'main'), { recursive: true })
    fs.mkdirSync(path.join(appStage, 'out', 'preload'), { recursive: true })
    fs.mkdirSync(path.join(appStage, 'out', 'renderer'), { recursive: true })
    fs.writeFileSync(path.join(appStage, 'out', 'main', 'index.js'), 'void 0\n')
    fs.writeFileSync(
      path.join(appStage, 'out', 'preload', 'index.mjs'),
      'void 0\n',
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
      }),
    )
    await createPackage(appStage, path.join(appOutDir, 'resources', 'app.asar'))
    const petRoot = path.join(appOutDir, 'resources', 'desktop-pet')
    fs.mkdirSync(petRoot, { recursive: true })
    for (const file of petResourceFiles)
      fs.writeFileSync(path.join(petRoot, file), 'fixture\n')

    const afterPack = require(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
    ) as AfterPackHook & PackagedResourceHook
    await expect(
      afterPack({
        appOutDir,
        packager: {
          appInfo: { version: '0.1.0', productFilename: 'Emperor Agent' },
        },
      }),
    ).resolves.toBeUndefined()

    expect(() =>
      afterPack.validatePackagedAppResources(path.join(appOutDir, 'resources')),
    ).not.toThrow()
    fs.writeFileSync(path.join(petRoot, 'package.json'), '{}')
    expect(() =>
      afterPack.validatePackagedAppResources(path.join(appOutDir, 'resources')),
    ).toThrow(/desktop-pet/i)
    fs.rmSync(path.join(petRoot, 'package.json'))

    fs.writeFileSync(path.join(runtimeRoot, 'unexpected-after-pack.txt'), 'x')
    await expect(
      afterPack({
        appOutDir,
        packager: {
          appInfo: { version: '0.1.0', productFilename: 'Emperor Agent' },
        },
      }),
    ).rejects.toThrow(/does not match manifest/i)
  })
})
