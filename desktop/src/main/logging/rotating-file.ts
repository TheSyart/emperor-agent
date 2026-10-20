/**
 * An append-only log file that rotates by size (REL-01): before a write
 * would take it past `maxBytes`, `main.log` becomes `main.log.1`, `.1`
 * becomes `.2` … and the oldest beyond `maxFiles` files is dropped. Writes
 * are synchronous, so the line before a crash is on disk. Logging never
 * throws: a vanished folder is created again on the next write.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_FILES = 5

export class RotatingFile {
  readonly path: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private fd: number | null = null
  private bytes = 0

  constructor(options: { path: string; maxBytes?: number; maxFiles?: number }) {
    this.path = options.path
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  }

  write(text: string): void {
    const data = Buffer.from(text, 'utf8')
    try {
      this.ensureOpen()
      if (this.bytes > 0 && this.bytes + data.length > this.maxBytes)
        this.rotate()
      this.ensureOpen()
      if (this.fd === null) return
      fs.writeSync(this.fd, data)
      this.bytes += data.length
    } catch {
      // A log must never take the app down; the next write tries again.
      this.closeFd()
    }
  }

  close(): void {
    this.closeFd()
  }

  private ensureOpen(): void {
    if (this.fd !== null) {
      // The file was deleted under us (its folder removed): start over.
      if (fs.fstatSync(this.fd).nlink > 0) return
      this.closeFd()
    }
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 })
    this.fd = fs.openSync(this.path, 'a', 0o600)
    this.bytes = fs.fstatSync(this.fd).size
  }

  private rotate(): void {
    this.closeFd()
    const name = (index: number) =>
      index === 0 ? this.path : `${this.path}.${index}`
    fs.rmSync(name(this.maxFiles - 1), { force: true })
    for (let index = this.maxFiles - 2; index >= 0; index -= 1) {
      try {
        fs.renameSync(name(index), name(index + 1))
      } catch {
        // A missing generation is fine.
      }
    }
  }

  private closeFd(): void {
    if (this.fd === null) return
    try {
      fs.closeSync(this.fd)
    } catch {
      // already closed
    }
    this.fd = null
    this.bytes = 0
  }
}
