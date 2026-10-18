#!/usr/bin/env node
import process from 'node:process'
import { createRequire } from 'node:module'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import {
  smokeOptions,
  seedScenario,
  runScenario,
} from '../../scripts/external-agent-scenario.mjs'
const desktop = resolve('desktop'),
  require = createRequire(join(desktop, 'package.json')),
  { _electron } = require('playwright-core')
const resumeIndex = process.argv.indexOf('--resume-receipt')
const resumedFrom =
  resumeIndex >= 0 ? resolve(process.argv[resumeIndex + 1]) : null
if (resumedFrom && !process.argv.includes('--real'))
  throw new Error('Explicit --real required')
const prior = resumedFrom ? JSON.parse(readFileSync(resumedFrom, 'utf8')) : null
const options = prior
  ? {
      state: prior.state,
      workspace: prior.workspace,
      receipts: join(resolve(resumedFrom, '..'), 'resume-' + Date.now()),
      backend: 'both',
      executable: undefined,
    }
  : smokeOptions(process.argv.slice(2))
if (prior) {
  assert(prior.implementation?.finalRunId && prior.previewId)
  assert(
    prior.checks.some(
      (check) =>
        check.name ===
          'retained integration preview rechecks and exact apply preserves dirty files' &&
        check.ok,
    ),
  )
  assert(
    readFileSync(join(options.workspace, 'checks.mjs'), 'utf8').includes(
      'HOST_PERCENTAGE_ASSERTIONS_PASSED',
    ),
  )
  mkdirSync(options.receipts, { recursive: true, mode: 0o700 })
}
const seed = prior
  ? { model: prior.model, head: prior.initialHead }
  : seedScenario(options)
const receipt = {
  startedAt: new Date().toISOString(),
  runtime: 'real Electron',
  parentInference: true,
  model: seed.model,
  initialHead: seed.head,
  state: options.state,
  workspace: options.workspace,
  ...(prior
    ? {
        sessionId: prior.sessionId,
        implementation: prior.implementation,
        review: prior.review,
        acceptanceId: prior.acceptanceId,
        previewId: prior.previewId,
        resumedFrom,
        previousFailure: prior.error,
      }
    : {}),
  checks: prior ? [...prior.checks] : [],
  screenshots: [],
  errors: [],
  warnings: [],
}
const save = () =>
  writeFileSync(
    join(options.receipts, 'electron.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
const env = { ...process.env, EMPEROR_CONFIG_DIR: options.state }
delete env.ELECTRON_RUN_AS_NODE
let app,
  page,
  answering = false,
  stopped = false
const launch = async () => {
  app = await _electron.launch({
    executablePath: options.executable ?? require('electron'),
    args: [
      ...(options.executable ? [] : [desktop]),
      '--user-data-dir=' + join(options.receipts, 'chromium'),
    ],
    cwd: desktop,
    env,
    timeout: 60000,
  })
  page = await app.firstWindow()
  await page.locator('.app-frame').waitFor({ timeout: 60000 })
  page.on('pageerror', (e) => receipt.errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') receipt.errors.push(m.text())
    if (m.type() === 'warning') receipt.warnings.push(m.text())
  })
}
const raw = (op, ...args) =>
  page.evaluate(({ op, args }) => window.emperor.invokeCore(op, ...args), {
    op,
    args,
  })
const shot = async (name) => {
  const path = join(options.receipts, name + '.png')
  await page.screenshot({ path, animations: 'disabled' })
  receipt.screenshots.push(path)
  save()
}
const openTask = async (runId) => {
  await page.goto('app://bundle/chat/' + receipt.sessionId)
  await page.locator('.chat-body-slot').waitFor({ state: 'visible' })
  const toggle = page.getByRole('button', { name: '环境信息', exact: true })
  await toggle.waitFor({ state: 'visible' })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click()
  await page.locator('.environment-card').waitFor({ state: 'visible' })
  await page.locator('[data-external-run="' + runId + '"]').click()
  await page.locator('.external-agent-details').waitFor()
  await page.getByText('本轮执行完成', { exact: true }).waitFor()
}
const invoke = async (op, ...args) => {
  if (
    op === 'chat.submit' &&
    page.url().split('?')[0] !== 'app://bundle/chat/' + receipt.sessionId
  )
    await page.goto('app://bundle/chat/' + receipt.sessionId)
  if (op === 'delegations.integrate' && args[0].action === 'apply') {
    await openTask(args[0].runId)
    await page.locator('[data-apply]').waitFor({ timeout: 30000 })
    await page.locator('[data-apply]').scrollIntoViewIfNeeded()
    await shot('real-preview-before-apply')
    await page.locator('[data-apply]').click()
    await page
      .getByText('整合预览 · 已应用', { exact: true })
      .waitFor({ timeout: 30000 })
    return (
      await raw('delegations.receipt', {
        runId: args[0].runId,
        sessionId: receipt.sessionId,
      })
    ).preview
  }
  return raw(op, ...args)
}
try {
  await launch()
  receipt.electron = await app.evaluate(({ app }) => ({
    version: process.versions.electron,
    nodeVersion: process.versions.node,
    packaged: app.isPackaged,
    executable: process.execPath,
  }))
  save()
  const result = prior
    ? {
        sessionId: prior.sessionId,
        delegationId: prior.implementation.delegationId,
        runId: prior.implementation.finalRunId,
      }
    : await runScenario(invoke, options, receipt, async (name) => {
        if (
          name === 'real parent queues repair into the original native session'
        ) {
          await openTask(receipt.implementation.finalRunId)
          await shot('real-resumed-task')
        }
        if (name === 'independent host verifies the current repaired tree') {
          await openTask(receipt.implementation.finalRunId)
          await page.getByText('验收通过', { exact: true }).waitFor()
          await shot('real-accepted-task')
        }
      })
  for (const id of [
    result.delegationId,
    receipt.review?.task.delegation_id,
  ].filter(Boolean)) {
    const view = await raw('delegations.get', {
      id,
      sessionId: result.sessionId,
    })
    const history = await raw('delegations.recover', {
      id,
      sessionId: result.sessionId,
      expectedRevision: view.lastSeq,
      inspect: true,
    })
    assert.equal(history.sessionId, view.record.providerSessionId)
    assert(history.turns.length > 0)
    receipt.checks.push({
      name: 'real native history without inference ' + view.record.backend,
      ok: true,
      detail: { sessionId: history.sessionId, rows: history.turns.length },
    })
  }
  await raw('sessions.activate', result.sessionId)
  // Ask both native tools through the real parent; answer only through rendered question cards.
  await page.goto('app://bundle/chat/' + result.sessionId)
  const questionAnswers = []
  const answerLoop = (async () => {
    while (!stopped) {
      const card = page.locator('[data-takeover="question"]').first()
      if (!answering && (await card.isVisible().catch(() => false))) {
        answering = true
        try {
          await shot('real-question-' + questionAnswers.length)
          const text = await card.innerText()
          const options = card.getByRole('button')
          console.log(
            JSON.stringify({
              questionCard: text.slice(0, 600),
              buttons: await options.allTextContents(),
            }),
          )
          const blue = card.getByText('blue', { exact: true })
          if (await blue.count()) await blue.first().click()
          else {
            const radio = card.getByRole('radio')
            if (await radio.count()) await radio.first().click()
            else await options.first().click()
          }
          const submit = card.locator('[data-action=submit]')
          await submit.click()
          questionAnswers.push(text.slice(0, 300))
          await card.waitFor({ state: 'hidden', timeout: 15000 })
        } finally {
          answering = false
        }
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  })()
  for (const backend of options.backend === 'both'
    ? ['claude-code', 'codex']
    : [options.backend]) {
    const priorTaskIds = new Set(
      (await raw('tasks.list', { sessionId: result.sessionId })).map(
        (task) => task.id,
      ),
    )
    const r = await invoke('chat.submit', {
      sessionId: result.sessionId,
      content: `继续隔离验收。只调用一个 subagent，backend=${backend}，context=isolated，workspace=isolated-worktree，base=snapshot，run_in_background=false。要求子代理必须实际使用 ${backend === 'codex' ? 'request_user_input' : 'AskUserQuestion'} 提问颜色选择，问题只有 blue、green 两个选项，必须等待工具回答，再创建 chosen-${backend}.txt 写入所选颜色，不改其他文件，不提交。父代理不要代答或模拟问题，不要自己创建文件。完成后立即结束。`,
      clientMessageId: randomUUID(),
      displayContent: '真实子代理问题验收',
      turnId: null,
      clientDraftId: null,
    })
    const rows = await raw('tasks.list', { sessionId: result.sessionId }),
      task = rows
        .filter(
          (t) =>
            t.backend === backend &&
            !priorTaskIds.has(t.id) &&
            t.id !== receipt.implementation.firstRunId &&
            t.id !== receipt.implementation.finalRunId &&
            t.id !== receipt.review?.task.id,
        )
        .at(-1)
    assert(task)
    assert.equal(task.status, 'completed', JSON.stringify(task))
    assert.equal(
      readFileSync(
        join(task.workspace_summary, 'chosen-' + backend + '.txt'),
        'utf8',
      ).trim(),
      'blue',
    )
    receipt.checks.push({
      name: 'real Electron question ' + backend,
      ok: true,
      detail: { runId: task.id, answer: 'blue', reply: r.content },
    })
    save()
  }
  stopped = true
  await answerLoop
  assert.equal(questionAnswers.length, options.backend === 'both' ? 2 : 1)
  const before = await raw('tasks.list', { sessionId: result.sessionId }),
    artifact = readFileSync(
      join(receipt.implementation.cwd, 'percentage.mjs'),
      'utf8',
    )
  await app.close()
  app = undefined
  await launch()
  await page.goto('app://bundle/chat/' + result.sessionId)
  const after = await raw('tasks.list', { sessionId: result.sessionId })
  assert.deepEqual(
    after.map((t) => t.id).sort(),
    before.map((t) => t.id).sort(),
  )
  assert.equal(
    readFileSync(join(receipt.implementation.cwd, 'percentage.mjs'), 'utf8'),
    artifact,
  )
  await new Promise((r) => setTimeout(r, 1200))
  assert.deepEqual(
    (await raw('tasks.list', { sessionId: result.sessionId }))
      .map((t) => t.id)
      .sort(),
    before.map((t) => t.id).sort(),
  )
  receipt.checks.push({
    name: 'real Electron restart preserves artifacts without native inference replay',
    ok: true,
  })
  await openTask(result.runId)
  await shot('real-restarted-task')
  receipt.ok =
    receipt.checks.every((c) => c.ok) &&
    receipt.errors.length === 0 &&
    receipt.warnings.length === 0
  if (!receipt.ok) throw new Error('Electron console or check failures')
} catch (error) {
  stopped = true
  receipt.ok = false
  receipt.error = String(error)
  if (page) {
    receipt.failureText = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 4000)
    await shot('failure').catch(() => {})
  }
  process.exitCode = 1
  console.error(String(error))
} finally {
  if (app) await app.close()
  save()
  console.log(
    JSON.stringify({
      ok: receipt.ok,
      receipt: join(options.receipts, 'electron.json'),
    }),
  )
}
