import { afterEach, describe, expect, it } from 'vitest'
import { FakeComputerUsePort } from '../harness/computer-use/testing/fake-port'
import { GUI_TOOL_CATALOG } from '../harness/computer-use/tools/catalog'
import { TOOL_CATEGORIES, type ToolCategory } from '../harness/tools/definition'
import { makeApi, type ApiFixture } from './test-helpers'

// 能力 › 工具 lists Emperor's own tools by category (PLAN-CAP-001 ST-08):
// every builtin tool the Agent sees has one, and the computer use tools
// belong to their plugin (its detail lists them), not to that page.

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

/** Every tool a host can register: web search and computer use on too. */
async function fullApi() {
  const fixture = await makeApi({
    extra: {
      computerUsePort: new FakeComputerUsePort(),
      computerUseSettings: () => ({ enabled: true }),
      webSearch: { search: async () => [] },
    },
  })
  fixtures.push(fixture)
  return fixture.api
}

const EXPECTED: Record<ToolCategory, string[]> = {
  basic: [
    'bash',
    'edit',
    'glob',
    'grep',
    'job_kill',
    'job_list',
    'job_output',
    'read',
    'write',
  ],
  network: ['web_search'],
  planning: [
    'ask_user_question',
    'create_goal',
    'exit_plan_mode',
    'get_goal',
    'scheduler',
    'todo_write',
    'update_goal',
  ],
  agents: [
    'interrupt_agent',
    'list_agents',
    'ralph',
    'send_message',
    'subagent',
    'subagent_fork',
    'workflow',
  ],
  config: ['mcp_config', 'memory_edit', 'skill', 'skill_manage'],
}

describe('the tool catalog of 能力 › 工具', () => {
  it('gives every builtin tool a category', async () => {
    const api = await fullApi()
    const builtin = api.skills
      .tools()
      .filter((tool) => tool.source === 'builtin' && !tool.plugin_id)
    // A new tool registered without a category fails here, by name.
    expect(
      builtin.filter((tool) => !tool.category).map((tool) => tool.name),
    ).toEqual([])
    const grouped = Object.fromEntries(
      TOOL_CATEGORIES.map((category) => [
        category,
        builtin
          .filter((tool) => tool.category === category)
          .map((tool) => tool.name)
          .sort(),
      ]),
    )
    expect(grouped).toEqual(EXPECTED)
  })

  it('puts the computer use tools under their plugin, without a category', async () => {
    const api = await fullApi()
    const gui = api.skills
      .tools()
      .filter((tool) => tool.plugin_id === 'computer-use')
    expect(gui.map((tool) => tool.name).sort()).toEqual(
      Object.keys(GUI_TOOL_CATALOG).sort(),
    )
    expect(gui).toHaveLength(46)
    for (const tool of gui) {
      expect(tool.source).toBe('builtin')
      expect(tool).not.toHaveProperty('category')
    }
  })
})
