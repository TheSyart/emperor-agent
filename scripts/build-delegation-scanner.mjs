import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform === 'darwin') {
  const source = resolve(root, 'packages/core/native/darwin/delegation-scan.c'),
    output = resolve(
      root,
      'packages/core/native/build',
      process.platform + '-' + process.arch,
      'delegation-scan',
    )
  if (
    !existsSync(output) ||
    statSync(source).mtimeMs > statSync(output).mtimeMs
  ) {
    mkdirSync(dirname(output), { recursive: true })
    for (const [exe, args] of [
      [
        '/usr/bin/clang',
        ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output],
      ],
    ]) {
      const r = spawnSync(exe, args, { stdio: 'inherit' })
      if (r.status !== 0) throw new Error('delegation scanner build failed')
    }
  }
}
