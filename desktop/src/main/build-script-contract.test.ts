import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import electronViteConfig from '../../electron.vite.config'

describe('root build contract', () => {
  it('runs the monorepo typecheck before producing the Desktop bundle', () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(__dirname, '..', '..', '..', 'package.json'),
        'utf8',
      ),
    ) as { scripts?: Record<string, string> }
    const build = packageJson.scripts?.build ?? ''

    expect(build).toMatch(/^npm run typecheck && /)
    expect(build).toContain('npm --prefix desktop run build')
  })

  it('keeps the CommonJS HTML parser behind a packaged runtime boundary', () => {
    const config = electronViteConfig as {
      main?: {
        build?: {
          rollupOptions?: { external?: string[] }
        }
      }
    }
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(config.main?.build?.rollupOptions?.external).toContain('turndown')
    expect(packageJson.dependencies?.turndown).toBe('^7.2.1')
    expect(packageJson.devDependencies?.['highlight.js']).toBe('^11.11.2')
  })
})
