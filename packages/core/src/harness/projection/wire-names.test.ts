import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_EVENT_NAMES } from './wire-names'

const names = new Set<string>(RUNTIME_EVENT_NAMES)

function source(...parts: string[]): string {
  return readFileSync(join(__dirname, ...parts), 'utf8')
}

function literalNames(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!)
}

describe('runtime wire names', () => {
  it('covers every event the session projector emits', () => {
    const projector = source('projector.ts')
    const lines = projector.split('\n')
    const emitted: string[] = []
    let inNameBlock = false
    for (const line of lines) {
      if (line.includes('const name = answered.outcome')) inNameBlock = true
      if (line.includes('emit(') || inNameBlock)
        emitted.push(...literalNames(line, /'([a-z]+(?:_[a-z]+)+)'/g))
      if (inNameBlock && line.includes('emit(name')) inNameBlock = false
    }
    expect(emitted.length).toBeGreaterThan(10)
    for (const name of emitted) expect(names, name).toContain(name)
  })

  it('covers every host-only event emitted through emitHost', () => {
    const host = source('..', 'host', 'host.ts')
    const emitted = literalNames(host, /event: '([a-z_]+)'/g)
    expect(emitted).toContain('subagent_delta')
    for (const name of emitted) expect(names, name).toContain(name)
  })

  it('has no duplicate names', () => {
    expect(names.size).toBe(RUNTIME_EVENT_NAMES.length)
  })
})
