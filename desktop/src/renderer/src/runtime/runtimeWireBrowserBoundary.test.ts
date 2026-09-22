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
const sessionEventTypesPath = resolve(
  __dirname,
  '../../../../../packages/core/src/public/session-event-types.ts',
)
const sessionsApiSource = readFileSync(
  join(rendererRoot, 'api/sessions.ts'),
  'utf8',
)
const backendApiSource = readFileSync(
  join(rendererRoot, 'api/backend.ts'),
  'utf8',
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

  it('exposes session-log types to the renderer as type-only exports', () => {
    const contract = readFileSync(runtimeContractPath, 'utf8')
    // Every re-export of the session-event vocabulary is `export type`.
    expect(contract).toMatch(
      /export type \{[^}]*\bSessionEvent\b[^}]*\} from '\.\/session-event-types'/s,
    )
    expect(contract).not.toMatch(
      /export \{[^}]*\} from '\.\/session-event-types'/s,
    )
    for (const name of [
      'SessionEventMap',
      'SessionHeader',
      'TurnEndReason',
      'EpochHeader',
      'StreamChunk',
      'TokenUsage',
      'ToolSchema',
      'SessionHistoryPage',
      'SessionLineage',
      'SubagentChildView',
    ])
      expect(contract).toContain(name)

    // The aggregator itself emits no runtime import or export.
    const aggregator = readFileSync(sessionEventTypesPath, 'utf8')
    const statements = aggregator.match(/^(?:import|export)\b[^\n]*/gm) ?? []
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements)
      expect(statement).toMatch(/^(?:import type|export type)\b/)

    // Renderer consumers pull these names only through `import type`.
    for (const source of [sessionsApiSource, backendApiSource]) {
      const imports =
        source.match(
          /^import[^;]*?from '@emperor\/core\/runtime-contract'/gms,
        ) ?? []
      for (const statement of imports)
        expect(statement.startsWith('import type')).toBe(true)
    }
  })
})
