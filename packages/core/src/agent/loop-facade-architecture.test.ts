import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AgentLoop composition facade ownership', () => {
  it('derives selected session bindings instead of storing mutable store/runner aliases', () => {
    const source = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/conversationStore!:/)
    expect(source).not.toMatch(/activeMemoryStore!:/)
    expect(source).not.toMatch(/runtimeStore!:/)
    expect(source).not.toMatch(/private activeRunner!:/)
    expect(source).not.toMatch(/selectedControlManager/)
    expect(source).not.toMatch(/this\.conversationStore\s*=/)
    expect(source).not.toMatch(/this\.activeMemoryStore\s*=/)
    expect(source).not.toMatch(/this\.runtimeStore\s*=/)
  })
})
