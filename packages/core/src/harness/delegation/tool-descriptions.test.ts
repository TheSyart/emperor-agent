/**
 * Local subagent tools keep main's wording (AGT-05, SUB-27). The golden is the
 * output of `createSubagentTools` on main (112f64d4, unchanged since); the external
 * backends add their own optional parameters, each described as external.
 *
 * Refresh after an intentional change to the local tools:
 *   UPDATE_GOLDEN=1 npx vitest run src/harness/delegation/tool-descriptions.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTestHarness } from '../testing'
import { SubagentManager } from '../subagent/manager'
import { createSubagentTools } from '../subagent/tools'
import { SandboxPolicyService } from '../sandbox/policy'
import { ApprovalService } from '../approval/service'
import { createDelegationTools } from './tools'
import type { ToolDefinition } from '../tools/definition'

const GOLDEN = join(__dirname, '__golden__', 'local-subagent-tools.json')

interface Projected {
  name: string
  description: string
  parameters: {
    properties: Record<string, { description?: string }>
    required?: string[]
  }
}

function manager() {
  const h = createTestHarness()
  return new SubagentManager({
    sessions: h.sessions,
    lookupAgent: () => undefined,
    createAgent: () => {
      throw new Error('not used')
    },
    sandbox: new SandboxPolicyService({
      defaultMode: 'read-only',
      workspaceRoot: '/fixture',
    }),
    approval: new ApprovalService('never'),
  })
}
const project = (tool: ToolDefinition): Projected =>
  JSON.parse(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }),
  ) as Projected

it('the local subagent tools still match the golden taken from main', () => {
  const local = createSubagentTools(manager()).map(project)
  if (process.env.UPDATE_GOLDEN === '1')
    writeFileSync(GOLDEN, JSON.stringify(local, null, 2) + '\n')
  expect(local).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
})

it('the model sees main wording for local subagents, and external options only under their own fields', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Projected[]
  const tools = createDelegationTools({
    internalManager: manager(),
    delegations: () => undefined,
    ownerResolver: () => {
      throw new Error('not used')
    },
    canControl: () => false,
  }).map(project)
  for (const expected of golden) {
    const tool = tools.find((t) => t.name === expected.name)!
    expect(tool.description).toBe(expected.description)
    for (const [key, schema] of Object.entries(expected.parameters.properties))
      expect(tool.parameters.properties[key]).toEqual(schema)
    expect(tool.parameters.required ?? []).toEqual(
      expected.parameters.required ?? [],
    )
    for (const key of Object.keys(tool.parameters.properties))
      if (!(key in expected.parameters.properties))
        expect(tool.parameters.properties[key]!.description).toMatch(
          /external/i,
        )
  }
  const subagent = tools.find((t) => t.name === 'subagent')!
  const backend = subagent.parameters.properties.backend!.description!
  for (const word of ['internal', 'claude-code', 'codex', 'asks the user'])
    expect(backend).toContain(word)
  // Internal subagents never had provider routing here; it only confused the model.
  expect(subagent.parameters.properties).not.toHaveProperty('provider')
  expect(subagent.description).not.toMatch(/claude-code|codex|external/i)
})
