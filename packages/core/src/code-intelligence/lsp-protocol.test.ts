import { describe, expect, it } from 'vitest'
import { LspContentLengthDecoder, encodeLspMessage } from './lsp-protocol'

describe('LspContentLengthDecoder', () => {
  it('decodes fragmented and coalesced Content-Length frames', () => {
    const decoder = new LspContentLengthDecoder()
    const first = encodeLspMessage({ jsonrpc: '2.0', id: 1, result: 'alpha' })
    const second = encodeLspMessage({ jsonrpc: '2.0', method: 'ready' })

    expect(decoder.append(first.subarray(0, 11))).toEqual([])
    expect(decoder.append(Buffer.concat([first.subarray(11), second]))).toEqual(
      [
        { jsonrpc: '2.0', id: 1, result: 'alpha' },
        { jsonrpc: '2.0', method: 'ready' },
      ],
    )
  })

  it('fails closed on oversized headers, oversized bodies and malformed JSON', () => {
    const oversizedHeader = new LspContentLengthDecoder({ maxHeaderBytes: 16 })
    expect(() => oversizedHeader.append(Buffer.from('X'.repeat(17)))).toThrow(
      /header/i,
    )

    const oversizedBody = new LspContentLengthDecoder({ maxBodyBytes: 8 })
    expect(() =>
      oversizedBody.append(Buffer.from('Content-Length: 9\r\n\r\n')),
    ).toThrow(/body/i)

    const malformed = new LspContentLengthDecoder()
    expect(() =>
      malformed.append(Buffer.from('Content-Length: 1\r\n\r\n{')),
    ).toThrow(/JSON/i)
  })

  it('rejects duplicate, missing and non-decimal Content-Length headers', () => {
    for (const header of [
      'Content-Type: application/json\r\n\r\n',
      'Content-Length: 1\r\nContent-Length: 1\r\n\r\n{}',
      'Content-Length: 1e3\r\n\r\n',
    ]) {
      const decoder = new LspContentLengthDecoder()
      expect(() => decoder.append(Buffer.from(header))).toThrow(
        /Content-Length/i,
      )
    }
  })
})
