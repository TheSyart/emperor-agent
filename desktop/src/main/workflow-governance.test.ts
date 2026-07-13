import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..', '..', '..')
const workflowsRoot = resolve(repoRoot, '.github', 'workflows')

describe('GitHub Actions governance', () => {
  it('uses the release-pinned Node 24 toolchain in every workflow', () => {
    const workflows = readdirSync(workflowsRoot)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => ({
        name,
        content: readFileSync(resolve(workflowsRoot, name), 'utf8'),
      }))

    expect(workflows.length).toBeGreaterThan(0)
    for (const workflow of workflows) {
      const versions = [
        ...workflow.content.matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/g),
      ].map((match) => match[1])
      expect(versions, workflow.name).not.toHaveLength(0)
      expect(new Set(versions), workflow.name).toEqual(new Set(['24']))
    }
  })
})
