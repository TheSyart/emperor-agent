import { describe, expect, it } from 'vitest'
import { redactLogText } from './redaction'

describe('redactLogText (REL-01: what a log line may keep)', () => {
  it('turns sk- style keys into sk-***', () => {
    const line = redactLogText(
      'model sk-abc123def456ghi failed; retry with sk-ant-api03-Zx9_q-1 and sk-proj-abcd1234',
    )
    expect(line).toBe('model sk-*** failed; retry with sk-*** and sk-***')
    expect(redactLogText('key sk-abc')).toBe('key sk-***')
  })

  it('hides Authorization headers and bearer tokens', () => {
    expect(redactLogText('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: ***',
    )
    expect(redactLogText('{"authorization":"Basic Zm9vOmJhcg=="}')).toBe(
      '{"authorization":"***"}',
    )
    expect(redactLogText('proxy-authorization: Digest x=1')).toBe(
      'proxy-authorization: ***',
    )
    expect(redactLogText('sent Bearer eyJabc to host')).toBe(
      'sent Bearer *** to host',
    )
    expect(redactLogText('x-api-key: abc123')).toBe('x-api-key: ***')
  })

  it('hides tokens in URLs and keeps the rest of the address', () => {
    expect(
      redactLogText(
        'GET https://api.example.com/v1/models?key=AIza123&model=x',
      ),
    ).toBe('GET https://api.example.com/v1/models?key=***&model=x')
    expect(redactLogText('wss://relay.example/ws?access_token=abc#x')).toBe(
      'wss://relay.example/ws?access_token=***#x',
    )
    expect(redactLogText('https://example.com/cb#id_token=abc&state=ok')).toBe(
      'https://example.com/cb#id_token=***&state=ok',
    )
    expect(redactLogText('https://user:p4ss@git.example.com/repo.git')).toBe(
      'https://***@git.example.com/repo.git',
    )
    expect(
      redactLogText(
        'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abc&X-Amz-Credential=AKIA',
      ),
    ).toBe(
      'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=***&X-Amz-Credential=***',
    )
  })

  it('hides keys written as JSON, env or flags', () => {
    expect(redactLogText('{"apiKey":"abc123","model":"x"}')).toBe(
      '{"apiKey":"***","model":"x"}',
    )
    expect(redactLogText('api_key=abc123 token=zz password: hunter2')).toBe(
      'api_key=*** token=*** password: ***',
    )
    expect(redactLogText('OPENAI_API_KEY=abc GH_TOKEN=ghx')).toBe(
      'OPENAI_API_KEY=*** GH_TOKEN=***',
    )
    expect(redactLogText('--api-key abc123 --token=zz')).toBe(
      '--api-key *** --token=***',
    )
    expect(
      redactLogText('pushed with ghp_0123456789abcdefghijABCDEFGHIJ'),
    ).toBe('pushed with ***')
  })

  it('keeps ordinary text, paths and usage counts', () => {
    const plain =
      'turn done {"inputTokens":120,"maxTokens":4096,"tokens":7} in /Users/me/.emperor/sessions/s1'
    expect(redactLogText(plain)).toBe(plain)
    expect(redactLogText('desk-top and task-list stay')).toBe(
      'desk-top and task-list stay',
    )
  })

  it('is stable when applied twice', () => {
    const once = redactLogText(
      'Authorization: Bearer sk-abc123 https://x.example/?token=t&a=1 {"apiKey":"k"}',
    )
    expect(redactLogText(once)).toBe(once)
  })
})
