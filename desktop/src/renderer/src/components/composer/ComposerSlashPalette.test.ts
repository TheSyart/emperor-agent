// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SlashPaletteItem } from '../../commands'
import Composer from './ComposerCard.vue'

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

    const textarea = container.querySelector('textarea')!
    textarea.value = '/'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(refreshCommands).toHaveBeenCalledOnce()
  })

  it('inserts the selected Skill own slash token without a /skill intermediary', async () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(Composer, {
      busy: false,
      commands: [command('model'), skill('agent-reach')],
      tools: [],
      contextUsed: 0,
      contextMax: 0,
      modelEntries: [],
      providerOptions: [],
    }).mount(container)

    const textarea = container.querySelector('textarea')!
    textarea.value = '/'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const skillButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Agent Reach'))
    skillButton?.click()
    await nextTick()

    expect(skillButton).toBeDefined()
    expect(textarea.value).toBe('/agent-reach ')
    expect(container.textContent).not.toContain('/skill ')

    textarea.value = '/agent-reach research query'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('.composer-skill-slash')?.textContent).toBe(
      '/agent-reach',
    )

    textarea.value = '/unknown research query'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('.composer-skill-slash')).toBeNull()
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
