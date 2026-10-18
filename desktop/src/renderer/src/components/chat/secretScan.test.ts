import { describe, expect, it } from 'vitest'
import { findSecrets, maskSecrets, SECRET_MASK } from './secretScan'

describe('secret scan before sending', () => {
  it('finds provider API keys', () => {
    const key = 'sk-proj-AbCdEf0123456789AbCdEf0123456789'
    const text = `用这个 key: ${key} 试试`
    const start = text.indexOf(key)
    expect(findSecrets(text)).toEqual([
      { start, end: start + key.length, kind: 'api-key' },
    ])
    expect(findSecrets('sk-ant-api03-' + 'x'.repeat(40))[0]?.kind).toBe(
      'api-key',
    )
  })

  it('finds tokens and private keys', () => {
    expect(findSecrets('ghp_' + 'a'.repeat(36))[0]?.kind).toBe('token')
    expect(findSecrets('AKIA' + 'ABCDEFGHIJKLMNOP')[0]?.kind).toBe('token')
    expect(findSecrets('xoxb-1234-5678-abcdefghij')[0]?.kind).toBe('token')
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
    expect(findSecrets(`看看 ${pem} 行吗`)).toEqual([
      { start: 3, end: 3 + pem.length, kind: 'private-key' },
    ])
  })

  it('leaves ordinary text alone', () => {
    expect(findSecrets('ask the sk-learn docs, see task-123 and skip')).toEqual(
      [],
    )
    expect(findSecrets('')).toEqual([])
  })

  it('masks every match and keeps chips after it in place', () => {
    const key = 'sk-' + 'Z'.repeat(32)
    const text = `key ${key} then /review`
    const start = text.indexOf('/review')
    const masked = maskSecrets(text, [
      { kind: 'skill', id: 'review', label: 'review', start, end: start + 7 },
    ])
    expect(masked.content).toBe(`key ${SECRET_MASK} then /review`)
    expect(masked.content).not.toContain(key)
    const ref = masked.references[0]!
    expect(masked.content.slice(ref.start, ref.end)).toBe('/review')
  })

  it('drops a chip that overlaps a masked span', () => {
    const key = 'sk-' + 'Q'.repeat(32)
    const masked = maskSecrets(key, [
      { kind: 'skill', id: 'x', label: 'x', start: 0, end: 5 },
    ])
    expect(masked).toEqual({ content: SECRET_MASK, references: [] })
  })
})
