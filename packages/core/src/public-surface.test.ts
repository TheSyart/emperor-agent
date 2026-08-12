import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coreOperationKeys } from '@emperor/core/api'
import { RUNTIME_EVENT_NAMES } from '@emperor/core/runtime-contract'
import {
  defaultEmperorHome,
  defaultStateRoot,
} from '@emperor/core/host-capabilities'

const sourceRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(sourceRoot, '..')

describe('controlled @emperor/core public surface', () => {
  it('publishes only the root compatibility facade and three owned subpaths', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { exports?: Record<string, string> }

    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
      '.',
      './api',
      './host-capabilities',
      './runtime-contract',
    ])
    expect(readFileSync(resolve(sourceRoot, 'index.ts'), 'utf8').trim()).toBe(
      [
        "export * from './public/api'",
        "export * from './public/runtime-contract'",
        "export * from './public/host-capabilities'",
      ].join('\n'),
    )
  })

  it('keeps public entrypoints explicit and removes retired implementations', () => {
    for (const entry of [
      'public/api.ts',
      'public/runtime-contract.ts',
      'public/host-capabilities.ts',
    ]) {
      const content = readFileSync(resolve(sourceRoot, entry), 'utf8')
      expect(content).not.toMatch(/export \* from/)
    }
    for (const retired of [
      'events/bus.ts',
      'hooks/runtime.ts',
      'store/file-lock.ts',
      'api/routes.ts',
    ])
      expect(existsSync(resolve(sourceRoot, retired)), retired).toBe(false)
  })

  it('resolves each controlled package subpath for a real consumer', () => {
    expect(coreOperationKeys()).toContain('bootstrap')
    expect(RUNTIME_EVENT_NAMES).toContain('assistant_done')
    expect(defaultEmperorHome()).toMatch(/\.emperor$/)
    expect(defaultStateRoot()).toBe(defaultEmperorHome())
  })
})
