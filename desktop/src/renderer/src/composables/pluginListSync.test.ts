// @vitest-environment jsdom
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapPayload, PluginSummary } from '../types'
import { followPluginList } from './pluginListSync'

let stop = () => {}

afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('followPluginList', () => {
  it('re-reads the plugin list once per burst of plugins_changed, and ignores other events', async () => {
    vi.useFakeTimers()
    const listeners: Array<(event: unknown) => void> = []
    const next = [{ pluginId: 'github' }] as PluginSummary[]
    const invokeCore = vi.fn(async () => next)
    ;(window as unknown as { emperor: unknown }).emperor = {
      invokeCore,
      onCoreEvent: (listener: (event: unknown) => void) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    }
    const boot = ref({ plugins: [] } as unknown as BootstrapPayload)
    stop = followPluginList(boot)

    for (const listener of listeners) {
      listener({ event: 'computer_use_changed', reason: 'state' })
      listener({ event: 'plugins_changed', reason: 'plugins' })
      listener({ event: 'plugins_changed', reason: 'project' })
    }
    await vi.advanceTimersByTimeAsync(200)
    expect(invokeCore).toHaveBeenCalledTimes(1)
    expect(invokeCore).toHaveBeenCalledWith('plugins.list')
    expect(boot.value.plugins).toEqual(next)

    stop()
    expect(listeners).toHaveLength(0)
  })
})
