import { describe, expect, it } from 'vitest'
import { File, FileCode, FileImage, FileJson, Folder } from 'lucide-vue-next'
import { fileIconFor } from './fileIcon'

describe('fileIconFor', () => {
  it('maps directories to a neutral folder', () => {
    const spec = fileIconFor('src', true)
    expect(spec.icon).toBe(Folder)
    expect(spec.tone).toBe('subtle')
  })

  it('maps known extensions to icon and tone', () => {
    expect(fileIconFor('App.vue', false)).toMatchObject({
      icon: FileCode,
      tone: 'ok',
    })
    expect(fileIconFor('index.html', false)).toMatchObject({
      icon: FileCode,
      tone: 'brand',
    })
    expect(fileIconFor('index.ts', false)).toMatchObject({
      icon: FileCode,
      tone: 'blue',
    })
    expect(fileIconFor('data.json', false)).toMatchObject({
      icon: FileJson,
      tone: 'warn',
    })
    expect(fileIconFor('logo.PNG', false)).toMatchObject({
      icon: FileImage,
      tone: 'violet',
    })
  })

  it('falls back to a generic file for unknown or dotfile names', () => {
    expect(fileIconFor('archive.xyz', false)).toMatchObject({
      icon: File,
      tone: 'subtle',
    })
    expect(fileIconFor('.gitignore', false).icon).toBe(File)
    expect(fileIconFor('LICENSE', false).icon).toBe(File)
  })
})
