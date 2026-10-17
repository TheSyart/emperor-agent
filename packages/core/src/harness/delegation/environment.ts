import { homedir } from 'node:os'
import { buildEffectivePath, windowsEnvValue } from '../../environment/path'

// Finder/LaunchServices does not inherit the interactive shell's PATH. Use the
// same application tool locations for discovery and the isolated CLI runtime.
export function executorEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): NodeJS.ProcessEnv {
  const environment = { ...ambient }
  const path = buildEffectivePath({
    platform:
      process.platform === 'darwin' || process.platform === 'win32'
        ? process.platform
        : 'linux',
    envPath: windowsEnvValue(ambient, 'PATH'),
    homeDir: home,
    windowsEnv: ambient,
  }).value
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === 'PATH') delete environment[key]
  return { ...environment, PATH: path }
}
