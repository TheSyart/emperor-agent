// SET-02: a model request that fails says so in Chinese, with where to fix
// it; the provider's own words stay only for codes Emperor does not know.
import { describe, expect, it } from 'vitest'
import { modelFailureText } from './failure-text'

describe('modelFailureText', () => {
  it('says the balance ran out and where to go (QUOTA)', () => {
    const text = modelFailureText({
      code: 'QUOTA',
      status: 402,
      message: 'Insufficient Balance (request_id: 71185fa4)',
    })
    expect(text).toMatch(/余额或额度用完/)
    expect(text).toContain('设置 › 模型')
    expect(text).not.toContain('Insufficient')
  })

  it('points a bad key at 设置 › 模型 (AUTH, INVALID_CREDENTIAL)', () => {
    for (const code of ['AUTH', 'INVALID_CREDENTIAL'])
      expect(modelFailureText({ code, message: '401 Unauthorized' })).toMatch(
        /API Key.*设置 › 模型/,
      )
  })

  it('asks to wait when rate limited, and to compact when too long', () => {
    expect(modelFailureText({ code: 'RATE_LIMIT', message: 'x' })).toMatch(
      /限流/,
    )
    expect(
      modelFailureText({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'x' }),
    ).toMatch(/\/compact/)
  })

  it('says a server error or a silent model in plain words', () => {
    expect(modelFailureText({ code: 'SERVER', message: '503' })).toMatch(
      /暂时出错/,
    )
    expect(
      modelFailureText({ code: 'LLM_STREAM_IDLE_TIMEOUT', message: 'idle' }),
    ).toMatch(/很久没有回应/)
    expect(modelFailureText({ code: 'EMPTY_RESPONSE', message: '' })).toMatch(
      /空的回答/,
    )
  })

  it('keeps the provider words for a request it refused, after a Chinese lead', () => {
    expect(
      modelFailureText({ code: 'INVALID_REQUEST', message: 'bad tool schema' }),
    ).toBe('模型服务拒绝了这次请求：bad tool schema')
  })

  it('leaves an unknown code as the provider said it', () => {
    expect(modelFailureText({ code: 'HTTP_418', message: 'teapot' })).toBe(
      'teapot',
    )
    expect(modelFailureText({ code: 'UNKNOWN', message: '' })).toBe('UNKNOWN')
    expect(modelFailureText({})).toBe('模型请求失败')
  })
})
