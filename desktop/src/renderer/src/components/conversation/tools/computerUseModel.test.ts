import { describe, expect, it } from 'vitest'
import type { ToolChatData } from '../../../conversation/types'
import {
  computerUseMeta,
  computerUseSummary,
  computerUseSuffix,
  computerUseSuffixTone,
  computerUseTitle,
  formatBytes,
  isComputerUseTool,
} from './computerUseModel'
import { toolView } from './registry'

function data(
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): ToolChatData {
  return {
    callId: 'call-1',
    name,
    argsRaw: JSON.stringify(args),
    turn: 1,
    step: 1,
    time: 0,
    status: meta === undefined ? 'running' : 'settled',
    approvals: [],
    ...(meta === undefined
      ? {}
      : {
          result: {
            seq: 2,
            time: 1,
            content: [],
            isError: false,
            meta: { computerUse: { v: 1, tool: name, ...meta } },
          },
        }),
  }
}

describe('computer use tool rows', () => {
  it('routes every GUI tool family to the Computer Use body', () => {
    for (const name of ['browser_click', 'ui_list_targets', 'desktop_click'])
      expect(toolView(name).body).toBe('computer')
    expect(isComputerUseTool('mcp_browser_click')).toBe(false)
    expect(toolView('mcp_playwright_browser_click').body).toBe('mcp')
    expect(computerUseTitle('browser_fill')).toBe('填写')
    expect(computerUseTitle('desktop_future')).toBe('desktop_future')
  })

  it('summarises host, ref and key without page text', () => {
    expect(
      computerUseSummary(
        data('browser_open', { url: 'https://example.com/a?b=1' }),
      ),
    ).toBe('example.com')
    expect(
      computerUseSummary(
        data(
          'browser_click',
          { ref: 'r3.4' },
          {
            target: { url: 'https://example.com/form', title: 'Form' },
          },
        ),
      ),
    ).toBe('example.com · r3.4')
    expect(
      computerUseSummary(data('browser_navigate', { history: 'back' })),
    ).toBe('后退')
  })

  it('reads the structured meta and flags unknown outcomes first', () => {
    const settled = data(
      'browser_click',
      { ref: 'r1.1' },
      {
        driver: 'embedded-browser',
        target: { url: 'https://example.com/', title: 'Example' },
        outcome: 'unknown',
        autoApproved: true,
        screenshot: { attachmentId: 'att_1', width: 800, height: 600 },
      },
    )
    expect(computerUseMeta(settled)).toMatchObject({
      driver: 'embedded-browser',
      url: 'https://example.com/',
      title: 'Example',
      outcome: 'unknown',
      autoApproved: true,
      screenshot: { attachmentId: 'att_1', width: 800, height: 600 },
    })
    expect(computerUseSuffix(settled)).toBe('结果不确定')
    expect(computerUseSuffixTone(settled)).toBe('warn')
    expect(
      computerUseSuffix(
        data('browser_click', {}, { outcome: 'observed', autoApproved: true }),
      ),
    ).toBe('自动放行')
    expect(
      computerUseSuffixTone(
        data('browser_click', {}, { outcome: 'observed', autoApproved: true }),
      ),
    ).toBe('accent')
    expect(
      computerUseSuffixTone(data('browser_click', {}, { outcome: 'observed' })),
    ).toBeNull()
    const failed = data(
      'browser_click',
      { ref: 'r1.1' },
      {
        error: {
          code: 'STALE_ELEMENT',
          message: 'old ref',
          hint: 'observe again',
          retryable: true,
        },
      },
    )
    expect(computerUseSummary(failed)).toBe('STALE_ELEMENT')
    expect(computerUseMeta(failed)?.error).toEqual({
      code: 'STALE_ELEMENT',
      message: 'old ref',
      hint: 'observe again',
      retryable: true,
    })
    expect(computerUseMeta(data('browser_click', {}))).toBeNull()
  })
})

describe('computer use downloads', () => {
  it('reads the download block and formats sizes', () => {
    const meta = computerUseMeta(
      data(
        'browser_download',
        { ref: 'r2.1' },
        {
          outcome: 'observed',
          download: {
            downloadId: 'dl_0123456789ab',
            state: 'completed',
            filename: 'report.csv',
            bytes: 1536,
          },
        },
      ),
    )
    expect(meta?.download).toEqual({
      downloadId: 'dl_0123456789ab',
      state: 'completed',
      filename: 'report.csv',
      bytes: 1536,
    })
    expect(computerUseTitle('browser_download')).toBe('下载文件')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
  })
})
