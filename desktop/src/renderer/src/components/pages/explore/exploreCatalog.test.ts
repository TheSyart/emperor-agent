/**
 * The shipped 探索 catalog: schema v1, unique ids, https-only public URLs
 * without credentials, known kinds, and install payloads Core accepts —
 * MCP configs through Core's own import normalizer, Skill links through
 * Core's Skill URL parser (both imported from packages/core).
 */
import { describe, expect, it } from 'vitest'
import { normalizeMcpImport } from '../../../../../../../packages/core/src/mcp/import'
import { parseSkillImportUrl } from '../../../../../../../packages/core/src/skills/import'
import catalog from './exploreCatalog.json'
import {
  exploreCatalogIssues,
  mcpEntryServerNames,
  publicHttpsIssue,
  validExploreEntries,
  type ExploreEntry,
} from './exploreModel'

const entries = catalog.entries as unknown as ExploreEntry[]

/** Every string that looks like a URL anywhere inside `value`. */
function urlsIn(value: unknown): string[] {
  if (typeof value === 'string')
    return /^[a-z][a-z0-9+.-]*:/i.test(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(urlsIn)
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(urlsIn)
  return []
}

describe('explore catalog (exploreCatalog.json)', () => {
  it('is a valid schema v1 catalog with a small curated set', () => {
    expect(catalog.version).toBe(1)
    expect(exploreCatalogIssues(catalog)).toEqual([])
    expect(validExploreEntries(catalog)).toHaveLength(entries.length)
    expect(entries.length).toBeGreaterThanOrEqual(6)
    expect(entries.length).toBeLessThanOrEqual(12)
  })

  it('uses unique ids and only known kinds', () => {
    const ids = entries.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of entries)
      expect(['skill', 'mcp', 'plugin']).toContain(entry.kind)
  })

  it('points only at public https URLs without credentials', () => {
    const urls = entries.flatMap(urlsIn)
    expect(urls.length).toBeGreaterThan(entries.length)
    for (const url of urls) expect(publicHttpsIssue(url), url).toBe('')
  })

  it('ships MCP configs that Core imports without warnings', () => {
    const mcp = entries.filter((entry) => entry.kind === 'mcp')
    expect(mcp.length).toBeGreaterThan(0)
    for (const entry of mcp) {
      if (!('mcpConfig' in entry.install)) throw new Error(entry.id)
      const result = normalizeMcpImport(entry.install.mcpConfig)
      expect(result.warnings, entry.id).toEqual([])
      expect(Object.keys(result.servers)).toEqual(mcpEntryServerNames(entry))
      for (const server of Object.values(result.servers)) {
        expect(server.enabled).toBe(true)
        if (server.transport === 'stdio') {
          expect(['npx', 'uvx']).toContain(server.command)
        } else {
          expect(server.transport).toBe('http')
          expect(publicHttpsIssue(server.url)).toBe('')
        }
        expect(server.env ?? {}).toEqual({})
        expect(server.headers ?? {}).toEqual({})
      }
      // The same text the add dialog is prefilled with.
      expect(
        normalizeMcpImport(JSON.stringify(entry.install.mcpConfig)).servers,
      ).toEqual(result.servers)
    }
  })

  it('ships Skill links that Core resolves to a GitHub folder', () => {
    const skills = entries.filter((entry) => entry.kind === 'skill')
    expect(skills.length).toBeGreaterThan(0)
    for (const entry of skills) {
      if (!('skillUrl' in entry.install)) throw new Error(entry.id)
      const parsed = parseSkillImportUrl(entry.install.skillUrl)
      expect(parsed.kind, entry.id).toBe('github')
      if (parsed.kind === 'github') expect(parsed.dir).not.toBe('')
    }
  })

  it('ships Plugin links only as https archives', () => {
    for (const entry of entries.filter((item) => item.kind === 'plugin')) {
      if (!('pluginUrl' in entry.install)) throw new Error(entry.id)
      expect(publicHttpsIssue(entry.install.pluginUrl)).toBe('')
    }
  })
})
