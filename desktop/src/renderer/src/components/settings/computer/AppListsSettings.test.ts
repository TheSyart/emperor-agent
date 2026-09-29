// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppListsSettings from './AppListsSettings.vue'

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

function mount(onChange: (kind: string, next: string[]) => void) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    render: () =>
      h(AppListsSettings, {
        lists: {
          protected: ['com.example.Bank'],
          highRisk: [],
          sensitive: [],
        },
        busy: false,
        onChange,
      }),
  })
  app.mount(container)
  return container
}

async function type(root: HTMLElement, label: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
  input.form!.requestSubmit()
  await nextTick()
}

describe('app lists settings', () => {
  it('adds, removes and rejects malformed bundle IDs', async () => {
    const onChange = vi.fn()
    const root = mount(onChange)
    expect(root.textContent).toContain('com.example.Bank')

    await type(root, '添加到敏感应用', ' com.example.Notes ')
    expect(onChange).toHaveBeenLastCalledWith('sensitive', [
      'com.example.Notes',
    ])

    await type(root, '添加到高风险应用', 'not a bundle id!')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'bundle ID',
    )

    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="从保护的应用中移除 com.example.Bank"]',
      )!
      .click()
    await nextTick()
    expect(onChange).toHaveBeenLastCalledWith('protected', [])
  })
})
