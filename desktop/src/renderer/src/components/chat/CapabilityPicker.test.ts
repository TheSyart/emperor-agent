// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { Circle } from 'lucide-vue-next'
import CapabilityPicker from './CapabilityPicker.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

describe('CapabilityPicker slash mode', () => {
  it('renders a quiet two-section command palette without a technical header', () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(CapabilityPicker, {
        mode: 'slash',
        heading: '斜杠命令',
        hint: 'Tab 补全第一项',
        groups: [
          {
            label: 'Commands',
            items: [
              {
                id: 'builtin.model',
                action: 'insert_command',
                label: 'Model',
                description: 'Choose the model for this chat',
                completion: '/model',
                icon: Circle,
              },
            ],
          },
          {
            label: 'Skills',
            items: [
              {
                id: 'skill.user.agent-reach',
                action: 'insert_command',
                label: 'Agent Reach',
                description: 'Research across the web',
                meta: 'Personal',
                completion: '/agent-reach ',
                icon: Circle,
              },
            ],
          },
        ],
      }),
    ).mount(container)

    expect(container.querySelector('.composer-palette-head')).toBeNull()
    expect(
      [...container.querySelectorAll('.composer-palette-label')].map(
        (element) => element.textContent,
      ),
    ).toEqual(['Commands', 'Skills'])
    expect(container.textContent).toContain('Model')
    expect(container.textContent).toContain('Agent Reach')
    expect(container.textContent).toContain('Personal')
    expect(container.textContent).not.toContain('Tab 补全第一项')
  })
})
