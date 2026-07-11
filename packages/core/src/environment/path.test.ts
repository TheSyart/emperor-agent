import { describe, expect, it } from 'vitest'
import {
  buildEffectivePath,
  dedupePathEntries,
  parseWindowsRegistryPath,
  queryWindowsRegistryPaths,
  windowsEnvValue,
} from './path'
import type {
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentProcessRunner,
} from './process-runner'

describe('environment PATH providers', () => {
  it('builds macOS and Linux paths with case-sensitive stable dedupe', () => {
    const mac = buildEffectivePath({
      platform: 'darwin',
      envPath: '/Custom/Bin:/custom/bin:/usr/bin',
      homeDir: '/Users/tester',
      windowsEnv: { VOLTA_HOME: '/opt/volta' },
    })
    expect(mac.entries.slice(0, 4)).toEqual([
      '/opt/volta/bin',
      '/Custom/Bin',
      '/custom/bin',
      '/usr/bin',
    ])
    expect(mac.entries).toContain('/opt/homebrew/bin')
    expect(mac.value).toBe(mac.entries.join(':'))

    const linux = buildEffectivePath({
      platform: 'linux',
      envPath: '/usr/bin:/usr/bin:/bin',
      homeDir: '/home/tester',
    })
    expect(linux.entries.filter((entry) => entry === '/usr/bin')).toHaveLength(
      1,
    )
    expect(linux.entries[0]).toBe('/home/tester/.volta/bin')
    expect(linux.entries).toContain('/usr/local/go/bin')
    expect(linux.entries).toContain('/home/tester/.cargo/bin')
  })

  it('dedupes Windows paths case-insensitively and expands only known variables', () => {
    const result = buildEffectivePath({
      platform: 'win32',
      envPath: 'C:\\Windows\\System32;C:\\TOOLS',
      machinePath: '%SystemRoot%\\System32;C:\\Tools',
      userPath: '%USERPROFILE%\\bin;%UNKNOWN%\\drop',
      homeDir: 'C:\\Users\\Tester',
      windowsEnv: {
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\Tester',
        LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
      },
    })
    expect(result.entries).toEqual(
      expect.arrayContaining([
        'C:\\Windows\\System32',
        'C:\\TOOLS',
        'C:\\Users\\Tester\\bin',
        'C:\\Users\\Tester\\AppData\\Local\\Volta\\bin',
      ]),
    )
    expect(result.entries[0]).toBe(
      'C:\\Users\\Tester\\AppData\\Local\\Volta\\bin',
    )
    expect(
      result.entries.filter((entry) => entry.toLowerCase() === 'c:\\tools'),
    ).toHaveLength(1)
    expect(result.entries.some((entry) => entry.includes('%UNKNOWN%'))).toBe(
      false,
    )
    expect(result.value).toBe(result.entries.join(';'))
  })

  it('rejects relative/control PATH entries and parses fixed registry output', () => {
    expect(
      dedupePathEntries(
        ['/usr/bin', 'relative/bin', '/tmp\nunsafe', '/bin'],
        'linux',
      ),
    ).toEqual(['/usr/bin', '/bin'])
    expect(
      dedupePathEntries(
        ['C:\\Tools', '\\\\server\\share', '\\\\?\\C:\\device'],
        'win32',
      ),
    ).toEqual(['C:\\Tools'])
    expect(windowsEnvValue({ Path: 'C:\\Tools' }, 'PATH')).toBe('C:\\Tools')
    expect(
      parseWindowsRegistryPath(
        '    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Tools\r\n',
      ),
    ).toBe('%SystemRoot%\\System32;C:\\Tools')
    expect(parseWindowsRegistryPath('ERROR: not found')).toBe('')
  })

  it('queries only the two fixed Windows registry PATH locations', async () => {
    const requests: EnvironmentProcessRequest[] = []
    const runner: EnvironmentProcessRunner = {
      async run(request): Promise<EnvironmentProcessResult> {
        requests.push(request)
        return {
          status: 'completed',
          exitCode: 0,
          stdout: `Path REG_EXPAND_SZ C:\\${requests.length === 1 ? 'Machine' : 'User'}`,
          stderr: '',
          durationMs: 1,
          error: null,
        }
      },
    }
    const result = await queryWindowsRegistryPaths(runner, {
      SystemRoot: 'C:\\Windows',
    })
    expect(result).toMatchObject({
      machinePath: 'C:\\Machine',
      userPath: 'C:\\User',
      diagnostics: [],
    })
    expect(requests.map((request) => request.args)).toEqual([
      [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
        '/v',
        'Path',
      ],
      ['query', 'HKCU\\Environment', '/v', 'Path'],
    ])
  })
})
