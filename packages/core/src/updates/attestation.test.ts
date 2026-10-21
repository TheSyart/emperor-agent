import { describe, expect, it } from 'vitest'
import { createGhAttestation } from './attestation'
import type { SelectedUpdate } from './feed'

// REL-02: the download is checked with `gh attestation verify` when the
// GitHub CLI can; otherwise SHA-256 only, and the status says why.

const stable = {
  version: '0.2.1',
  tag: 'v0.2.1',
  channel: 'stable',
} as SelectedUpdate
const preview = {
  version: '0.2.1-preview.2',
  tag: 'v0.2.1-preview.2',
  channel: 'preview',
} as SelectedUpdate

function runtime() {
  return async () => ({
    executable: '/opt/homebrew/bin/gh',
    version: '2.73.0',
    env: { HOME: '/Users/me' },
  })
}

describe('gh attestation verify', () => {
  it('runs gh with the repository and the release workflow of the channel', async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    const verify = createGhAttestation({
      cwd: '/tmp/home',
      resolveRuntime: runtime(),
      run: async (request) => {
        calls.push(request)
        return { exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false }
      },
    })
    expect(await verify('/tmp/stage/a.dmg', stable)).toEqual({
      status: 'verified',
    })
    expect(await verify('/tmp/stage/b.dmg', preview)).toEqual({
      status: 'verified',
    })
    expect(calls.map((call) => call.args)).toEqual([
      [
        'attestation',
        'verify',
        '/tmp/stage/a.dmg',
        '--repo',
        'TheSyart/emperor-agent',
        '--signer-workflow',
        'TheSyart/emperor-agent/.github/workflows/release.yml',
      ],
      [
        'attestation',
        'verify',
        '/tmp/stage/b.dmg',
        '--repo',
        'TheSyart/emperor-agent',
        '--signer-workflow',
        'TheSyart/emperor-agent/.github/workflows/release-preview.yml',
      ],
    ])
    expect(calls[0]!.executable).toBe('/opt/homebrew/bin/gh')
  })

  it('no gh: SHA-256 only', async () => {
    const verify = createGhAttestation({
      cwd: '/tmp/home',
      resolveRuntime: async () => null,
      run: async () => {
        throw new Error('must not run')
      },
    })
    expect(await verify('/tmp/a.dmg', stable)).toEqual({
      status: 'unavailable',
      reason: 'gh_missing',
    })
  })

  it('gh not signed in: SHA-256 only; a failed verification refuses the file', async () => {
    const answer = (exitCode: number, stderr: string) =>
      createGhAttestation({
        cwd: '/tmp/home',
        resolveRuntime: runtime(),
        run: async () => ({
          exitCode,
          stdout: '',
          stderr,
          stdoutTruncated: false,
        }),
      })
    expect(
      await answer(
        4,
        'To get started with GitHub CLI, please run:  gh auth login',
      )('/tmp/a.dmg', stable),
    ).toEqual({ status: 'unavailable', reason: 'gh_not_logged_in' })
    expect(
      await answer(
        1,
        'Loaded digest sha256:abc for file:///tmp/a.dmg\n✗ Loading attestations from GitHub API failed\n\nError: no attestations found for subject',
      )('/tmp/a.dmg', stable),
    ).toEqual({
      status: 'failed',
      detail: 'Error: no attestations found for subject',
    })
    expect(
      await answer(
        1,
        'error: verification failed: certificate identity mismatch',
      )('/tmp/a.dmg', stable),
    ).toMatchObject({ status: 'failed' })
    expect(
      await answer(1, 'Post "https://api.github.com": dial tcp: i/o timeout')(
        '/tmp/a.dmg',
        stable,
      ),
    ).toEqual({
      status: 'unavailable',
      reason: 'gh_failed',
      detail: 'Post "https://api.github.com": dial tcp: i/o timeout',
    })
  })
})
