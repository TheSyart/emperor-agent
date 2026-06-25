import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  bundledBackendPath,
  initializePackagedRuntime,
  packagedRuntimeRoot,
  runtimeDefaultsRoot,
} from './runtime-root'

describe('packaged runtime paths', () => {
  it('places runtime state under the app userData directory', () => {
    expect(packagedRuntimeRoot('/Users/me/Library/Application Support/Emperor Agent')).toBe(
      '/Users/me/Library/Application Support/Emperor Agent/runtime',
    )
  })

  it('resolves bundled defaults and backend paths from resources', () => {
    expect(runtimeDefaultsRoot('/App/Contents/Resources')).toBe('/App/Contents/Resources/runtime-defaults')
    expect(bundledBackendPath('/App/Contents/Resources', 'darwin')).toBe('/App/Contents/Resources/backend/emperor-agent')
    expect(bundledBackendPath('C:\\App\\resources', 'win32')).toBe(path.join('C:\\App\\resources', 'backend', 'emperor-agent.exe'))
  })
})

describe('initializePackagedRuntime', () => {
  it('copies defaults once and never overwrites user files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-runtime-'))
    const defaults = path.join(tmp, 'defaults')
    const runtime = path.join(tmp, 'runtime')

    fs.mkdirSync(path.join(defaults, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(defaults, 'templates', 'SOUL.md'), 'default soul', 'utf8')
    fs.mkdirSync(path.join(defaults, 'skills', 'demo'), { recursive: true })
    fs.writeFileSync(path.join(defaults, 'skills', 'demo', 'SKILL.md'), 'default skill', 'utf8')
    fs.mkdirSync(path.join(defaults, 'assets', 'desktop-pet'), { recursive: true })
    fs.writeFileSync(path.join(defaults, 'assets', 'desktop-pet', 'pet.svg'), '<svg />', 'utf8')
    fs.writeFileSync(path.join(defaults, 'model_config.example.json'), '{}\n', 'utf8')
    fs.writeFileSync(path.join(defaults, 'mcp_config.example.json'), '{}\n', 'utf8')
    fs.writeFileSync(path.join(defaults, '.env.example'), 'KEY=value\n', 'utf8')

    const first = initializePackagedRuntime({ root: runtime, defaultsRoot: defaults })
    fs.writeFileSync(path.join(runtime, 'templates', 'SOUL.md'), 'user soul', 'utf8')
    const second = initializePackagedRuntime({ root: runtime, defaultsRoot: defaults })

    expect(first.sort()).toEqual(['.env.example', 'assets', 'mcp_config.example.json', 'model_config.example.json', 'skills', 'templates'].sort())
    expect(second).toEqual([])
    expect(fs.readFileSync(path.join(runtime, 'templates', 'SOUL.md'), 'utf8')).toBe('user soul')
  })
})
