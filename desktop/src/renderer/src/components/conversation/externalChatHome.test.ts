// @vitest-environment jsdom
/**
 * GRP-19: the home of a single chat with Claude Code or Codex. Once the
 * chat has a delegation it opens that delegation's page — also when the
 * same chat is opened again from a page kept alive — and a message that
 * comes back after the user left the chat never pulls them back.
 */
import {
  createApp,
  defineComponent,
  h,
  KeepAlive,
  nextTick,
  ref,
  shallowRef,
  type App,
  type Component,
} from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => vi.fn())
vi.mock('../../api/http', () => ({ core }))

const { useExternalChatHome } = await import('./externalChatHome')

const screen = ref('A')
const go = vi.fn(async () => undefined)
let home: ReturnType<typeof useExternalChatHome> | undefined
let app: App | undefined

const Home = defineComponent({
  name: 'Home',
  setup() {
    home = useExternalChatHome({
      sessionId: () => screen.value,
      onScreen: (id) => screen.value === id,
      go,
    })
    return () => h('div')
  },
})
const Other = defineComponent({ name: 'Other', setup: () => () => h('p') })
const shown = shallowRef<Component>(Home)

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  core.mockReset()
  go.mockClear()
  screen.value = 'A'
  shown.value = Home
  const root = document.createElement('div')
  app = createApp({
    setup: () => () => h(KeepAlive, null, [h(shown.value)]),
  })
  app.mount(root)
})

afterEach(() => {
  app?.unmount()
})

it('opens the delegation of a chat opened again from a kept-alive page', async () => {
  core.mockResolvedValue({ delegationId: null })
  await settle()
  expect(go).not.toHaveBeenCalled()
  // The first message went out: the chat now has a delegation, and its
  // page was shown; the home stayed alive with the same session id.
  shown.value = Other
  await settle()
  core.mockResolvedValue({ delegationId: 'dlg-1' })
  shown.value = Home
  await settle()
  expect(go).toHaveBeenCalledWith({
    name: 'external-agent',
    params: { sessionId: 'A', delegationId: 'dlg-1' },
  })
})

it('stays where the user went when an older lookup answers late', async () => {
  const answers: ((value: { delegationId: string | null }) => void)[] = []
  core.mockImplementation(
    () =>
      new Promise((resolve) => {
        answers.push(resolve)
      }),
  )
  // A comes on screen (its lookup waits), then the user opens B.
  screen.value = 'X'
  await settle()
  screen.value = 'A'
  await settle()
  screen.value = 'B'
  await settle()
  answers[2]!({ delegationId: null })
  answers[1]!({ delegationId: 'dlg-a' })
  await settle()
  expect(go).not.toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ delegationId: 'dlg-a' }),
    }),
  )
})

it('a message answered after the user left never pulls them back', async () => {
  core.mockResolvedValue({ delegationId: null })
  await settle()
  let accept: (value: { delegationId: string }) => void = () => {}
  core.mockImplementation((operation: string) =>
    operation === 'contacts.chatSend'
      ? new Promise((resolve) => {
          accept = resolve
        })
      : Promise.resolve({ delegationId: null }),
  )
  const sent = home!.send('A', '看看结构')
  await settle()
  expect(home!.sendingFor('A')).toBe(true)
  expect(home!.sendingFor('B')).toBe(false)
  screen.value = 'B'
  await settle()
  accept({ delegationId: 'dlg-a' })
  // Sent: the caller clears A's own draft, not the one on screen.
  expect(await sent).toBe(true)
  expect(go).not.toHaveBeenCalled()
})

it('keeps the refusal with the chat it belongs to', async () => {
  core.mockResolvedValue({ delegationId: null })
  await settle()
  core.mockRejectedValueOnce(new Error('Codex 不可用'))
  expect(await home!.send('A', 'hi')).toBe(false)
  expect(home!.errorFor('A')).toBe('Codex 不可用')
  expect(home!.errorFor('B')).toBe('')
})
