/**
 * `--mode=contract`: the core driver contract cases (the same data the fake
 * driver passes) against the real embedded browser driver and the local
 * fixture site.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DRIVER_CONTRACT_CASES } from '../../../../packages/core/src/harness/computer-use/testing/driver-contract'
import { EmbeddedBrowserDriver } from '../../../src/main/computer-use/embedded-browser-driver'
import { electronBrowserFactory } from '../../../src/main/computer-use/electron-factory'
import { nativeImageCodec } from '../../../src/main/computer-use/images'
import { startFixtureSite } from '../fixtures/site'
import type { E2eResult } from './main'

export async function runContract(
  report: (result: E2eResult) => void,
): Promise<void> {
  const site = await startFixtureSite()
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: 'macos',
    downloadsRoot: join(
      mkdtempSync(join(tmpdir(), 'emperor-e2e-downloads-')),
      'downloads',
    ),
    pickFiles: async () => {
      const file = join(
        mkdtempSync(join(tmpdir(), 'emperor-e2e-upload-')),
        'notes.txt',
      )
      writeFileSync(file, 'fixture notes')
      return [file]
    },
    profilesRoot: join(
      mkdtempSync(join(tmpdir(), 'emperor-e2e-profiles-')),
      'profiles',
    ),
  })
  driver.setNavigationPolicy(() => 'allow')
  const only = process.env.E2E_ONLY
  try {
    for (const contract of DRIVER_CONTRACT_CASES) {
      if (only !== undefined && !contract.name.includes(only)) continue
      const started = Date.now()
      try {
        await contract.run({
          driver,
          url: (path) => new URL(path, site.origin).toString(),
          otherUrl: (path) => new URL(path, site.otherOrigin).toString(),
          features: { crossOriginFrames: true },
        })
        report({
          suite: 'contract',
          name: contract.name,
          ok: true,
          ms: Date.now() - started,
        })
      } catch (error) {
        report({
          suite: 'contract',
          name: contract.name,
          ok: false,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await driver.shutdown()
    await site.close()
  }
}
