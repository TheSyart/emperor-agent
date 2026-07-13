import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  resolveAssetPath,
  resolveAttachmentRawPath,
  resolveMediaRawPath,
} from './protocol'

const ROOT = path.join(path.parse(process.cwd()).root, 'app', 'out', 'renderer')

describe('resolveAssetPath', () => {
  it('maps the root path to index.html', () => {
    expect(resolveAssetPath('/', ROOT)).toBe(path.join(ROOT, 'index.html'))
  })

  it('serves real asset files with an extension', () => {
    expect(resolveAssetPath('/assets/index-abc.js', ROOT)).toBe(
      path.join(ROOT, 'assets/index-abc.js'),
    )
  })

  it('falls back to index.html for extensionless deep-link routes', () => {
    expect(resolveAssetPath('/chat', ROOT)).toBe(path.join(ROOT, 'index.html'))
    expect(resolveAssetPath('/skills/foo', ROOT)).toBe(
      path.join(ROOT, 'index.html'),
    )
  })

  it('blocks directory traversal by falling back to index.html', () => {
    expect(resolveAssetPath('/../etc/passwd', ROOT)).toBe(
      path.join(ROOT, 'index.html'),
    )
    expect(resolveAssetPath('/../../secret.js', ROOT)).toBe(
      path.join(ROOT, 'index.html'),
    )
  })
})

describe('resolveAttachmentRawPath', () => {
  it('maps app://attachments/{id}/raw to an attachment file under stateRoot/memory/attachments', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-attachment-protocol-state-'),
    )
    const dir = path.join(stateRoot, 'memory', 'attachments', '2026-06')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'abcdef12-photo.png'), 'image')

    expect(
      resolveAttachmentRawPath('app://attachments/att_2026-06_abcdef12/raw', {
        stateRoot,
      }),
    ).toBe(path.join(dir, 'abcdef12-photo.png'))
  })

  it('falls back to legacyRuntimeRoot when the file is not under stateRoot (read-only, no migration)', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-attachment-protocol-state-'),
    )
    const legacyRuntimeRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-attachment-protocol-legacy-'),
    )
    const legacyDir = path.join(
      legacyRuntimeRoot,
      'memory',
      'attachments',
      '2026-05',
    )
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, '12345678-old.png'), 'legacy image')

    const resolved = resolveAttachmentRawPath(
      'app://attachments/att_2026-05_12345678/raw',
      { stateRoot, legacyRuntimeRoot },
    )

    expect(resolved).toBe(path.join(legacyDir, '12345678-old.png'))
  })

  it('prefers stateRoot over legacyRuntimeRoot when both have a matching file', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-attachment-protocol-state-'),
    )
    const legacyRuntimeRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-attachment-protocol-legacy-'),
    )
    const newDir = path.join(stateRoot, 'memory', 'attachments', '2026-06')
    const legacyDir = path.join(
      legacyRuntimeRoot,
      'memory',
      'attachments',
      '2026-06',
    )
    mkdirSync(newDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(newDir, 'abcdef12-photo.png'), 'new image')
    writeFileSync(path.join(legacyDir, 'abcdef12-photo.png'), 'legacy image')

    const resolved = resolveAttachmentRawPath(
      'app://attachments/att_2026-06_abcdef12/raw',
      { stateRoot, legacyRuntimeRoot },
    )

    expect(resolved).toBe(path.join(newDir, 'abcdef12-photo.png'))
  })

  it('rejects malformed attachment URLs', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-attachment-protocol-'),
    )
    expect(
      resolveAttachmentRawPath('app://attachments/../../secret/raw', {
        stateRoot,
      }),
    ).toBeNull()
    expect(
      resolveAttachmentRawPath('app://bundle/index.html', { stateRoot }),
    ).toBeNull()
  })
})

describe('resolveMediaRawPath', () => {
  it('maps app://media/{id}/raw to a managed media file under stateRoot/memory/media', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-media-protocol-state-'),
    )
    const dir = path.join(stateRoot, 'memory', 'media', '2026-06')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'abcdef12-screen.png'), 'image')

    expect(
      resolveMediaRawPath('app://media/media_2026-06_abcdef12/raw', {
        stateRoot,
      }),
    ).toBe(path.join(dir, 'abcdef12-screen.png'))
  })

  it('falls back to legacyRuntimeRoot when the file is not under stateRoot (read-only, no migration)', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-media-protocol-state-'),
    )
    const legacyRuntimeRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-media-protocol-legacy-'),
    )
    const legacyDir = path.join(legacyRuntimeRoot, 'memory', 'media', '2026-05')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, '12345678-old.png'), 'legacy image')

    const resolved = resolveMediaRawPath(
      'app://media/media_2026-05_12345678/raw',
      { stateRoot, legacyRuntimeRoot },
    )

    expect(resolved).toBe(path.join(legacyDir, '12345678-old.png'))
  })

  it('rejects malformed media URLs', () => {
    const stateRoot = mkdtempSync(
      path.join(tmpdir(), 'emperor-media-protocol-'),
    )
    expect(
      resolveMediaRawPath('app://media/../../secret/raw', { stateRoot }),
    ).toBeNull()
    expect(
      resolveMediaRawPath('app://attachments/att_2026-06_abcdef12/raw', {
        stateRoot,
      }),
    ).toBeNull()
  })
})
