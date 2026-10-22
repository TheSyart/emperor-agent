// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { activeConfirm, answerConfirmsForTest, settleConfirm } from './confirm'
import {
  DIRTY_GUARD_KEY,
  createDirtyGuard,
  useDirtyGuard,
  useDraft,
  type DirtyGuardHost,
} from './useDirtyGuard'

let app: App | null = null
let container: HTMLDivElement | null = null

/** Mount editors that register with `host`; returns their dirty flags. */
function mountEditors(host: DirtyGuardHost, labels: string[]) {
  const flags = labels.map(() => ref(false))
  const shown = ref(labels.map(() => true))
  const editors = labels.map((label, index) =>
    defineComponent({
      setup() {
        useDirtyGuard(label, flags[index]!)
        return () => h('div')
      },
    }),
  )
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(
      'div',
      editors.map((editor, index) => (shown.value[index] ? h(editor) : null)),
    ),
  )
  app.provide(DIRTY_GUARD_KEY, host)
  app.mount(container)
  return { flags, shown }
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  answerConfirmsForTest(null)
})

describe('useDirtyGuard', () => {
  it('lets the host go without asking while nothing is edited', async () => {
    const host = createDirtyGuard()
    mountEditors(host, ['长期记忆'])
    expect(host.dirty.value).toBe(false)
    await expect(host.confirmDiscard()).resolves.toBe(true)
    expect(activeConfirm.value).toBeNull()
  })

  it('asks once, naming every edited editor, and follows the answer', async () => {
    const host = createDirtyGuard()
    const { flags } = mountEditors(host, ['长期记忆', '用户档案', 'Hooks'])
    flags[0]!.value = true
    flags[2]!.value = true
    expect(host.dirty.value).toBe(true)
    expect(host.labels.value).toEqual(['长期记忆', 'Hooks'])

    const kept = host.confirmDiscard()
    await nextTick()
    const request = activeConfirm.value
    expect(request).toMatchObject({
      title: '放弃未保存的修改？',
      confirmLabel: '放弃',
      cancelLabel: '继续编辑',
      tone: 'danger',
    })
    expect(request?.body).toContain('「长期记忆」「Hooks」')
    settleConfirm(request!.id, false)
    await expect(kept).resolves.toBe(false)

    const discarded = host.confirmDiscard()
    await nextTick()
    settleConfirm(activeConfirm.value!.id, true)
    await expect(discarded).resolves.toBe(true)
  })

  it('forgets an editor once it unmounts', async () => {
    const host = createDirtyGuard()
    const { flags, shown } = mountEditors(host, ['MCP 配置'])
    flags[0]!.value = true
    expect(host.dirty.value).toBe(true)
    shown.value = [false]
    await nextTick()
    expect(host.dirty.value).toBe(false)
  })

  it('works without a host (the editor outside a guarded shell)', async () => {
    const flag = ref(true)
    let guard: ReturnType<typeof useDirtyGuard> | null = null
    container = document.createElement('div')
    document.body.append(container)
    app = createApp(
      defineComponent({
        setup() {
          guard = useDirtyGuard('长期记忆', flag)
          return () => h('div')
        },
      }),
    )
    app.mount(container)
    answerConfirmsForTest(() => false)
    await expect(guard!.confirmDiscard()).resolves.toBe(false)
    flag.value = false
    await expect(guard!.confirmDiscard()).resolves.toBe(true)
  })
})

describe('useDraft', () => {
  it('follows the source until edited, then keeps the edit', async () => {
    const source = ref('a')
    const draft = useDraft(() => source.value)
    expect(draft.text.value).toBe('a')
    expect(draft.dirty.value).toBe(false)

    source.value = 'b'
    await nextTick()
    expect(draft.text.value).toBe('b')

    draft.text.value = 'mine'
    expect(draft.dirty.value).toBe(true)
    source.value = 'c'
    await nextTick()
    expect(draft.text.value).toBe('mine')
    expect(draft.dirty.value).toBe(true)
  })

  it('is clean again once the source catches up with the edit (saved)', async () => {
    const source = ref('a')
    const draft = useDraft(() => source.value)
    draft.text.value = 'saved text'
    source.value = 'saved text'
    await nextTick()
    expect(draft.dirty.value).toBe(false)
    source.value = 'next'
    await nextTick()
    expect(draft.text.value).toBe('next')
  })

  it('reset() drops the edit for the current source', async () => {
    const source = ref('a')
    const draft = useDraft(() => source.value)
    draft.text.value = 'edit'
    source.value = 'b'
    await nextTick()
    draft.reset()
    expect(draft.text.value).toBe('b')
    expect(draft.dirty.value).toBe(false)
  })
})
