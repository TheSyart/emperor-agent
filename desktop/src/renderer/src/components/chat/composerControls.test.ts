import { describe, expect, it } from 'vitest'
import { composerSendDisabled } from './composerControls'

describe('composer control model', () => {
  it('keeps the stop button clickable while a turn is busy', () => {
    expect(composerSendDisabled({ busy: true, content: '', attachmentCount: 0 })).toBe(false)
  })

  it('disables send only when idle with no content or attachments', () => {
    expect(composerSendDisabled({ busy: false, content: '', attachmentCount: 0 })).toBe(true)
    expect(composerSendDisabled({ busy: false, content: 'hi', attachmentCount: 0 })).toBe(false)
    expect(composerSendDisabled({ busy: false, content: '', attachmentCount: 1 })).toBe(false)
  })
})
