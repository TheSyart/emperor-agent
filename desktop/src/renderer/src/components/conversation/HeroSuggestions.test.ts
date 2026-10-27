// @vitest-environment jsdom
// MOD-03 7: the Chat home's starters fill the composer and never send.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import HeroSuggestions from './HeroSuggestions.vue'
import { HERO_SUGGESTIONS } from './heroSuggestions'

let app: App | undefined
let root: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

it('7 · lists the five starters and hands the picked one over as text', async () => {
  const picked: string[] = []
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(HeroSuggestions, { onPick: (draft: string) => picked.push(draft) }),
  })
  app.mount(root)
  await nextTick()

  const group = root.querySelector('[role="group"]')!
  expect(group.getAttribute('aria-label')).toBe('常用起手式')
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(
    HERO_SUGGESTIONS.map((item) => item.label),
  )
  // Plain buttons: nothing here can submit the composer's form.
  expect(buttons.every((button) => button.type === 'button')).toBe(true)

  buttons[1]!.click()
  expect(picked).toEqual([HERO_SUGGESTIONS[1]!.draft])
})
