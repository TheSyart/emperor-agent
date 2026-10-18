import { expect, it } from 'vitest'
import { DelegationError } from './types'
it('returns actionable safe IPC errors without exposing native diagnostic details', () => {
  const value = new DelegationError(
    'INTEGRATION_CONFLICT',
    'sensitive native diagnostic',
  )
  expect(value.toSafe()).toEqual({
    code: 'INTEGRATION_CONFLICT',
    message: '工作区或 Git 索引已改变，请重新生成整合预览。',
    action: 'regenerate_integration_preview',
  })
  expect(JSON.stringify(value.toSafe())).not.toContain('sensitive')
})
it('keeps unknown native details and malformed error codes out of IPC', () => {
  const value = new DelegationError('bad\nsecret-token', 'secret token value')
  expect(value.toSafe().code).toBe('EXTERNAL_OPERATION_FAILED')
  expect(JSON.stringify(value.toSafe())).not.toContain('secret')
})
