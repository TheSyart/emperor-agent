import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  ActionEffectStore,
  type ActionEffectDescriptor,
  type ActionEffectTaskResult,
} from './actionEffect'

interface FixtureEffect extends ActionEffectDescriptor {
  value: number
}

type FixtureAction =
  | { type: 'run'; effect: FixtureEffect }
  | {
      type: 'task_result'
      result: ActionEffectTaskResult<FixtureEffect, number>
    }

interface FixtureState {
  value: number
  results: Array<{ id: string; status: string }>
}

function fixtureStore(execute: (effect: FixtureEffect, signal: AbortSignal) => number | Promise<number>) {
  return new ActionEffectStore<FixtureState, FixtureAction, FixtureEffect, number>({
    initialState: { value: 0, results: [] },
    reducer: (state, action) => {
      if (action.type === 'run')
        return { state, effects: [action.effect] }
      return {
        state: {
          value:
            action.result.status === 'success'
              ? action.result.output ?? state.value
              : state.value,
          results: [
            ...state.results,
            { id: action.result.effect.id, status: action.result.status },
          ],
        },
        effects: [],
      }
    },
    execute,
    taskResultAction: (result) => ({ type: 'task_result', result }),
  })
}

describe('ActionEffectStore', () => {
  it('feeds synchronous effect results back through the reducer', () => {
    const store = fixtureStore((effect) => effect.value * 2)

    store.dispatch({
      type: 'run',
      effect: { id: 'sync', key: 'fixture', value: 3 },
    })

    expect(store.getState()).toEqual({
      value: 6,
      results: [{ id: 'sync', status: 'success' }],
    })
    expect(store.pendingCount()).toBe(0)
  })

  it('cancels a superseded keyed effect and fences its late result', async () => {
    const store = fixtureStore(async (effect, signal) => {
      if (effect.id === 'old') {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await delay(5)
        return 99
      }
      await delay(1)
      return effect.value
    })

    store.dispatch({
      type: 'run',
      effect: { id: 'old', key: 'same', value: 1 },
    })
    store.dispatch({
      type: 'run',
      effect: { id: 'new', key: 'same', value: 7 },
    })
    await delay(20)

    expect(store.getState()).toEqual({
      value: 7,
      results: [
        { id: 'old', status: 'cancelled' },
        { id: 'new', status: 'success' },
      ],
    })
    expect(store.pendingCount()).toBe(0)
  })

  it('turns an uncooperative effect deadline into one timeout TaskResult', async () => {
    const store = fixtureStore(() => new Promise<number>(() => undefined))

    store.dispatch({
      type: 'run',
      effect: {
        id: 'timeout',
        key: 'deadline',
        value: 1,
        timeoutMs: 10,
      },
    })
    await delay(30)

    expect(store.getState().results).toEqual([
      { id: 'timeout', status: 'timeout' },
    ])
    expect(store.pendingCount()).toBe(0)
  })
})
