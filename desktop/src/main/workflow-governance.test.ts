import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..', '..', '..')
const workflowsRoot = resolve(repoRoot, '.github', 'workflows')

describe('GitHub Actions governance', () => {
  it('checks out tracked text with LF on every runner', () => {
    const attributes = readFileSync(resolve(repoRoot, '.gitattributes'), 'utf8')

    expect(attributes).toMatch(/^\* text=auto eol=lf$/m)
  })

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

  it('typechecks Desktop tests in CI before the Desktop build', () => {
    // REL-04: the PR job runs scripts/ci/pr-gate.sh, which runs check.sh.
    const workflow = readFileSync(resolve(workflowsRoot, 'ci.yml'), 'utf8')
    expect(workflow).toContain('run: scripts/ci/pr-gate.sh\n')
    const gate = readFileSync(
      resolve(repoRoot, 'scripts', 'ci', 'pr-gate.sh'),
      'utf8',
    )
    expect(gate).toContain('./scripts/check.sh')
    const check = readFileSync(resolve(repoRoot, 'scripts', 'check.sh'), 'utf8')
    const desktopTests = check.indexOf('npm --prefix desktop run test')
    const testTypecheck = check.indexOf(
      'npm --prefix desktop run typecheck:test',
    )
    const desktopBuild = check.indexOf('npm --prefix desktop run build')

    expect(desktopTests).toBeGreaterThan(-1)
    expect(testTypecheck).toBeGreaterThan(desktopTests)
    expect(desktopBuild).toBeGreaterThan(testTypecheck)
  })
})
