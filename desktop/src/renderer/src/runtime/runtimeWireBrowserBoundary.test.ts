import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(__dirname, '..')
const useRuntimeSource = readFileSync(
  join(rendererRoot, 'composables/useRuntime.ts'),
  'utf8',
)
const dispatcherSource = readFileSync(
  join(__dirname, 'runtimeDispatcher.ts'),
  'utf8',
)
const runtimeContractPath = resolve(
  __dirname,
  '../../../../../packages/core/src/public/runtime-contract.ts',
)
const corePackage = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../packages/core/package.json'),
    'utf8',
  ),
) as { exports?: Record<string, string> }

describe('runtime wire browser boundary', () => {
  it('uses a browser-safe Core subpath for runtime values', () => {
    expect(corePackage.exports?.['./runtime-contract']).toBe(
      './src/public/runtime-contract.ts',
    )
    expect(useRuntimeSource).toContain("from '@emperor/core/runtime-contract'")
    expect(dispatcherSource).toContain("from '@emperor/core/runtime-contract'")
    expect(useRuntimeSource).not.toMatch(
      /import \{[^}]*isRuntimeEventWire[^}]*\} from '@emperor\/core'/s,
    )
    expect(dispatcherSource).not.toMatch(
      /import \{[^}]*RUNTIME_EVENT_NAMES[^}]*\} from '@emperor\/core'/s,
    )
    expect(readFileSync(runtimeContractPath, 'utf8')).not.toMatch(
      /from ['"](?:node:|zod)/,
    )
  })
})
