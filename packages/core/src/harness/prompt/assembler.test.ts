// Section gates (GRP-03): a gate may leave a section out of one assembly
// (it renders empty); without a gate, or once it is removed, every section
// renders as before.
import { describe, expect, it } from 'vitest'
import { renderPrompt, SystemPromptAssembler } from './assembler'

function assembler(): SystemPromptAssembler {
  const prompt = new SystemPromptAssembler()
  prompt.section({ name: 'persona', order: 0, text: 'persona' })
  prompt.section({ name: 'tool:read', order: 100, text: 'use read' })
  prompt.section({ name: 'tool:write', order: 101, text: () => 'use write' })
  return prompt
}

describe('SystemPromptAssembler section gates', () => {
  it('renders every section without a gate', () => {
    expect(renderPrompt(assembler().assemble())).toBe(
      'persona\n\nuse read\n\nuse write',
    )
  })

  it('leaves out what a gate refuses, and nothing once it is removed', () => {
    const prompt = assembler()
    let resolved = 0
    prompt.section({
      name: 'tool:edit',
      order: 102,
      text: () => {
        resolved += 1
        return 'use edit'
      },
    })
    const remove = prompt.sectionGate(
      (name) => name !== 'tool:write' && name !== 'tool:edit',
    )
    const gated = prompt.assemble()
    expect(renderPrompt(gated)).toBe('persona\n\nuse read')
    expect(gated.sections.map((section) => section.name)).toEqual([
      'persona',
      'tool:read',
      'tool:write',
      'tool:edit',
    ])
    // A refused section's text is not even produced.
    expect(resolved).toBe(0)
    remove()
    expect(renderPrompt(prompt.assemble())).toBe(
      'persona\n\nuse read\n\nuse write\n\nuse edit',
    )
  })
})
