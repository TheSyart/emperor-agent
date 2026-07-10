import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
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
}

type AfterPackHook = (context: {
  appOutDir: string
  packager: {
    appInfo: { version: string; productFilename: string }
  }
}) => Promise<void>

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
    expect(
      fs.existsSync(path.join(desktopRoot, 'scripts', 'before-pack.cjs')),
    ).toBe(true)
    expect(
      fs.existsSync(path.join(desktopRoot, 'scripts', 'after-pack.cjs')),
    ).toBe(true)
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
    expect(generated.files.length).toBeGreaterThan(50)
    expect(generated.builtInSkills).toContain('skill-creator')
    expect(generated.files.every((file) => !path.isAbsolute(file.path))).toBe(
      true,
    )
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toContain(repoRoot)

    const afterPack = require(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
    ) as AfterPackHook
    await expect(
      afterPack({
        appOutDir,
        packager: {
          appInfo: { version: '0.1.0', productFilename: 'Emperor Agent' },
        },
      }),
    ).resolves.toBeUndefined()
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
