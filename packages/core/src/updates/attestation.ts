/**
 * `gh attestation verify` for a downloaded update (REL-02). The release
 * workflows attest every file listed in SHA256SUMS.txt (REL-05,
 * `actions/attest` with `subject-checksums`), so the DMG itself is a
 * subject. gh runs from the signed environment with its own sign-in;
 * Emperor passes it no token.
 *
 * - no gh, or gh not signed in → `unavailable` (SHA-256 only, said in the UI);
 * - gh says the attestation is missing or does not match → `failed`
 *   (the download is refused and deleted);
 * - anything else gh could not finish (network, timeout) → `unavailable`.
 */
import { UPDATE_REPOSITORY } from './http'
import type { SelectedUpdate } from './feed'
import type { UpdateAttestationResult } from './types'

export interface GhAttestationRuntime {
  executable: string
  env: Record<string, string>
}

export interface GhAttestationRequest {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface GhAttestationResult {
  exitCode: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
}

const AUTH =
  /gh auth login|authentication required|not logged in|HTTP 401|bad credentials|requires authentication/i
const REFUSED =
  /no attestations? (?:were )?found|verification failed|failed to verify|does not match|mismatch/i

export function createGhAttestation(options: {
  /** gh's working directory (the Emperor Home). */
  cwd: string
  resolveRuntime: () => Promise<GhAttestationRuntime | null>
  run: (request: GhAttestationRequest) => Promise<GhAttestationResult>
  /** gh's environment (`ghProcessEnvironment`). */
  environment?: (env: Record<string, string>) => Record<string, string>
}): (
  file: string,
  release: SelectedUpdate,
) => Promise<UpdateAttestationResult> {
  return async (file, release) => {
    const runtime = await options.resolveRuntime().catch(() => null)
    if (!runtime) return { status: 'unavailable', reason: 'gh_missing' }
    const workflow =
      release.channel === 'preview' ? 'release-preview.yml' : 'release.yml'
    const result = await options.run({
      executable: runtime.executable,
      args: [
        'attestation',
        'verify',
        file,
        '--repo',
        UPDATE_REPOSITORY,
        '--signer-workflow',
        `${UPDATE_REPOSITORY}/.github/workflows/${workflow}`,
      ],
      cwd: options.cwd,
      env: options.environment?.(runtime.env) ?? runtime.env,
    })
    if (result.exitCode === 0) return { status: 'verified' }
    const output = `${result.stderr}\n${result.stdout}`
    if (AUTH.test(output))
      return { status: 'unavailable', reason: 'gh_not_logged_in' }
    const detail = lastLine(output)
    if (REFUSED.test(output)) return { status: 'failed', detail }
    return { status: 'unavailable', reason: 'gh_failed', detail }
  }
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? 'gh 没有说明原因').slice(0, 300)
}
