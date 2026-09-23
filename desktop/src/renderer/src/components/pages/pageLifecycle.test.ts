// @vitest-environment jsdom
import {
  createApp,
  defineComponent,
  h,
  KeepAlive,
  nextTick,
  ref,
  type App,
} from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onPageReactivated } from './pageLifecycle'

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe('onPageReactivated', () => {
  it('runs when a kept-alive page is shown again, not on first mount', async () => {
    const page = vi.fn()
    const late = vi.fn()
    const showLate = ref(false)
    const Child = defineComponent({
      setup() {
        onPageReactivated(late)
        return () => h('i')
      },
    })
    const Page = defineComponent({
      setup() {
        onPageReactivated(page)
        return () => h('div', showLate.value ? [h(Child)] : [])
      },
    })
    const Other = defineComponent({ render: () => h('p') })
    const current = ref<'page' | 'other'>('page')
    const host = document.createElement('div')
    document.body.append(host)
    app = createApp({
      render: () =>
        h(KeepAlive, null, [h(current.value === 'page' ? Page : Other)]),
    })
    app.mount(host)
    await nextTick()
    expect(page).not.toHaveBeenCalled()

    // A child mounted inside the already-active page: no call either.
    showLate.value = true
    await nextTick()
    expect(late).not.toHaveBeenCalled()

    current.value = 'other'
    await nextTick()
    current.value = 'page'
    await nextTick()
    expect(page).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(1)

    current.value = 'other'
    await nextTick()
    current.value = 'page'
    await nextTick()
    expect(page).toHaveBeenCalledTimes(2)
    expect(late).toHaveBeenCalledTimes(2)
  })

  it('never fires outside a kept-alive tree', async () => {
    const fn = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    app = createApp(
      defineComponent({
        setup() {
          onPageReactivated(fn)
          return () => h('div')
        },
      }),
    )
    app.mount(host)
    await nextTick()
    expect(fn).not.toHaveBeenCalled()
  })
})
