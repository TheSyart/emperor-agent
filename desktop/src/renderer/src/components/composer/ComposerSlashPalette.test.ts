// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SlashPaletteItem } from '../../commands'
import Composer from './ComposerCard.vue'
import { composerView, typeInto, visibleText } from './editor/editorTesting'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

describe('Composer slash palette refresh', () => {
  it('refreshes the command catalog when slash suggestions open', async () => {
    const refreshCommands = vi.fn(async () => {})
    container = document.createElement('div')
    document.body.append(container)
    createApp(Composer, {
      busy: false,
      commands: [command('model')],
      tools: [],
      contextUsed: 0,
      contextMax: 0,
      modelEntries: [],
      providerOptions: [],
      refreshCommands,
    }).mount(container)

    typeInto(composerView(container), '/')
    await nextTick()

    expect(refreshCommands).toHaveBeenCalledOnce()
  })

  it('inserts the selected Skill as a chip that sends its own slash token', async () => {
    container = document.createElement('div')
    document.body.append(container)
    const component = createApp(Composer, {
      busy: false,
      commands: [command('model'), skill('agent-reach')],
      tools: [],
      contextUsed: 0,
      contextMax: 0,
      modelEntries: [],
      providerOptions: [],
    }).mount(container) as unknown as {
      setDraft: (text: string) => void
      applySnapshot: (draft: null) => void
    }

    const view = composerView(container)
    typeInto(view, '/')
    await nextTick()
    const skillButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Agent Reach'))
    skillButton?.click()
    await nextTick()

    expect(skillButton).toBeDefined()
    const chip = container.querySelector('.composer-chip')
    expect(chip?.textContent).toBe('Agent Reach')
    expect(chip?.getAttribute('aria-label')).toBe('技能 Agent Reach')
    expect(visibleText(view)).toBe('Agent Reach ')
    expect(container.textContent).not.toContain('/skill ')

    // A draft names a known skill: it becomes a chip; unknown names stay.
    // (setDraft adds to a non-empty composer, so start from an empty one.)
    component.applySnapshot(null)
    component.setDraft('/agent-reach research query')
    await nextTick()
    expect(container.querySelectorAll('.composer-chip')).toHaveLength(1)
    component.applySnapshot(null)
    component.setDraft('/unknown research query')
    await nextTick()
    expect(container.querySelector('.composer-chip')).toBeNull()
    expect(visibleText(view)).toBe('/unknown research query')
  })
})

function command(name: string): SlashPaletteItem {
  return {
    id: `command:builtin.${name}`,
    commandId: `builtin.${name}`,
    kind: 'command',
    name: `/${name}`,
    title: 'Model',
    completion: `/${name}`,
    description: 'Choose the model for this chat',
    category: 'Commands',
    source: 'builtin',
    sourceLabel: '',
    available: true,
  }
}

function skill(name: string): SlashPaletteItem {
  return {
    id: `command:skill.user.${name}`,
    commandId: `skill.user.${name}`,
    kind: 'skill',
    name: `/${name}`,
    title: 'Agent Reach',
    completion: `/${name} `,
    description: 'Research across the web',
    category: 'Skills',
    source: 'user_skill',
    sourceLabel: 'Personal',
    available: true,
    skillName: name,
  }
}
