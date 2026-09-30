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
  document.body.innerHTML = ''
})

function mount(
  onChange: (kind: string, next: string[]) => void,
  kinds?: string[],
) {
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
        ...(kinds ? { kinds } : {}),
        onChange,
      }),
  })
  app.mount(container)
  return container
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await nextTick()
}

/** 添加 on a list, then type the bundle ID into the dialog and submit. */
async function add(root: HTMLElement, list: string, value: string) {
  root
    .querySelector<HTMLButtonElement>(`button[aria-label="添加到${list}"]`)!
    .click()
  await settle()
  const input = document.body.querySelector<HTMLInputElement>(
    'form.app-id-form input',
  )!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle()
  document.body
    .querySelector('form.app-id-form')!
    .dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
}

describe('app lists settings', () => {
  it('adds in a dialog, removes a chip and rejects malformed bundle IDs', async () => {
    const onChange = vi.fn()
    const root = mount(onChange)
    expect(root.textContent).toContain('com.example.Bank')
    // No input fields on the page itself.
    expect(root.querySelectorAll('input')).toHaveLength(0)

    await add(root, '不截图的应用', ' com.example.Notes ')
    expect(onChange).toHaveBeenLastCalledWith('sensitive', [
      'com.example.Notes',
    ])
    expect(document.body.querySelector('form.app-id-form')).toBeNull()

    await add(root, '高风险应用', 'not a bundle id!')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('bundle ID')

    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="从不让 Emperor 操作的应用中移除 com.example.Bank"]',
      )!
      .click()
    await nextTick()
    expect(onChange).toHaveBeenLastCalledWith('protected', [])
  })

  it('shows only the lists it is given', () => {
    const root = mount(vi.fn(), ['highRisk', 'sensitive'])
    expect(
      [...root.querySelectorAll('[data-app-list]')].map((row) =>
        row.getAttribute('data-app-list'),
      ),
    ).toEqual(['highRisk', 'sensitive'])
  })
})
