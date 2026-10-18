import { strict as assert } from 'node:assert'
import { randomUUID, createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export function smokeOptions(argv) {
  const value = (name) => {
    const i = argv.indexOf(name)
    return i < 0 ? undefined : argv[i + 1]
  }
  if (!argv.includes('--real'))
    throw new Error(
      'Real inference requires explicit --real; no mock success is available',
    )
  for (const name of ['--state-root', '--workspace', '--receipt-dir'])
    if (!value(name)) throw new Error(name + ' is required')
  const result = {
    state: resolve(value('--state-root')),
    workspace: resolve(value('--workspace')),
    receipts: resolve(value('--receipt-dir')),
    backend: value('--backend') ?? 'both',
    modelConfig:
      value('--model-config') ??
      join(homedir(), '.emperor', 'model_config.json'),
    executable: value('--electron-executable'),
  }
  assert(['both', 'claude-code', 'codex'].includes(result.backend))
  assert(
    result.state !== result.workspace && result.receipts !== result.workspace,
  )
  for (const path of [result.state, result.workspace]) {
    if (existsSync(path) && readdirSync(path).length)
      throw new Error('Fresh empty directory required: ' + path)
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  mkdirSync(result.receipts, { recursive: true, mode: 0o700 })
  return result
}
export function seedScenario(options) {
  const source = JSON.parse(readFileSync(options.modelConfig, 'utf8')),
    active = source.models.find((e) => e.entryId === source.activeModelId)
  if (!active?.apiKey)
    throw new Error(
      'Active parent model authentication unavailable; configure it outside this test',
    )
  writeFileSync(
    join(options.state, 'model_config.json'),
    JSON.stringify({ ...source, models: [active] }),
    { mode: 0o600 },
  )
  chmodSync(join(options.state, 'model_config.json'), 0o600)
  // This run is explicitly authorized (--real): answer the first-dispatch
  // consent card (AGT-05) with 以后都允许 for both executors up front.
  mkdirSync(join(options.state, 'delegations'), {
    recursive: true,
    mode: 0o700,
  })
  writeFileSync(
    join(options.state, 'delegations', 'consent.json'),
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        'claude-default': { grantedAt: Date.now() },
        'codex-default': { grantedAt: Date.now() },
      },
    }),
    { mode: 0o600 },
  )
  const git = (...args) => {
    const r = spawnSync('/usr/bin/git', args, {
      cwd: options.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'External smoke',
        GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
        GIT_COMMITTER_NAME: 'External smoke',
        GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
      },
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  writeFileSync(
    join(options.workspace, 'README.md'),
    'Owned external orchestration acceptance fixture.\n',
  )
  writeFileSync(
    join(options.workspace, 'percentage.mjs'),
    'export function percentage(part, total) { throw new Error("not implemented") }\n',
  )
  writeFileSync(
    join(options.workspace, 'checks.mjs'),
    'import assert from "node:assert/strict";import {percentage} from "./percentage.mjs";assert.equal(percentage(1,4),25);assert.equal(percentage(-1,4),-25);assert.throws(()=>percentage(1,0),RangeError);console.log("HOST_PERCENTAGE_ASSERTIONS_PASSED");\n',
  )
  writeFileSync(
    join(options.workspace, 'keep.bin'),
    Buffer.from([0, 255, 17, 29]),
  )
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git(
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'external acceptance fixture',
  )
  writeFileSync(
    join(options.workspace, 'README.md'),
    'Owned external orchestration acceptance fixture.\nRetain this pre-existing dirty edit.\n',
  )
  writeFileSync(
    join(options.workspace, 'local-note.txt'),
    'retain pre-existing untracked file\n',
  )
  return {
    model: active.modelId,
    protocol: active.protocol,
    head: git('rev-parse', 'HEAD'),
    git,
  }
}
export async function runScenario(
  invoke,
  options,
  receipt,
  checkpoint = () => {},
) {
  const save = () =>
    writeFileSync(
      join(options.receipts, 'scenario.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    )
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      receipt.checks.push({ name, ok: true, detail })
      save()
      console.log(JSON.stringify({ name, ok: true }))
      await checkpoint(name, detail)
      return detail
    } catch (error) {
      receipt.checks.push({ name, ok: false, error: String(error) })
      save()
      throw error
    }
  }
  const session = await invoke('sessions.create', {
    title: 'Real parent external orchestration',
    mode: 'build',
    project_path: options.workspace,
  })
  receipt.sessionId = session.id
  await invoke('sessions.activate', session.id)
  await invoke('control.setPermissionMode', 'workspace-write', session.id)
  const executors = await invoke('executors.list'),
    config = executors.config
  for (const p of config.profiles) {
    p.enabled = options.backend === 'both' || p.backend === options.backend
    p.authRef = { kind: 'managed-cli-login' }
    // Claude Code runs the binary bundled with Emperor (AGT-01).
    if (p.backend === 'codex') p.executablePath = '/opt/homebrew/bin/codex'
  }
  await invoke('executors.configure', {
    expectedRevision: config.revision,
    config,
  })
  for (const p of config.profiles.filter((p) => p.enabled))
    await check('real preflight ' + p.backend, async () => {
      const v = await invoke('executors.probe', { profileId: p.id })
      assert.equal(v.status, 'available', v.diagnostic)
      return { version: v.executableVersion, authVerified: v.authVerified }
    })
  const submit = async (content) =>
    invoke('chat.submit', {
      sessionId: session.id,
      content,
      clientMessageId: randomUUID(),
      displayContent: content,
      turnId: null,
      clientDraftId: null,
    })
  const tasks = () => invoke('tasks.list', { sessionId: session.id })
  const state = (id) => invoke('delegations.get', { id, sessionId: session.id })
  const primary = options.backend === 'codex' ? 'codex' : 'claude-code'
  await check(
    'real parent dispatches implementation to ' + primary,
    async () => {
      const r = await submit(
        `这是已授权的隔离验收任务，不要创建 Goal/automation。你是调度者，必须实际调用 subagent，backend=${primary}，context=isolated，workspace=isolated-worktree，base=snapshot，run_in_background=false。给子代理的唯一任务：修改 percentage.mjs，导出 percentage(part,total)，对非零 total 返回 part / total * 100。第一阶段明确暂不处理 total===0，不运行或修改 checks.mjs，不改其他文件，不提交。必须用真实文件工具修改。调用返回后报告 delegationId/runId/cwd，立即结束本轮，不再调度。父代理不要自己修改文件。`,
      )
      const rows = (await tasks()).filter((t) => t.backend === primary)
      assert.equal(
        rows.length,
        1,
        'parent must dispatch exactly one real child',
      )
      assert.equal(rows[0].status, 'completed', JSON.stringify(rows[0]))
      return { reply: r.content, task: rows[0] }
    },
  )
  const implement = (await tasks()).find((t) => t.backend === primary),
    first = await state(implement.delegation_id)
  receipt.implementation = {
    delegationId: first.record.id,
    firstRunId: first.record.currentRunId,
    providerSessionId: first.record.providerSessionId,
    cwd: first.record.cwd,
  }
  const criteria = {
    description: 'Independent percentage normal/negative/zero-total assertions',
    commands: [{ executable: process.execPath, args: ['checks.mjs'] }],
  }
  await check(
    'host observes a real failing assertion before repair',
    async () => {
      const r = await invoke('delegations.validate', {
        runId: implement.id,
        receiptId: implement.receipt_id,
        criteria,
        sessionId: session.id,
      })
      assert.equal(r.state, 'failed', JSON.stringify(r))
      assert(r.evidence.some((e) => e.exitCode !== 0))
      return { id: r.id, state: r.state, evidence: r.evidence }
    },
  )
  if (options.backend === 'both')
    await check(
      'real parent dispatches Codex readonly review of frozen artifact',
      async () => {
        const info = await invoke('delegations.receipt', {
            runId: implement.id,
            sessionId: session.id,
          }),
          file = info.receipt.resultFiles.find(
            (f) => f.path === 'percentage.mjs',
          )
        assert(file)
        const immutable = join(
          options.state,
          'delegations',
          'artifacts',
          'blobs',
          file.sha256,
        )
        assert.equal(
          createHash('sha256').update(readFileSync(immutable)).digest('hex'),
          file.sha256,
        )
        const r = await submit(
          `宿主独立 tests 已真实失败。现在只调用一个 subagent，backend=codex，workspace=shared-readonly，base=committed，context=isolated，run_in_background=false。审查固定成果 fingerprint=${info.receipt.resultTreeDigest}，percentage.mjs 的不可变内容路径=${immutable}。要求 Codex 使用真实 exec_command/commandExecution 命令工具执行 cat 来读取文件。没有专门 read 工具不代表不能读取；shell cat 是真实读取工具。必须实际读取这个绝对路径以及 ${join(options.workspace, 'checks.mjs')}，指出 total=0 的缺陷及最小修复，不修改任何文件，不新建任务。完成后你给出审查和原 fingerprint，立即结束。父代理不要修改文件。`,
        )
        const review = (await tasks()).filter((t) => t.backend === 'codex')
        assert.equal(review.length, 1)
        assert.equal(review[0].status, 'completed')
        assert(/zero|0|零/.test(review[0].detail))
        const native = (
          await invoke('tasks.transcript', review[0].id, {
            sessionId: session.id,
            offset: 0,
            limit: 500,
          })
        ).entries
        assert(
          native?.some(
            (entry) =>
              entry.role === 'tool' && entry.content.includes(file.sha256),
          ),
          'actual native read command must name the immutable artifact digest',
        )
        receipt.review = {
          task: review[0],
          treeDigest: info.receipt.resultTreeDigest,
          blobDigest: file.sha256,
        }
        return { reply: r.content, ...receipt.review }
      },
    )
  await check(
    'real parent queues repair into the original native session',
    async () => {
      const r = await submit(
        `现在调用 send_message，subagent_id=${first.record.id}，delivery=queue。要求它只修复原 percentage.mjs：total===0 时 throw new RangeError，正常值仍 part/total*100；不修改 checks.mjs 和其他文件。然后调用 collect_agent 等待该会话的当前新 run（必须等待新 run 创建，必要时 inspect_agent 获取新 runId）。不得另建子代理，父代理不编辑文件。完成后报告宿主仍需验收并结束。`,
      )
      const next = await state(first.record.id)
      assert.equal(
        next.record.providerSessionId,
        first.record.providerSessionId,
        'must resume exact native session',
      )
      assert.equal(Object.keys(next.runs).length, 2)
      const run = next.runs[next.record.currentRunId]
      assert.equal(run.phase, 'completed', JSON.stringify(run))
      assert.notEqual(run.id, first.record.currentRunId)
      receipt.implementation.finalRunId = run.id
      receipt.implementation.providerTurnIds = Object.values(next.runs).map(
        (r) => r.providerTurnId,
      )
      return {
        reply: r.content,
        run,
        providerSessionId: next.record.providerSessionId,
      }
    },
  )
  const final = await state(first.record.id),
    run = final.runs[final.record.currentRunId]
  await check(
    'independent host verifies the current repaired tree',
    async () => {
      const r = await invoke('delegations.validate', {
        runId: run.id,
        receiptId: run.receiptId,
        criteria,
        sessionId: session.id,
      })
      assert.equal(r.state, 'passed', JSON.stringify(r))
      receipt.acceptanceId = r.id
      return {
        id: r.id,
        state: r.state,
        treeDigest: r.treeDigest,
        evidence: r.evidence,
      }
    },
  )
  await check(
    'retained integration preview rechecks and exact apply preserves dirty files',
    async () => {
      const preview = await invoke('delegations.integrate', {
        runId: run.id,
        action: 'preview',
        sessionId: session.id,
      })
      assert.equal(preview.status, 'ready', JSON.stringify(preview))
      const applied = await invoke('delegations.integrate', {
        runId: run.id,
        action: 'apply',
        previewId: preview.id,
        expectedRevision: preview.revision,
        previewDigest: preview.digest,
        sessionId: session.id,
      })
      assert.equal(applied.status, 'applied')
      const r = spawnSync(process.execPath, ['checks.mjs'], {
        cwd: options.workspace,
        encoding: 'utf8',
      })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(
        readFileSync(join(options.workspace, 'README.md'), 'utf8'),
        'Owned external orchestration acceptance fixture.\nRetain this pre-existing dirty edit.\n',
      )
      assert.equal(
        readFileSync(join(options.workspace, 'local-note.txt'), 'utf8'),
        'retain pre-existing untracked file\n',
      )
      assert.deepEqual(
        readFileSync(join(options.workspace, 'keep.bin')),
        Buffer.from([0, 255, 17, 29]),
      )
      const head = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
        cwd: options.workspace,
        encoding: 'utf8',
      }).stdout.trim()
      assert.equal(head, receipt.initialHead)
      receipt.previewId = preview.id
      return {
        previewId: preview.id,
        digest: preview.digest,
        status: applied.status,
        hostOutput: r.stdout,
        headUnchanged: true,
        dirtyAndUntrackedAndBinaryPreserved: true,
      }
    },
  )
  receipt.ok = true
  save()
  return { sessionId: session.id, delegationId: first.record.id, runId: run.id }
}
