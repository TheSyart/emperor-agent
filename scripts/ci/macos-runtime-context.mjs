#!/usr/bin/env node
// Environment evidence, not an application hardening result. A hardened
// control and a plain control distinguish OS enforcement from package flags.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function command(file, args, env = process.env) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `${file}: ${result.error ?? result.stderr ?? result.status}`,
    )
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

export function collectRuntimeContext({
  architecture = process.arch === 'x64' ? 'x86_64' : 'arm64',
} = {}) {
  if (process.platform !== 'darwin')
    throw new Error('macOS runtime context requires macOS')
  if (!['arm64', 'x86_64'].includes(architecture))
    throw new Error('Unsupported control architecture')
  const root = mkdtempSync(join(tmpdir(), 'emperor-runtime-context-'))
  try {
    const source = join(root, 'control.c')
    const plain = join(root, 'plain')
    const hardened = join(root, 'hardened')
    const injection = join(root, 'injection.c')
    const library = join(root, 'injection.dylib')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    writeFileSync(
      injection,
      '#include <stdio.h>\n#include <stdlib.h>\n__attribute__((constructor)) static void injected(void) { const char *p = getenv("EMPEROR_CONTEXT_MARK"); if (p) { FILE *f = fopen(p, "w"); if (f) { fputs("1", f); fclose(f); } } }\n',
    )
    command('/usr/bin/clang', ['-arch', architecture, '-o', plain, source])
    command('/usr/bin/clang', [
      '-arch',
      architecture,
      '-dynamiclib',
      '-o',
      library,
      injection,
    ])
    copyFileSync(plain, hardened)
    command('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      hardened,
    ])
    const controls = {}
    for (const [name, executable] of Object.entries({ plain, hardened })) {
      const mark = join(root, `${name}.mark`)
      const result = spawnSync(executable, [], {
        env: {
          PATH: '/usr/bin:/bin',
          DYLD_INSERT_LIBRARIES: library,
          EMPEROR_CONTEXT_MARK: mark,
        },
        encoding: 'utf8',
        timeout: 5_000,
      })
      controls[name] = {
        injected: existsSync(mark),
        exitCode: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
      }
    }
    command('/usr/bin/codesign', ['--verify', '--strict', hardened])
    return {
      diagnosticOnly: true,
      arch: architecture === 'x86_64' ? 'x64' : 'arm64',
      os: command('/usr/bin/sw_vers', []),
      sip: command('/usr/bin/csrutil', ['status']),
      hardenedControlSeal: command('/usr/bin/codesign', [
        '--display',
        '--verbose=4',
        hardened,
      ]),
      controls,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const index = process.argv.indexOf('--arch')
  const requested = index < 0 ? undefined : process.argv[index + 1]
  console.log(
    JSON.stringify(
      collectRuntimeContext({
        architecture: requested === 'x64' ? 'x86_64' : requested,
      }),
      null,
      2,
    ),
  )
}
