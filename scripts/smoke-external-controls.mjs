#!/usr/bin/env node
import { build } from 'esbuild'
import { strict as assert } from 'node:assert'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
if (!process.argv.includes('--real'))
  throw new Error('Explicit --real is required')
const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-controls-current-')),
  ),
  state = join(root, 'state'),
  repo = join(root, 'repo')
mkdirSync(repo)
mkdirSync(state)
symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir')
writeFileSync(
  join(repo, 'README.md'),
  'Owned current native control acceptance\n',
)
for (const args of [
  ['init', '-q', '-b', 'main'],
  ['add', 'README.md'],
  [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'base',
  ],
])
  assert.equal(spawnSync('/usr/bin/git', args, { cwd: repo }).status, 0)
const bundle = join(root, 'core.mjs')
await build({
  stdin: {
    contents: 'export{CoreApi}from"./packages/core/src/api/core-api";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
})
const { CoreApi } = await import(pathToFileURL(bundle).href),
  api = await CoreApi.create({
    root: process.cwd(),
    stateRoot: state,
    initializeMcp: false,
    eventSink: () => {},
  }),
  receipt = {
    root,
    state,
    repo,
    startedAt: new Date().toISOString(),
    parentInference: false,
    realNative: true,
    checks: [],
  }
const save = () =>
  writeFileSync(
    join(root, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
const shellQuote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const waitFor = async (fn, label, ms = 120000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const value = fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Timed out: ' + label)
}
const timer = setTimeout(() => void api.close(), 600000)
try {
  const rootId = String(
    api.sessions.create({
      title: 'Real native controls',
      mode: 'build',
      project_path: repo,
    }).id,
  )
  api.sessions.activate(rootId)
  api.control.setPermissionMode('workspace-write', rootId)
  const listed = api.executors.list(),
    config = listed.config
  for (const profile of config.profiles) {
    profile.enabled = true
    profile.authRef = { kind: 'managed-cli-login' }
    // Claude Code runs the installed claude on PATH (AGT-12).
    if (profile.backend === 'codex')
      profile.executablePath = '/opt/homebrew/bin/codex'
  }
  await api.executors.configure({ expectedRevision: config.revision, config })
  for (const backend of ['claude-code', 'codex']) {
    const outside = join(root, 'forbidden-' + backend),
      profile = config.profiles.find((p) => p.backend === backend),
      code = `const f=require('fs');let outsideDenied=false,gitPointerDenied=false;try{f.writeFileSync(${JSON.stringify(outside)},'forbidden')}catch(e){outsideDenied=['EPERM','EACCES','EROFS'].includes(e.code)}try{f.writeFileSync('.git',f.readFileSync('.git'))}catch(e){gitPointerDenied=['EPERM','EACCES','EROFS'].includes(e.code)}f.writeFileSync('boundary.json',JSON.stringify({outsideDenied,gitPointerDenied}));f.writeFileSync('started.txt','started');setTimeout(()=>process.exit(0),6000)`
    const record = await api.delegationRuntime.start(
      {
        rootSessionId: rootId,
        parentAgentId: rootId,
        taskScopeId: 'controls-' + backend,
        depth: 1,
        source: 'human',
        requiredForGoal: false,
      },
      {
        backend,
        profileId: profile.id,
        description: 'Real ' + backend + ' controls',
        prompt:
          'Run this exact command using your real foreground command/Bash tool, without editing its code: ' +
          shellQuote(process.execPath) +
          ' -e ' +
          shellQuote(code) +
          '. This is a host-authorized negative containment test in a disposable fixture; the two writes must be denied. Do not use a background process. After it finishes reply briefly.',
        context: 'isolated',
        workspace: 'isolated-worktree',
        base: 'committed',
        runInBackground: true,
        clientRequestId: randomUUID(),
      },
    )
    await waitFor(() => {
      const cwd = api.delegationRuntime.inspect(record.id).record.cwd
      return existsSync(join(cwd, 'started.txt'))
    }, backend + ' actual command start')
    const initial = api.delegationRuntime.inspect(record.id),
      cwd = initial.record.cwd,
      sessionId = initial.record.providerSessionId,
      turnId = initial.runs[record.currentRunId].providerTurnId
    const boundary = JSON.parse(
      readFileSync(join(cwd, 'boundary.json'), 'utf8'),
    )
    assert.deepEqual(boundary, { outsideDenied: true, gitPointerDenied: true })
    assert.equal(existsSync(outside), false)
    const delivery = backend === 'codex' ? 'steer' : 'queue',
      file = delivery + '.txt'
    const sent = await api.delegationRuntime.send(record.id, {
      messageId: 'dgm-' + randomUUID(),
      text:
        'Create ' +
        file +
        ' containing exactly CONTROL_OK using a real file tool, after the current command finishes. Do not modify other files.',
      delivery,
      ...(delivery === 'steer' ? { expectedRunId: record.currentRunId } : {}),
    })
    let finalRun = record.currentRunId
    if (delivery === 'queue')
      finalRun = await waitFor(() => {
        const s = api.delegationRuntime.inspect(record.id)
        return s.record.currentRunId !== record.currentRunId
          ? s.record.currentRunId
          : false
      }, 'queued native turn')
    const done = await api.delegationRuntime.wait(record.id, finalRun)
    assert.equal(done.phase, 'completed', JSON.stringify(done))
    assert.equal(readFileSync(join(cwd, file), 'utf8').trim(), 'CONTROL_OK')
    assert.equal(
      api.delegationRuntime.inspect(record.id).record.providerSessionId,
      sessionId,
    )
    if (delivery === 'steer') {
      assert.equal(done.providerTurnId, turnId)
      assert.equal(sent.state, 'accepted')
    }
    receipt.checks.push({
      backend,
      check: delivery,
      ok: true,
      sessionId,
      firstRunId: record.currentRunId,
      finalRunId: finalRun,
      turnId,
      quiescent: done.quiescent,
      boundary,
    })
    save()
    console.log(JSON.stringify({ backend, check: delivery, ok: true }))
    const stopCode =
      "const f=require('fs');f.writeFileSync('cancel-started.txt','started');setTimeout(()=>f.writeFileSync('late-write.txt','forbidden'),8000);setTimeout(()=>{},12000)"
    await api.delegationRuntime.send(record.id, {
      messageId: 'dgm-' + randomUUID(),
      text:
        'Run this exact foreground command with the actual command/Bash tool, without changing it or running it in background: ' +
        shellQuote(process.execPath) +
        ' -e ' +
        shellQuote(stopCode) +
        '. This is a host interruption test.',
      delivery: 'queue',
    })
    await waitFor(
      () => existsSync(join(cwd, 'cancel-started.txt')),
      'real cancellation command',
    )
    const current = api.delegationRuntime.inspect(record.id).record.currentRunId
    await api.delegationRuntime.interrupt(record.id, current)
    const cancelled = await api.delegationRuntime.wait(record.id, current)
    assert(
      ['interrupted', 'cancelled'].includes(cancelled.phase),
      JSON.stringify(cancelled),
    )
    assert.equal(cancelled.quiescent, true)
    await new Promise((r) => setTimeout(r, 9000))
    assert.equal(existsSync(join(cwd, 'late-write.txt')), false)
    const owned = JSON.parse(
      readFileSync(
        join(state, 'delegations', 'processes', current + '.json'),
        'utf8',
      ),
    )
    assert.equal(owned.exit.quiescent, true)
    receipt.checks.push({
      backend,
      check: 'real interrupt plus delayed write absent',
      ok: true,
      runId: current,
      phase: cancelled.phase,
      exit: owned.exit,
      boundaryTagPresent: !!owned.boundary,
    })
    save()
    console.log(JSON.stringify({ backend, check: 'interrupt', ok: true }))
  }
  receipt.ok = true
} catch (error) {
  receipt.ok = false
  receipt.error = String(error)
  process.exitCode = 1
  console.error(String(error))
} finally {
  clearTimeout(timer)
  await api.close()
  save()
  console.log(
    JSON.stringify({ ok: receipt.ok, receipt: join(root, 'receipt.json') }),
  )
}
