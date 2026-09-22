/**
 * Bounded stream capture (ported from dsh-subprocess-local `OutputCollector`).
 *
 * One stream keeps a byte-exact in-memory tail of at most `maxBytes`. On the
 * first overflow a spill file is opened under the spill directory and every
 * chunk — the ones already collected included — is appended there, so the
 * full stream stays recoverable while it fits `maxSpillBytes`. A stream that
 * outgrows the spill cap drops its spill file (only the tail survives).
 *
 * Tail-keep rationale: errors and final results cluster at the end of
 * command output; the spill file covers the head.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** Default in-memory cap per stream (bytes). */
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000
/** Default spill-file cap per stream (bytes). */
export const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Final captured output of one stream. */
export interface CollectedOutput {
  text: string
  /** True when bytes were dropped from the in-memory tail. */
  truncated: boolean
  /** Full-stream spill file, when one was written and is intact. */
  spillPath?: string
}

/** One incremental read in whole-stream byte coordinates. */
export interface CollectorRead {
  text: string
  nextOffset: number
  /** True when `fromByte` already slid out of the retained window. */
  lossy: boolean
  spillPath?: string
}

let spillCounter = 0

export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly label: string,
    private readonly spillDir: string | undefined,
  ) {
    this.spillDisabled = maxSpillBytes === undefined || spillDir === undefined
  }

  /** Total bytes ever pushed. */
  get totalBytes(): number {
    return this.total
  }

  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined))
      this.spillAll(chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]!
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  private spillAll(chunk: Buffer): void {
    if (this.maxSpillBytes !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    try {
      if (this.spillFd === undefined) {
        mkdirSync(this.spillDir!, { recursive: true, mode: 0o700 })
        // Random suffix + O_EXCL ('wx') + owner-only mode: no path prediction or symlink planting.
        this.spillFile = join(
          this.spillDir!,
          `shell-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
        )
        this.spillFd = openSync(this.spillFile, 'wx', 0o600)
        for (const prior of this.chunks) writeSync(this.spillFd, prior)
      }
      writeSync(this.spillFd, chunk)
    } catch {
      // A spill failure never breaks capture; the tail stays authoritative.
      this.discardSpill()
    }
  }

  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* best effort */
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        /* at most maxSpillBytes left behind */
      }
    }
  }

  readFrom(fromByte: number): CollectorRead {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(this.spillFile !== undefined ? { spillPath: this.spillFile } : {}),
    }
  }

  /** Close the spill file once the stream ended (idempotent). */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      // A delayed writeback failure makes the spill unreliable; stop advertising it.
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  finalize(): CollectedOutput {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...(this.spillFile !== undefined ? { spillPath: this.spillFile } : {}),
    }
  }
}
