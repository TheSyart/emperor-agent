import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LocalSandbox } from '@emperor/core/host-capabilities'

/** Exercises the shipped Shell confinement code from the signed app binary. */
export async function verifyPackagedSeatbelt(
  workspaceRoot: string,
  stateRoot: string,
): Promise<{
  ok: true
  mode: 'workspace-write'
  commands: number
  protectedStateDenied: true
}> {
  const node = process.env.EMPEROR_SMOKE_NODE
  const npmCli = process.env.EMPEROR_SMOKE_NPM_CLI
  if (!node || !npmCli)
    throw new Error('packaged Seatbelt probe requires host Node and npm')

  writeFileSync(
    join(workspaceRoot, 'package.json'),
    '{"name":"seatbelt-smoke","version":"1.0.0"}\n',
  )
  writeFileSync(
    join(workspaceRoot, 'Makefile'),
    'out.txt:\n\tprintf made > out.txt\n',
  )
  writeFileSync(
    join(workspaceRoot, 'hello.c'),
    '#include <stdio.h>\nint main(void){puts("c-smoke");return 0;}\n',
  )
  writeFileSync(join(workspaceRoot, 'main.swift'), 'print("swift-smoke")\n')

  const sandbox = new LocalSandbox({
    seatbeltExec: '/usr/bin/sandbox-exec',
    protectedStateRoot: stateRoot,
  })
  const policy = {
    mode: 'workspace-write' as const,
    workspaceRoot,
  }
  const env = {
    ...process.env,
    PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    npm_config_cache: join(workspaceRoot, 'npm-cache'),
  }
  let commands = 0
  const run = (label: string, argv: string[]) => {
    const confined = sandbox.confine(argv, policy)
    const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), {
      cwd: workspaceRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.status !== 0)
      throw new Error(`packaged Seatbelt development command failed: ${label}`)
    commands++
    return result.stdout
  }
  const expectOutput = (label: string, actual: string, expected: string) => {
    if (!actual.includes(expected))
      throw new Error(`packaged Seatbelt command output missing: ${label}`)
  }
  const git = (...args: string[]) => [
    '/usr/bin/git',
    '-C',
    'repo',
    '-c',
    'user.name=Smoke',
    '-c',
    'user.email=smoke@example.invalid',
    ...args,
  ]
  run('git init', ['/usr/bin/git', 'init', '-q', 'repo'])
  run('shell write', ['/bin/sh', '-c', 'printf x > repo/a.txt'])
  run('git add', git('add', 'a.txt'))
  run('git commit', git('commit', '-q', '-m', 'smoke'))
  expectOutput('git log', run('git log', git('log', '--oneline')), 'smoke')
  run('git status', git('status', '--short'))
  run('npm pkg version', [node, npmCli, 'pkg', 'set', 'version=1.0.1'])
  run('npm pkg script', [node, npmCli, 'pkg', 'set', 'scripts.hello=echo hi'])
  expectOutput(
    'npm run',
    run('npm run', [node, npmCli, 'run', '--silent', 'hello']),
    'hi',
  )
  const packageJson = JSON.parse(
    readFileSync(join(workspaceRoot, 'package.json'), 'utf8'),
  ) as { version?: string; scripts?: { hello?: string } }
  if (
    packageJson.version !== '1.0.1' ||
    packageJson.scripts?.hello !== 'echo hi'
  )
    throw new Error('packaged Seatbelt npm changes were not written')
  run('node write', [
    node,
    '-e',
    "require('node:fs').writeFileSync('node.txt', 'ok')",
  ])
  run('python write', [
    '/usr/bin/python3',
    '-c',
    "open('py.txt','w').write('ok')",
  ])
  run('make', ['/usr/bin/make', '-s'])
  for (const [file, expected] of [
    ['node.txt', 'ok'],
    ['py.txt', 'ok'],
    ['out.txt', 'made'],
  ]) {
    if (readFileSync(join(workspaceRoot, file), 'utf8') !== expected)
      throw new Error(`packaged Seatbelt command output missing: ${file}`)
  }
  run('cc compile', [
    '/usr/bin/cc',
    '-o',
    join(workspaceRoot, 'hello-c'),
    join(workspaceRoot, 'hello.c'),
  ])
  expectOutput(
    'cc result',
    run('cc result', [join(workspaceRoot, 'hello-c')]),
    'c-smoke',
  )
  run('swiftc compile', [
    '/usr/bin/swiftc',
    '-o',
    join(workspaceRoot, 'hello'),
    join(workspaceRoot, 'main.swift'),
  ])
  expectOutput(
    'swiftc result',
    run('swiftc result', [join(workspaceRoot, 'hello')]),
    'swift-smoke',
  )
  run('tar', ['/usr/bin/tar', '-czf', 'bundle.tgz', 'node.txt', 'py.txt'])
  if (statSync(join(workspaceRoot, 'bundle.tgz')).size <= 0)
    throw new Error('packaged Seatbelt archive is empty')
  expectOutput(
    'grep',
    run('grep', ['/usr/bin/grep', '-r', 'ok', 'node.txt']),
    'ok',
  )

  const privateDir = join(stateRoot, 'computer-use')
  mkdirSync(privateDir, { recursive: true })
  const privateFile = join(privateDir, 'seatbelt-smoke-private.txt')
  writeFileSync(privateFile, 'seatbelt-smoke-private')
  const denied = sandbox.confine(['/bin/cat', privateFile], policy)
  const read = spawnSync(denied.argv[0]!, denied.argv.slice(1), {
    cwd: workspaceRoot,
    env,
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (
    read.status !== 1 ||
    !read.stderr.includes('Operation not permitted') ||
    read.stdout.includes('seatbelt-smoke-private')
  )
    throw new Error('packaged Seatbelt allowed protected state access')

  return {
    ok: true,
    mode: 'workspace-write',
    commands,
    protectedStateDenied: true,
  }
}
