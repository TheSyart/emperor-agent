import { expect, it } from 'vitest'
import { validPng } from './image-proof'
const image = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
    'base64',
  )
it('validates actual compressed PNG scanlines and rejects truncation, damaged CRC and header-only fakes', () => {
  expect(validPng(image())).toBe(true)
  expect(validPng(image().subarray(0, 33))).toBe(false)
  const crc = image()
  crc[50] = crc[50]! ^ 1
  expect(validPng(crc)).toBe(false)
  const header = Buffer.alloc(33)
  image().subarray(0, 24).copy(header)
  expect(validPng(header)).toBe(false)
  const trailing = Buffer.concat([image(), Buffer.from('junk')])
  expect(validPng(trailing)).toBe(false)
})
