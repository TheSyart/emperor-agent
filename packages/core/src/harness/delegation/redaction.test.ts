import { describe, expect, it } from 'vitest'
import { redactExecutorText } from './redaction'
describe('executor diagnostics redaction', () => {
  it('redacts explicit secrets and standard authorization fields', () => {
    expect(
      redactExecutorText(
        'token=private-secret Authorization: Bearer abc.def.ghi access_token="another"',
        ['private-secret'],
      ),
    ).not.toMatch(/private-secret|abc\.def\.ghi|another/)
  })
  it('preserves non-secret progress and Unicode', () => {
    expect(redactExecutorText('检查 src/index.ts：通过', [])).toBe(
      '检查 src/index.ts：通过',
    )
  })
})
