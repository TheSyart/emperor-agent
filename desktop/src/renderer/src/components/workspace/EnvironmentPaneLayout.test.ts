import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paneSource = readFileSync(
  new URL('./EnvironmentPane.vue', import.meta.url),
  'utf8',
)
const workspaceCss = readFileSync(
  new URL('../../styles/workspace.css', import.meta.url),
  'utf8',
)

describe('EnvironmentPane Subagent layout', () => {
  it('uses a fixed icon, shrinkable copy, and right-aligned status grid', () => {
    expect(paneSource).toContain('environment-subagent-row')
    expect(paneSource).toContain('environment-agent-copy')
    expect(workspaceCss).toMatch(
      /\.environment-subagent-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) auto;/s,
    )
  })

  it('excludes the fixed agent icon from the generic flexible label rule', () => {
    expect(workspaceCss).toMatch(
      /\.workspace-list-row\s*>\s*span:not\(\.workspace-row-value\):not\(\.environment-agent-icon\)/,
    )
  })
})
