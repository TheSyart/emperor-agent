// @vitest-environment jsdom
// MOD-04: the composer's model menu ends with 添加模型…, which asks the
// owner to open the add-model dialog.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '../../types'
import ModelPicker from './ModelPicker.vue'

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

describe('ModelPicker › 添加模型…', () => {
  it('offers 添加模型… under the model list and emits add-model', async () => {
    const onAddModel = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    app = createApp(() =>
      h(ModelPicker, {
        entries: [
          {
            entryId: 'main',
            provider: 'deepseek',
            modelId: 'deepseek-flash',
            effectiveDisplayName: 'Main',
          } as ModelEntry,
        ],
        activeId: 'main',
        label: 'Main',
        reasoningLabel: '',
        reasoningValue: '',
        reasoningOptions: [],
        providerOptions: [],
        onAddModel,
      }),
    )
    app.mount(host)
    await flush()
    host.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    const add = document.querySelector<HTMLElement>('[data-add-model]')
    expect(add?.textContent?.trim()).toBe('添加模型…')
    add!.click()
    await flush()
    expect(onAddModel).toHaveBeenCalledOnce()
  })
})
