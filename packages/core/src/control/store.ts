/**
 * ControlStore (MIG-CTRL-001)。对齐 Python `agent/control/store.py`。
 * 磁盘格式: <stateRoot>/control/state.json，indent=2；解析失败回退默认。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  SCHEMA_VERSION,
  controlStateFromDict,
  controlStateToDict,
  defaultControlState,
  type ControlState,
} from './models'

export class ControlStore {
  readonly root: string
  readonly controlDir: string
  readonly stateFile: string

  constructor(root: string) {
    this.root = resolve(root)
    this.controlDir = join(this.root, 'control')
    this.stateFile = join(this.controlDir, 'state.json')
    this.ensure()
  }

  private ensure(): void {
    mkdirSync(this.controlDir, { recursive: true })
    this.copyLegacyStateIfNeeded()
    if (!existsSync(this.stateFile)) this.save(defaultControlState())
  }

  load(): ControlState {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.stateFile, 'utf8') || '{}')
    } catch {
      return defaultControlState()
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultControlState()
    return controlStateFromDict(raw as Record<string, unknown>)
  }

  save(state: ControlState): void {
    const payload = controlStateToDict(state)
    payload.version = Number(payload.version ?? SCHEMA_VERSION) || SCHEMA_VERSION
    this.atomicWriteJson(this.stateFile, payload)
  }

  private atomicWriteJson(path: string, payload: Record<string, unknown>): void {
    mkdirSync(this.controlDir, { recursive: true })
    const tmp = join(this.controlDir, `.state.json.${randomUUID().replace(/-/g, '')}.tmp`)
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  private copyLegacyStateIfNeeded(): void {
    const legacy = join(this.root, 'memory', 'control', 'state.json')
    if (existsSync(this.stateFile) || !existsSync(legacy)) return
    try { copyFileSync(legacy, this.stateFile) } catch { /* non-destructive best effort */ }
  }
}
