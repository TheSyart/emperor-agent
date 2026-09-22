import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  previewMcpImport: vi.fn(),
  importMcpServers: vi.fn(),
}))
vi.mock('../../../api/mcp', () => api)

import {
  MCP_PREVIEW_DEBOUNCE_MS,
  useMcpImportPreview,
} from './useMcpImportPreview'

function plan(action: 'add' | 'update' | 'skip', conflict = false) {
  return {
    added: action === 'add' ? ['aihot'] : [],
    updated: action === 'update' ? ['aihot'] : [],
    skipped: action === 'skip' ? ['aihot'] : [],
    conflicts: conflict ? ['aihot'] : [],
    warnings: [],
    servers: [
      {
        name: 'aihot',
        transport: 'http',
        target: 'https://aihot.news/api/mcp',
        enabled: true,
        action,
        conflict,
      },
    ],
    dryRun: true,
  }
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await nextTick()
}

let scope: ReturnType<typeof effectScope> | null = null

function setup(initial: unknown = null) {
  const raw = ref<any>(initial)
  scope = effectScope()
  const state = scope.run(() => useMcpImportPreview(() => raw.value))!
  return { raw, state }
}

beforeEach(() => {
  vi.useFakeTimers()
  api.previewMcpImport.mockReset()
  api.importMcpServers.mockReset()
})

afterEach(() => {
  scope?.stop()
  scope = null
  vi.useRealTimers()
})

describe('useMcpImportPreview', () => {
  it('debounces the dry run and asks Core with overwrite: true', async () => {
    api.previewMcpImport.mockResolvedValue(plan('add'))
    const { raw, state } = setup()
    raw.value = '{"a"'
    await nextTick()
    raw.value = '{"mcpServers":{}}'
    await nextTick()
    expect(state.pending.value).toBe(true)
    expect(api.previewMcpImport).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()
    expect(api.previewMcpImport).toHaveBeenCalledTimes(1)
    expect(api.previewMcpImport).toHaveBeenCalledWith('{"mcpServers":{}}', {
      overwrite: true,
    })
    expect(state.pending.value).toBe(false)
    expect(state.rows.value[0]).toMatchObject({ name: 'aihot', kind: 'add' })
    expect(state.canImport.value).toBe(true)
  })

  it('keeps a pending run when an equal raw object is re-emitted', async () => {
    api.previewMcpImport.mockResolvedValue(plan('add'))
    const { raw, state } = setup()
    raw.value = { mcpServers: { aihot: { url: 'https://a.test' } } }
    await nextTick()
    raw.value = { mcpServers: { aihot: { url: 'https://a.test' } } }
    await nextTick()
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()
    expect(api.previewMcpImport).toHaveBeenCalledTimes(1)
    expect(state.pending.value).toBe(false)
    expect(state.rows.value).toHaveLength(1)
  })

  it('drops stale replies and surfaces Core errors', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    api.previewMcpImport
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('无法解析 MCP 配置：不是有效的 JSON'), {
          code: 'mcp_import_invalid',
        }),
      )
    const { raw, state } = setup('first')
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    raw.value = 'second'
    await nextTick()
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()
    resolveFirst(plan('add'))
    await settle()
    expect(state.error.value).toBe('无法解析 MCP 配置：不是有效的 JSON')
    expect(state.rows.value).toEqual([])
    expect(state.canImport.value).toBe(false)

    raw.value = null
    await nextTick()
    expect(state.error.value).toBe('')
    expect(state.pending.value).toBe(false)
  })

  it('imports with the chosen overwrite names only', async () => {
    api.previewMcpImport.mockResolvedValue(plan('update', true))
    api.importMcpServers.mockResolvedValue({ ...plan('update', true) })
    const { state } = setup('{"mcpServers":{"aihot":{}}}')
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()
    expect(state.rows.value[0]).toMatchObject({
      kind: 'skip',
      overwritable: true,
    })
    expect(state.canImport.value).toBe(false)

    state.setOverwrite('aihot', true)
    expect(state.rows.value[0]!.kind).toBe('update')
    expect(state.canImport.value).toBe(true)
    await state.commit()
    expect(api.importMcpServers).toHaveBeenCalledWith(
      '{"mcpServers":{"aihot":{}}}',
      { overwrite: ['aihot'] },
    )

    state.setOverwrite('aihot', false)
    await state.commit()
    expect(api.importMcpServers).toHaveBeenLastCalledWith(
      '{"mcpServers":{"aihot":{}}}',
      {},
    )
  })
})
