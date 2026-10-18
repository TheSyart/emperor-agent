import { describe, expect, it } from 'vitest'
import { createResourcePreviewState } from './previewState'
import { displayResource } from './resourceModel'

describe('lazy resource preview lifecycle', () => {
  it('does no work before an explicit load and keeps the same session identity', async () => {
    const calls: string[] = []
    const state = createResourcePreviewState(async (session, resource) => {
      calls.push(`${session}/${resource.sourceMessageId}`)
      return { state: 'ready', title: '真实标题', updatedAt: 1 }
    })
    expect(calls).toEqual([])
    await state.load('s1', displayResource('https://a.test', '', 'm1')!)
    expect(calls).toEqual(['s1/m1'])
    expect(state.preview.value?.title).toBe('真实标题')
  })
  it('ignores an older session response and cancels its consumer signal', async () => {
    let finish!: (result: {
      state: 'ready'
      title: string
      updatedAt: number
    }) => void
    let oldSignal: AbortSignal | undefined
    const state = createResourcePreviewState(
      async (session, _resource, signal) => {
        if (session === 's1') {
          oldSignal = signal
          return new Promise((resolve) => {
            finish = resolve
          })
        }
        return { state: 'ready', title: '新会话', updatedAt: 2 }
      },
    )
    const older = state.load('s1', displayResource('https://a.test', '', 'm1')!)
    await state.load('s2', displayResource('https://b.test', '', 'm2')!)
    finish({ state: 'ready', title: '旧会话', updatedAt: 1 })
    await older
    expect(state.preview.value?.title).toBe('新会话')
    expect(oldSignal?.aborted).toBe(true)
  })
  it('clears pending work on close and turns network errors into a retryable state', async () => {
    const state = createResourcePreviewState(async () => {
      throw new Error('network')
    })
    await state.load('s1', displayResource('https://a.test', '', 'm1')!)
    expect(state.preview.value?.state).toBe('error')
    expect(state.loading.value).toBe(false)
    state.clear()
    expect(state.preview.value).toBeNull()
  })
})
