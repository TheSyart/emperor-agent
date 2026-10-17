import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { bootstrapEmperorHome } from '@emperor/core/host-capabilities'

const base = mkdtempSync(join(tmpdir(), 'emperor-owner-test-'))
const children = new Set<ChildProcess>()
beforeAll(() => {
  for (const [entry, name] of [
    [join(__dirname, 'state-directory-lock.ts'), 'lock'],
    [
      join(__dirname, '../../../packages/core/src/runtime/installation.ts'),
      'bootstrap',
    ],
  ])
    buildSync({
      entryPoints: [entry!],
      outfile: join(base, name + '.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    })
})
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGCONT')
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }
  children.clear()
})
afterAll(() => rmSync(base, { recursive: true, force: true }))
function directory() {
  return mkdtempSync(join(base, 'case-'))
}
function worker(root: string, legacy?: string) {
  const script = `import { acquireStateDirectoryLock } from ${JSON.stringify(pathToFileURL(join(base, 'lock.mjs')).href)};try{const lock=acquireStateDirectoryLock(process.argv[1], process.argv[2]);globalThis.heldLock=lock;process.send({type:'owner',root:lock.root,path:lock.path});process.on('message',m=>{if(m==='release')process.exit(0)})}catch(e){process.send({type:'blocked',code:e.code});process.exit(0)}`
  return scriptedWorker(script, [root, ...(legacy ? [legacy] : [])])
}
function scriptedWorker(script: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, ...args],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  children.add(child)
  const first = new Promise<{ type: string; code?: string; path?: string }>(
    (resolve, reject) => {
      child.once('message', resolve as (message: unknown) => void)
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code) reject(new Error('worker exit ' + code))
      })
    },
  )
  return {
    child,
    first,
    exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
  }
}

describe('desktop state directory ownership', () => {
  it('excludes another process until the current owner releases, without creating the data root', async () => {
    const root = join(directory(), 'new-home')
    const first = worker(root)
    expect(await first.first).toMatchObject({ type: 'owner' })
    expect(existsSync(root)).toBe(false)
    expect(await worker(root).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
    first.child.send('release')
    await first.exited
    expect(await worker(root).first).toMatchObject({ type: 'owner' })
  })
  it('allows independent data roots concurrently', async () => {
    const root = directory()
    expect(await worker(join(root, 'a')).first).toMatchObject({ type: 'owner' })
    expect(await worker(join(root, 'b')).first).toMatchObject({ type: 'owner' })
  })
  it('identifies symlink aliases and normalized paths as the same root', async () => {
    const base = directory(),
      root = join(base, 'home'),
      alias = join(base, 'alias')
    mkdirSync(root)
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await worker(root).first).toMatchObject({ type: 'owner' })
    expect(await worker(join(alias, '..', 'alias')).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
  })
  it('keeps the same lock across first-run directory creation and legacy rename', async () => {
    const base = directory(),
      root = join(base, 'new-home'),
      alias = join(base, 'parent-link')
    symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await worker(root).first).toMatchObject({ type: 'owner' })
    const legacy = join(base, 'legacy-home')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'settings.json'), '{"retained":true}')
    renameSync(legacy, root)
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(
      '{"retained":true}',
    )
    expect(await worker(join(alias, 'new-home')).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
  })
  it('reserves a legacy symlink target before real bootstrap changes the destination identity', async () => {
    const base = directory(),
      root = join(base, 'new-home'),
      actual = join(base, 'actual-home'),
      legacy = join(base, 'legacy-home')
    mkdirSync(actual)
    symlinkSync(
      actual,
      legacy,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(await worker(root, legacy).first).toMatchObject({ type: 'owner' })
    const result = bootstrapEmperorHome({
      emperorHome: root,
      legacyHome: legacy,
      source: 'default',
      appVersion: 'test',
      runtimeRevision: 'test',
    })
    expect(result.migration).toBe('renamed_legacy')
    expect(await worker(root).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
    expect(await worker(actual).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
  })
  it('refuses migration before writing when the legacy symlink target has a live owner', async () => {
    const base = directory(),
      root = join(base, 'new-home'),
      actual = join(base, 'actual-home'),
      legacy = join(base, 'legacy-home')
    mkdirSync(actual)
    symlinkSync(
      actual,
      legacy,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(await worker(actual).first).toMatchObject({ type: 'owner' })
    expect(await worker(root, legacy).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
    expect(existsSync(root)).toBe(false)
    // A failed migration claim must not strand the independent destination.
    expect(await worker(root).first).toMatchObject({ type: 'owner' })
  })
  it('revalidates a canonical snapshot if another process migrates the root before acquisition', async () => {
    const dir = directory(),
      root = join(dir, 'new-home'),
      actual = join(dir, 'actual-home'),
      legacy = join(dir, 'legacy-home'),
      paused = join(dir, 'paused'),
      resume = join(dir, 'resume')
    mkdirSync(actual)
    symlinkSync(
      actual,
      legacy,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const moduleUrl = JSON.stringify(pathToFileURL(join(base, 'lock.mjs')).href)
    const script = `import * as fs from 'node:fs';import {acquireStateDirectoryLock} from ${moduleUrl};const native=fs.realpathSync.native;let once=true;fs.realpathSync.native=p=>{const value=native(p);if(once){once=false;fs.writeFileSync(process.argv[3],'paused');const deadline=Date.now()+10000;while(!fs.existsSync(process.argv[4])){if(Date.now()>deadline)throw Error('schedule timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}return value};try{globalThis.lock=acquireStateDirectoryLock(process.argv[1],process.argv[2]);process.send({type:'owner'});process.on('message',()=>{})}catch(e){process.send({type:'blocked',code:e.code});process.exit(0)}`
    const delayed = scriptedWorker(script, [root, legacy, paused, resume])
    const deadline = Date.now() + 10000
    while (!existsSync(paused)) {
      if (Date.now() > deadline) throw Error('worker did not pause')
      await new Promise((r) => setTimeout(r, 10))
    }
    const migrate = `import{acquireStateDirectoryLock}from ${moduleUrl};import{bootstrapEmperorHome}from ${JSON.stringify(pathToFileURL(join(base, 'bootstrap.mjs')).href)};globalThis.lock=acquireStateDirectoryLock(process.argv[1],process.argv[2]);bootstrapEmperorHome({emperorHome:process.argv[1],legacyHome:process.argv[2],source:'default',appVersion:'test',runtimeRevision:'test'})`
    const migrated = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', migrate, root, legacy],
      { encoding: 'utf8', timeout: 10000 },
    )
    expect(migrated.status, migrated.stderr).toBe(0)
    writeFileSync(resume, 'resume')
    expect(await delayed.first).toMatchObject({ type: 'owner' })
    expect(await worker(root).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
  })
  it('reserves an absent potential migration source before another App can create it', async () => {
    const base = directory(),
      root = join(base, 'new-home'),
      legacy = join(base, 'legacy-home')
    expect(await worker(root, legacy).first).toMatchObject({ type: 'owner' })
    expect(await worker(legacy).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
    expect(existsSync(legacy)).toBe(false)
  })
  it('reserves the future target of a dangling legacy symlink', async () => {
    const base = directory(),
      root = join(base, 'new-home'),
      actual = join(base, 'future-data'),
      legacy = join(base, 'legacy-home')
    symlinkSync(
      actual,
      legacy,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(await worker(root, legacy).first).toMatchObject({ type: 'owner' })
    expect(await worker(actual).first).toEqual({
      type: 'blocked',
      code: 'state_root_in_use',
    })
    expect(existsSync(actual)).toBe(false)
  })
  it('admits exactly one of several simultaneous contenders', async () => {
    const root = directory(),
      contenders = Array.from({ length: 8 }, () => worker(root))
    const results = await Promise.all(contenders.map((w) => w.first))
    expect(results.filter((r) => r.type === 'owner')).toHaveLength(1)
    expect(results.filter((r) => r.code === 'state_root_in_use')).toHaveLength(
      7,
    )
  })
  it.skipIf(process.platform === 'win32')(
    'cannot steal a live but paused owner; SIGKILL releases without deleting files',
    async () => {
      const root = directory(),
        owner = worker(root)
      expect(await owner.first).toMatchObject({ type: 'owner' })
      owner.child.kill('SIGSTOP')
      expect(await worker(root).first).toEqual({
        type: 'blocked',
        code: 'state_root_in_use',
      })
      owner.child.kill('SIGKILL')
      await owner.exited
      expect(await worker(root).first).toMatchObject({ type: 'owner' })
    },
  )
  it('fails closed if lock storage is invalid and preserves its bytes', async () => {
    const root = directory(),
      owner = worker(root)
    const info = await owner.first
    expect(info.type).toBe('owner')
    owner.child.send('release')
    await owner.exited
    writeFileSync(info.path!, 'not a sqlite database')
    expect(await worker(root).first).toEqual({
      type: 'blocked',
      code: 'state_root_lock_failed',
    })
    expect(readFileSync(info.path!, 'utf8')).toBe('not a sqlite database')
  })
  it('retains ownership during synchronous process exit hooks', async () => {
    const root = directory(),
      result = join(root, 'exit-check.json')
    const moduleUrl = JSON.stringify(pathToFileURL(join(base, 'lock.mjs')).href)
    const contender = `import {acquireStateDirectoryLock} from ${moduleUrl};try{globalThis.lock=acquireStateDirectoryLock(process.argv[1]);console.log('owner')}catch(e){console.log(e.code)}`
    const script = `import{spawnSync}from'node:child_process';import{writeFileSync}from'node:fs';import{acquireStateDirectoryLock}from ${moduleUrl};globalThis.lock=acquireStateDirectoryLock(process.argv[1]);process.once('exit',()=>{const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(contender)},process.argv[1]],{encoding:'utf8'});writeFileSync(process.argv[2],JSON.stringify({exit:child.status,output:child.stdout.trim()}))});process.exit(0)`
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, root, result],
      { stdio: 'ignore' },
    )
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('exit ' + code)),
      )
    })
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({
      exit: 0,
      output: 'state_root_in_use',
    })
    expect(await worker(root).first).toMatchObject({ type: 'owner' })
  })
})
