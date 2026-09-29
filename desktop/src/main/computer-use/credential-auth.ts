import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Native LocalAuthentication process. No credential value is sent to it. */
export function credentialAuthPath(input: {
  packaged: boolean
  mainDir: string
  resourcesPath: string
}): string {
  return input.packaged
    ? join(input.resourcesPath, 'native', 'credential-auth')
    : join(input.mainDir, '..', 'native', 'credential-auth')
}

/**
 * Touch ID or login-password check (LocalAuthentication). Gates both viewing
 * a password in Settings and biometric vault unlock; true only on success.
 */
export async function authenticateCredentialReveal(
  binary: string,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(binary, [], { stdio: 'ignore' })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 95_000)
    let settled = false
    const finish = (authorized: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(authorized)
    }
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
}
