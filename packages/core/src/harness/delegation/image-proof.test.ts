import { realpathSync } from 'node:fs'
import { expect, it } from 'vitest'
import { nativeGeneratedImageRoot, validPng } from './image-proof'
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

it('rejects redirected delegation and state directories even when their image subdirectory is real', async () => {
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync } =
      await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'emperor-native-root-'))
  try {
    const base = join(root, 'trusted'),
      foreign = join(root, 'foreign', 'dlg-b'),
      own = join(base, 'runtime', 'state-a', 'dlg-a')
    mkdirSync(join(foreign, 'codex', 'generated_images'), { recursive: true })
    mkdirSync(join(base, 'runtime', 'state-a'), { recursive: true })
    symlinkSync(foreign, own)
    expect(nativeGeneratedImageRoot(own, base)).toBeUndefined()
    rmSync(own)
    symlinkSync(
      join(root, 'foreign'),
      join(base, 'runtime', 'state-a', 'redirected-state'),
    )
    expect(
      nativeGeneratedImageRoot(
        join(base, 'runtime', 'state-a', 'redirected-state', 'dlg-b'),
        base,
      ),
    ).toBeUndefined()
    rmSync(join(base, 'runtime', 'state-a', 'redirected-state'))
    mkdirSync(join(own, 'codex', 'generated_images'), { recursive: true })
    expect(nativeGeneratedImageRoot(own, base)).toBe(
      realpathSync(join(own, 'codex', 'generated_images')),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
