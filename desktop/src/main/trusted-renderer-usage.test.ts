import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

describe('trusted renderer policy wiring', () => {
  it('guards navigation, redirects, popups, Core IPC, and desktop IPC', () => {
    expect(source).toContain("webContents.on('will-navigate'")
    expect(source).toContain("webContents.on('will-redirect'")
    expect(source).toContain('webContents.setWindowOpenHandler')
    expect(source).toContain('authorizeIpc: (event) =>')

    for (const channel of [
      'emperor:select-directory',
      'emperor:open-path',
      'emperor:pet:open',
      'emperor:pet:close',
      'emperor:pet:status',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `ipcMain\\.handle\\('${channel}'[\\s\\S]{0,180}trustedRendererPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )
    }

    for (const channel of [
      'emperor:pet:renderer-bootstrap',
      'emperor:pet:renderer-close',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `ipcMain\\.handle\\('${channel}'[\\s\\S]{0,220}trustedPetPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )
    }
  })
})
