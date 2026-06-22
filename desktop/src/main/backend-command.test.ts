import { describe, it, expect } from 'vitest'
import { buildBackendCommand } from './backend-command'

const config = { root: '/repo', host: '127.0.0.1', port: 8765 }
const tailArgs = ['web', '--host', '127.0.0.1', '--port', '8765', '--no-open']

describe('buildBackendCommand', () => {
  it('uses the venv emperor-agent binary when present', () => {
    const fileExists = (p: string) => p === '/repo/.venv/bin/emperor-agent'
    const { command, args } = buildBackendCommand({ config, env: {}, fileExists })
    expect(command).toBe('/repo/.venv/bin/emperor-agent')
    expect(args).toEqual(tailArgs)
  })

  it('falls back to PATH emperor-agent when no venv binary exists', () => {
    const { command, args } = buildBackendCommand({ config, env: {}, fileExists: () => false })
    expect(command).toBe('emperor-agent')
    expect(args).toEqual(tailArgs)
  })

  it('lets EMPEROR_BACKEND_CMD override and prepend its base args', () => {
    const { command, args } = buildBackendCommand({
      config,
      env: { EMPEROR_BACKEND_CMD: 'python -m agent.webui' },
      fileExists: () => true,
    })
    expect(command).toBe('python')
    expect(args).toEqual(['-m', 'agent.webui', ...tailArgs])
  })

  it('ignores a blank EMPEROR_BACKEND_CMD', () => {
    const { command } = buildBackendCommand({
      config,
      env: { EMPEROR_BACKEND_CMD: '   ' },
      fileExists: () => false,
    })
    expect(command).toBe('emperor-agent')
  })
})
