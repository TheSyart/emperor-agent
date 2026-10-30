// CP-02: a contact sees and loads only the Skills it selected.
import { describe, expect, it } from 'vitest'
import type { Agent } from '../../agent/agent'
import type {
  FileSkillsLoader,
  ResolvedSkill,
} from '../../../skills/file-loader'
import { ToolRegistry } from '../registry'
import { catalogEntries, createSkillTool, type SkillSource } from './skill'

function skill(name: string): ResolvedSkill {
  return {
    name,
    root: `/skills/${name}`,
    skillFile: `/skills/${name}/SKILL.md`,
    content: `# ${name}`,
    description: `${name} 的说明`,
    source: 'user',
    readOnly: false,
    status: 'active',
    frontmatter: {},
    warnings: [],
    flat: false,
    sourceDir: '/skills',
  }
}

const loader = {
  resolvedSkills: () => [skill('wanted'), skill('hidden')],
  resolve: (name: string) =>
    [skill('wanted'), skill('hidden')].find((item) => item.name === name) ??
    null,
} as unknown as FileSkillsLoader

const agent = { id: 's1', owner: undefined } as unknown as Agent

describe('contact skill selection (CP-02)', () => {
  it('lists only the selected Skills', () => {
    expect(catalogEntries(loader).map((entry) => entry.name)).toEqual([
      'wanted',
      'hidden',
    ])
    expect(
      catalogEntries(loader, (name) => name === 'wanted').map(
        (entry) => entry.name,
      ),
    ).toEqual(['wanted'])
    expect(catalogEntries(loader, () => false)).toEqual([])
  })

  it('refuses to load a Skill the contact did not select', async () => {
    const tools = new ToolRegistry()
    tools.register(
      createSkillTool({
        loaderFor: () => loader,
        allows: (_agent, name) => name === 'wanted',
      }),
    )
    const run = (name: string) =>
      tools.execute({
        callId: `c-${name}`,
        name: 'skill',
        arguments: { name },
        signal: new AbortController().signal,
        agent,
      })
    const refused = await run('hidden')
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('not selected')
    const loaded = await run('wanted')
    expect(JSON.stringify(loaded.content)).toContain('wanted')
  })

  it('allows nothing when the contact selected nothing', () => {
    const noSelection: SkillSource = {
      loaderFor: () => loader,
      allows: () => false,
    }
    expect(
      catalogEntries(loader, (name) => noSelection.allows!(agent, name)),
    ).toEqual([])
  })
})
