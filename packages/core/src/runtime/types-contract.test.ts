import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from './types'

const projectProcessUpdate = {
  event: 'project_process_update',
  process: { id: 'process-1', status: 'running' },
} satisfies RuntimeEvent

const websitePreviewUpdate = {
  event: 'website_preview_update',
  preview: { id: 'site-1', status: 'ready' },
} satisfies RuntimeEvent

describe('project runtime wire contract', () => {
  it('keeps project process and website preview events in the Core runtime union', () => {
    expect([projectProcessUpdate.event, websitePreviewUpdate.event]).toEqual([
      'project_process_update',
      'website_preview_update',
    ])
  })
})
