import { resolve } from 'node:path'
import { serveEmperorAcpStdio } from './stdio'

interface CliOptions {
  runtimeRoot: string
  stateRoot?: string
  help: boolean
}

void main()

async function main(): Promise<void> {
  const controller = new AbortController()
  const stop = (signal: NodeJS.Signals): void => controller.abort(signal)
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stderr.write(
        'Usage: emperor-agent-acp [--runtime-root PATH] [--state-root PATH]\n',
      )
      return
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    await serveEmperorAcpStdio({
      root: options.runtimeRoot,
      ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
      input: process.stdin,
      output: process.stdout,
      signal: controller.signal,
      appVersion: '0.0.0',
    })
  } catch (error) {
    process.stderr.write(`emperor-agent-acp: ${errorMessage(error)}\n`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function parseArgs(argv: string[]): CliOptions {
  const defaultRuntimeRoot = resolve(process.cwd())
  let runtimeRoot = process.env.EMPEROR_AGENT_ROOT?.trim() || defaultRuntimeRoot
  let stateRoot: string | undefined
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--runtime-root' || argument === '--state-root') {
      const value = argv[index + 1]?.trim()
      if (!value || value.startsWith('-'))
        throw new Error(`${argument} requires a path`)
      if (argument === '--runtime-root') runtimeRoot = resolve(value)
      else stateRoot = resolve(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return {
    runtimeRoot: resolve(runtimeRoot),
    ...(stateRoot ? { stateRoot } : {}),
    help,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
