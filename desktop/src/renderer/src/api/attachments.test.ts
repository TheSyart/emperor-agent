import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentRawUrl, uploadAttachment } from './attachments'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('attachment API Core IPC (MIG-IPC-010)', () => {
  it('uploads attachments through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return { id: 'att-1', name: 'note.txt' } } } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })

    await expect(uploadAttachment(file)).resolves.toMatchObject({ id: 'att-1', name: 'note.txt' })

    expect(calls[0]?.[0]).toBe('attachments.save')
    expect(calls[0]?.[1]).toMatchObject({ name: 'note.txt', mime: 'text/plain' })
    expect(calls[0]?.[1]).toHaveProperty('raw')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses the app attachment protocol for previews when Core IPC is available', () => {
    g.window = { emperor: { invokeCore: async () => ({}) } }

    expect(attachmentRawUrl('att_2026-06_abcdef12')).toBe('app://attachments/att_2026-06_abcdef12/raw')
  })

  it('does not fall back to HTTP upload when the Core IPC bridge is unavailable', async () => {
    g.window = { emperor: {} }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })

    await expect(uploadAttachment(file)).rejects.toThrow(
      'Core IPC bridge is unavailable; use the Electron desktop window.',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses the app attachment protocol for previews without probing the bridge', () => {
    delete g.window

    expect(attachmentRawUrl('att_2026-06_abcdef12')).toBe('app://attachments/att_2026-06_abcdef12/raw')
  })
})
