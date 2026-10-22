import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  RotatingFile,
} from './rotating-file'

const roots: string[] = []
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-rotating-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('RotatingFile (REL-01: 5 MB × 5)', () => {
  it('rotates main.log once it would pass 5 MB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(DEFAULT_MAX_FILES).toBe(5)
    const dir = temp()
    const file = new RotatingFile({ path: join(dir, 'main.log') })
    const line = `${'x'.repeat(1023)}\n`
    // 6 MiB of lines: the first 5 MiB end up in main.log.1.
    for (let index = 0; index < 6 * 1024; index += 1) file.write(line)
    file.close()
    const current = statSync(join(dir, 'main.log')).size
    const previous = statSync(join(dir, 'main.log.1')).size
    expect(current).toBe(1024 * 1024)
    expect(previous).toBe(DEFAULT_MAX_BYTES)
    expect(current + previous).toBe(6 * 1024 * 1024)
  })

  it('keeps at most five files, dropping the oldest', () => {
    const dir = temp()
    const file = new RotatingFile({
      path: join(dir, 'core.log'),
      maxBytes: 10,
      maxFiles: 5,
    })
    for (let index = 0; index < 8; index += 1) file.write(`line-${index}\n`)
    file.close()
    expect(readdirSync(dir).sort()).toEqual([
      'core.log',
      'core.log.1',
      'core.log.2',
      'core.log.3',
      'core.log.4',
    ])
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toBe('line-7\n')
    expect(readFileSync(join(dir, 'core.log.1'), 'utf8')).toBe('line-6\n')
    expect(readFileSync(join(dir, 'core.log.4'), 'utf8')).toBe('line-3\n')
  })

  it('continues an existing log and counts its bytes', () => {
    const dir = temp()
    writeFileSync(join(dir, 'main.log'), 'before\n')
    const file = new RotatingFile({
      path: join(dir, 'main.log'),
      maxBytes: 12,
    })
    file.write('next\n')
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toBe('before\nnext\n')
    file.write('third\n')
    file.close()
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toBe('third\n')
    expect(readFileSync(join(dir, 'main.log.1'), 'utf8')).toBe('before\nnext\n')
  })

  it('creates the folder and keeps the files private', () => {
    const dir = join(temp(), 'Logs', 'Emperor Agent')
    const file = new RotatingFile({ path: join(dir, 'main.log') })
    file.write('hello\n')
    file.close()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'main.log')).mode & 0o777).toBe(0o600)
  })

  it('never throws when the folder disappears, and writes again later', () => {
    const dir = join(temp(), 'logs')
    const file = new RotatingFile({ path: join(dir, 'main.log'), maxBytes: 8 })
    file.write('one\n')
    rmSync(dir, { recursive: true, force: true })
    expect(() => file.write('two-two\n')).not.toThrow()
    expect(() => file.write('three\n')).not.toThrow()
    file.close()
    expect(existsSync(join(dir, 'main.log'))).toBe(true)
  })
})
