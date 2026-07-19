import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionEffectStore } from './actionEffect'
import {
  createPendingProjectionState,
  executePendingEffect,
  reducePendingProjection,
  type PendingEffect,
  type PendingEffectOutput,
  type PendingProjectionAction,
  type PendingProjectionState,
} from './pendingProjection'

afterEach(() => vi.useRealTimers())

function createStore() {
  return new ActionEffectStore<
    PendingProjectionState,
    PendingProjectionAction,
    PendingEffect,
    PendingEffectOutput
  >({
    initialState: createPendingProjectionState(),
    reducer: reducePendingProjection,
    execute: executePendingEffect,
    taskResultAction: (result) => ({
      type: 'pending_effect_result',
      result,
    }),
  })
}

describe('pending projection effect', () => {
  it('clears only through the matching timer TaskResult', async () => {
    vi.useFakeTimers()
    const store = createStore()
    store.dispatch({
      type: 'pending_set',
      label: 'working',
      detail: '',
      tone: 'running',
      autoClearMs: 50,
    })
    expect(store.getState().pending.label).toBe('working')

    await vi.advanceTimersByTimeAsync(50)

    expect(store.getState().pending).toEqual({ label: '', detail: '' })
    expect(store.pendingCount()).toBe(0)
  })

  it('cancels a stale timer when a newer persistent notice wins', async () => {
    vi.useFakeTimers()
    const store = createStore()
    store.dispatch({
      type: 'pending_set',
      label: 'old',
      detail: '',
      tone: 'done',
      autoClearMs: 20,
    })
    store.dispatch({
      type: 'pending_set',
      label: 'new',
      detail: 'keep',
      tone: 'error',
      autoClearMs: 0,
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(store.getState().pending).toEqual({
      label: 'new',
      detail: 'keep',
      tone: 'error',
    })
  })
})
