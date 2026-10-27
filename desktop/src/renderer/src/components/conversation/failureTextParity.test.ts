// SET-02: the conversation's browser-safe copy of the failure wording says
// exactly what Core says (groups use Core's), code by code.
import { describe, expect, it } from 'vitest'
import { modelFailureText as core } from '@emperor/core/runtime-contract'
import { modelFailureText as renderer } from '../../conversation/failureText'

const CASES = [
  { code: 'QUOTA', message: 'Insufficient Balance' },
  { code: 'AUTH', message: '401' },
  { code: 'INVALID_CREDENTIAL', message: 'blank' },
  { code: 'RATE_LIMIT', message: '429' },
  { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' },
  { code: 'SERVER', message: '503' },
  { code: 'LLM_STREAM_IDLE_TIMEOUT', message: 'idle' },
  { code: 'EMPTY_RESPONSE', message: '' },
  { code: 'INVALID_REQUEST', message: 'bad schema' },
  { code: 'INVALID_REQUEST', message: '' },
  { code: 'HTTP_418', message: 'teapot' },
  { code: 'UNKNOWN', message: '' },
  {},
]

describe('failure wording', () => {
  it('is the same in the conversation as in Core', () => {
    for (const failure of CASES) expect(renderer(failure)).toBe(core(failure))
  })
})
