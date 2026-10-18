import { expect, it } from 'vitest'
import { mergeExternalTranscript } from './external-transcript'
it('joins adjacent assistant deltas without inserting role prefixes inside words or crossing tool boundaries', () => {
  const raw = [
    { role: 'assistant', content: 'Created `su' },
    { role: 'assistant', content: 'm.m' },
    { role: 'assistant', content: 'js`' },
    { role: 'tool', content: 'fileChange' },
    { role: 'assistant', content: 'Done' },
    { role: 'assistant', content: '.' },
  ]
  const before = structuredClone(raw)
  expect(mergeExternalTranscript(raw)).toEqual([
    { role: 'assistant', content: 'Created `sum.mjs`' },
    { role: 'tool', content: 'fileChange' },
    { role: 'assistant', content: 'Done.' },
  ])
  expect(raw).toEqual(before)
})
