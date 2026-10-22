/**
 * FIX-16: what an executor reported when its turn failed, in one readable
 * Chinese line. A JSON error payload (OpenAI / Codex, or Claude's
 * `API Error: <status> {…}`) reads as status, type and message; a model the
 * account cannot use is EXECUTOR_MODEL_UNSUPPORTED and says which model and
 * where to change it. Never a key or a token.
 */
import { expect, it } from 'vitest'
import { describeTurnError } from './failure'
import { codexModelRejection } from './testing'

const CODEX_SETTING =
  '请在 设置 › 子智能体 › Codex › 默认模型 里换一个可用的模型。'

it('2 · the 400 Codex gives a ChatGPT login for a model it does not offer names the model and where to change it', () => {
  expect(
    describeTurnError(codexModelRejection('gpt-6.1-sol'), 'codex'),
  ).toEqual({
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    model: 'gpt-6.1-sol',
    reason: `Codex 不支持模型 gpt-6.1-sol（ChatGPT 账号登录）。${CODEX_SETTING}`,
  })
})

it('2 · OpenAI’s model_not_found and Claude’s refusals of a model are the same failure', () => {
  expect(
    describeTurnError(
      JSON.stringify({
        error: {
          message:
            'The model `gpt-9-preview` does not exist or you do not have access to it.',
          type: 'invalid_request_error',
          param: null,
          code: 'model_not_found',
        },
      }),
      'codex',
    ),
  ).toEqual({
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    model: 'gpt-9-preview',
    reason: `Codex 不支持模型 gpt-9-preview。${CODEX_SETTING}`,
  })
  const claude =
    '请在 设置 › 子智能体 › Claude Code › 默认模型 里换一个可用的模型。'
  expect(
    describeTurnError(
      'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-9"},"request_id":"req_011CUx"}',
      'claude-code',
    ),
  ).toEqual({
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    model: 'claude-opus-9',
    reason: `Claude Code 不支持模型 claude-opus-9。${claude}`,
  })
  expect(
    describeTurnError(
      "There's an issue with the selected model (claude-sonnet-9). It may not exist or you may not have access to it. Run /model to pick a different model.",
      'claude-code',
    ),
  ).toMatchObject({
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    model: 'claude-sonnet-9',
  })
})

it('2 · a refusal that does not name its model uses the model the run reported, or says the current one', () => {
  expect(
    describeTurnError(
      '{"status":400,"error":{"type":"invalid_request_error","message":"The requested model is not supported."}}',
      'codex',
      { model: 'gpt-6.1-sol' },
    )?.reason,
  ).toBe(`Codex 不支持模型 gpt-6.1-sol。${CODEX_SETTING}`)
  expect(
    describeTurnError(
      '{"status":400,"error":{"type":"invalid_request_error","message":"The requested model is not supported."}}',
      'codex',
    )?.reason,
  ).toBe(`Codex 不支持当前使用的模型。${CODEX_SETTING}`)
})

it('1 · any other JSON error reads as what happened, its status and type, and the provider’s message', () => {
  expect(
    describeTurnError(
      '{"type":"error","status":500,"error":{"type":"server_error","message":"The server had an error while processing your request."}}',
      'codex',
    ),
  ).toEqual({
    reason:
      'Codex 这一轮失败：服务暂时出错（HTTP 500，server_error）：The server had an error while processing your request.',
  })
  expect(
    describeTurnError(
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      'claude-code',
    )?.reason,
  ).toBe(
    'Claude Code 这一轮失败：被限流了（HTTP 429，rate_limit_error）：Number of request tokens has exceeded your per-minute rate limit',
  )
})

it('1 · plain text is kept after the opening words; nothing at all is no reason', () => {
  expect(describeTurnError('tool crashed', 'codex')).toEqual({
    reason: 'Codex 这一轮失败：tool crashed',
  })
  expect(describeTurnError('   ', 'codex')).toBeUndefined()
  expect(describeTurnError(undefined, 'codex')).toBeUndefined()
})

it('never carries a key, a token or the run’s own secret values', () => {
  const secret = 'sk-live-0123456789abcdefghijklmnop'
  const reason = describeTurnError(
    JSON.stringify({
      status: 401,
      error: {
        type: 'invalid_api_key',
        message: `Incorrect API key provided: ${secret}. Authorization: Bearer ${secret}`,
      },
    }),
    'codex',
    { secrets: [secret] },
  )!.reason
  expect(reason).toMatch(
    /^Codex 这一轮失败：认证失败（HTTP 401，invalid_api_key）：/,
  )
  expect(reason).not.toContain(secret)
  expect(
    describeTurnError('token fixture-run-secret-value leaked', 'codex', {
      secrets: ['fixture-run-secret-value'],
    })!.reason,
  ).not.toContain('fixture-run-secret-value')
})
