// Fixture conversations for the dev chat gallery and the ChatTimeline mount
// test. Every scenario is a raw event log (plus optional children) built
// with ShowcaseLog relative to `now`, so running clocks read sensibly.
import type {
  SessionHistoryPage,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import { ShowcaseLog } from './showcaseLog'

export interface ScenarioSession {
  readonly id: string
  readonly events: WireSessionEvent[]
  /** Replayed live after the history load (streaming scenarios). */
  readonly live?: WireSessionEvent[]
  readonly origin?: 'subagent'
}

export interface Scenario {
  readonly id: string
  readonly label: string
  readonly sessions: readonly ScenarioSession[]
}

const LOGIN_VUE = `<script setup lang="ts">
import { ref } from 'vue'
import { login } from '../api/auth'

const email = ref('')
const password = ref('')
const pending = ref(false)

async function submit() {
  pending.value = true
  try {
    await login(email.value, password.value)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <form class="login-card" @submit.prevent="submit">
    <h1>登录</h1>
    <input v-model="email" type="email" placeholder="邮箱" />
    <input v-model="password" type="password" placeholder="密码" />
    <button :disabled="pending">继续</button>
  </form>
</template>

<style scoped>
.login-card {
  width: 480px;
  margin: 96px auto;
  padding: 32px;
}
</style>`

function readResult(path: string, text: string, offset = 1): string {
  const lines = text.split('\n')
  const body = lines
    .map((line, index) => `${index + offset}: ${line}`)
    .join('\n')
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n(End of file - total ${lines.length} lines)\n</content>`
}

const TEST_OUTPUT = [
  '\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv2.1.8 \u001b[39m\u001b[90m/workspace/web\u001b[39m',
  '',
  ' \u001b[32m✓\u001b[39m src/components/LoginForm.spec.ts \u001b[2m(\u001b[22m\u001b[2m6 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[90m 38\u001b[2mms\u001b[22m\u001b[39m',
  ' \u001b[32m✓\u001b[39m src/api/auth.spec.ts \u001b[2m(\u001b[22m\u001b[2m4 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[90m 12\u001b[2mms\u001b[22m\u001b[39m',
  '',
  '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m\u001b[90m (2)\u001b[39m',
  '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m10 passed\u001b[39m\u001b[22m\u001b[90m (10)\u001b[39m',
  '\u001b[2m   Duration \u001b[22m 612ms',
].join('\n')

const LINT_OUTPUT = `/workspace/web/src/components/LoginForm.vue
  27:3  error  Unexpected inline style width  vue/no-static-inline-styles
  41:9  warning  'pending' is assigned but never read  @typescript-eslint/no-unused-vars

✖ 2 problems (1 error, 1 warning)
[exit code: 1]`

const FINAL_ANSWER = `## 登录页移动端布局已修复

问题出在 \`.login-card\` 写死了 \`width: 480px\`，在 375px 宽的屏幕上会横向溢出。我做了三处改动：

1. 卡片改为 \`width: min(480px, 100%)\`，并用 \`clamp()\` 收紧移动端的外边距；
2. 表单输入统一 \`box-sizing: border-box\`，避免 padding 撑破宽度；
3. 新增 \`LoginForm.spec.ts\`，覆盖提交态与禁用态。

| 视口 | 修复前 | 修复后 |
| --- | --- | --- |
| 375 × 812 | 横向滚动 | 正常 |
| 768 × 1024 | 正常 | 正常 |
| 1440 × 900 | 正常 | 正常 |

\`\`\`css
.login-card {
  width: min(480px, 100%);
  margin: clamp(24px, 8vh, 96px) auto;
  padding: 32px;
}
\`\`\`

> lint 里剩下的一条 warning 与本次改动无关，我没有顺手修改，需要的话可以单独处理。`

/** A complete multi-step coding turn exercising every major tool view. */
export function showcaseScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 9 * 60_000)
  log.add('permission/preset', { preset: 'workspace-write' })
  log.user('帮我修复登录页在移动端的布局错位，并补上单元测试。', {
    attachments: [
      {
        id: 'att-report',
        name: 'mobile-layout-report.md',
        mime: 'text/markdown',
        size: 6_420,
        kind: 'file',
      },
    ],
  })
  log.turnStart(1)
  log.context(
    'runtime-context',
    'Current runtime context.\n\nCurrent file policy: workspace-write.\nWorking directory: /workspace/web',
    { form: 'notice', summary: '工作区可写 · /workspace/web' },
  )

  log.toolStep(
    1,
    1,
    [
      {
        reasoning:
          '用户说登录页在移动端错位。\n先找到登录表单组件，看看容器宽度和外边距是怎么写的。\n如果是固定宽度导致溢出，改成响应式宽度即可，然后补测试。',
      },
      { text: '我先定位登录表单组件和相关样式。' },
    ],
    [
      {
        id: 'call_grep',
        name: 'grep',
        args: { pattern: 'login-card', include: '*.vue' },
        result:
          'Found 3 matches\n\nsrc/components/LoginForm.vue\nLine 23: <form class="login-card" @submit.prevent="submit">\nLine 33: .login-card {\n\nsrc/views/AuthLayout.vue\nLine 12:   <LoginForm class="login-card--centered" />',
        extra: {
          meta: {
            matches: 3,
            truncated: false,
            files: ['src/components/LoginForm.vue', 'src/views/AuthLayout.vue'],
          },
        },
      },
      {
        id: 'call_read',
        name: 'read',
        args: { file_path: 'src/components/LoginForm.vue' },
        result: readResult('src/components/LoginForm.vue', LOGIN_VUE),
        extra: {
          meta: {
            path: 'src/components/LoginForm.vue',
            startLine: 1,
            endLine: LOGIN_VUE.split('\n').length,
            totalLines: LOGIN_VUE.split('\n').length,
          },
        },
      },
    ],
  )

  log.toolStep(
    1,
    2,
    [
      {
        text: '找到原因了：`.login-card` 固定了 `width: 480px`，窄屏下会横向溢出。改成响应式宽度：',
      },
    ],
    [
      {
        id: 'call_edit',
        name: 'edit',
        args: {
          file_path: 'src/components/LoginForm.vue',
          old_string:
            '.login-card {\n  width: 480px;\n  margin: 96px auto;\n  padding: 32px;\n}',
          new_string:
            '.login-card {\n  box-sizing: border-box;\n  width: min(480px, 100%);\n  margin: clamp(24px, 8vh, 96px) auto;\n  padding: 32px;\n}',
        },
        result:
          'The file src/components/LoginForm.vue has been updated successfully.',
        extra: {
          meta: {
            path: 'src/components/LoginForm.vue',
            kind: 'edit',
            replacements: 1,
            added: 3,
            removed: 2,
          },
        },
      },
    ],
  )

  log.toolStep(
    1,
    3,
    [{ text: '补一个组件测试，然后跑测试和 lint。' }],
    [
      {
        id: 'call_write',
        name: 'write',
        args: {
          file_path: 'src/components/LoginForm.spec.ts',
          content:
            "import { mount } from '@vue/test-utils'\nimport LoginForm from './LoginForm.vue'\n\ndescribe('LoginForm', () => {\n  it('disables submit while pending', async () => {\n    const wrapper = mount(LoginForm)\n    await wrapper.find('form').trigger('submit')\n    expect(wrapper.find('button').attributes('disabled')).toBeDefined()\n  })\n})\n",
        },
        result:
          '<path>src/components/LoginForm.spec.ts</path>\n<type>file</type>\n<content>\nCreated file\n</content>',
        extra: {
          meta: {
            path: 'src/components/LoginForm.spec.ts',
            kind: 'write',
            operation: 'create',
            added: 10,
            removed: 0,
            diff: '',
          },
        },
      },
      {
        id: 'call_todo',
        name: 'todo_write',
        args: {
          todos: [
            { content: '定位登录卡片的溢出原因', status: 'completed' },
            { content: '改为响应式宽度', status: 'completed' },
            { content: '补充 LoginForm 单元测试', status: 'in_progress' },
            { content: '运行测试与 lint', status: 'pending' },
          ],
        },
        result: 'Updated todo list: 1 pending, 1 in progress, 2 completed.',
      },
    ],
  )

  log.toolStep(
    1,
    4,
    [],
    [
      {
        id: 'call_test',
        name: 'bash',
        args: {
          command: 'npx vitest run src/components/LoginForm.spec.ts src/api',
          description: '运行登录相关单元测试',
        },
        result: TEST_OUTPUT,
        extra: {
          meta: {
            kind: 'foreground',
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            durationMs: 1840,
          },
        },
      },
      {
        id: 'call_lint',
        name: 'bash',
        args: {
          command: 'npm run lint -- src/components',
          description: '检查组件 lint',
        },
        result: LINT_OUTPUT,
        extra: {
          meta: {
            kind: 'foreground',
            exitCode: 1,
            signal: null,
            timedOut: false,
            aborted: false,
            durationMs: 2210,
          },
        },
      },
      {
        id: 'call_glob',
        name: 'glob',
        args: { pattern: 'src/**/*.spec.ts' },
        result:
          'src/components/LoginForm.spec.ts\nsrc/api/auth.spec.ts\nsrc/views/AuthLayout.spec.ts\nsrc/router/guards.spec.ts',
        extra: {
          meta: {
            matches: 4,
            truncated: false,
            files: [
              'src/components/LoginForm.spec.ts',
              'src/api/auth.spec.ts',
              'src/views/AuthLayout.spec.ts',
              'src/router/guards.spec.ts',
            ],
          },
        },
      },
    ],
  )

  log.toolStep(
    1,
    5,
    [
      {
        text: 'lint 报的是既有问题。再确认一下 `min()` 在目标浏览器里的支持情况，并让子代理顺手检查其他页面。',
      },
    ],
    [
      {
        id: 'call_web',
        name: 'web_search',
        args: { queries: ['css min() browser support', 'clamp() safari ios'] },
        result:
          'Answer: min() and clamp() are supported in all evergreen browsers since 2020.',
        extra: {
          meta: {
            answer:
              'CSS min() / clamp() 自 2020 年起已在所有常青浏览器中可用，iOS Safari 11.3+ 支持。',
            truncated: false,
            sources: [
              {
                url: 'https://developer.mozilla.org/docs/Web/CSS/min',
                title: 'min() - CSS: Cascading Style Sheets | MDN',
                snippet:
                  'The min() CSS function lets you set the smallest value from a list of comma-separated expressions.',
              },
              {
                url: 'https://caniuse.com/css-math-functions',
                title:
                  'CSS math functions min(), max() and clamp() | Can I use',
              },
            ],
          },
        },
      },
      {
        id: 'call_sub',
        name: 'subagent',
        args: {
          description: '检查其他页面的同类溢出',
          prompt:
            '在 src/views 下查找固定宽度导致移动端横向溢出的卡片或容器，只汇报问题位置，不要修改代码。',
          run_in_background: false,
        },
        between: (l) => {
          l.add('subagent/started', {
            subagentId: 'showcase-child',
            description: '检查其他页面的同类溢出',
            mode: 'spawn',
            background: false,
            callId: 'call_sub',
          })
          l.tick(4200)
          l.add('subagent/settled', {
            subagentId: 'showcase-child',
            stopReason: 'completed',
            text: '检查了 12 个页面。\n`SettingsView.vue` 的 `.panel` 也写死了 `width: 520px`，在 375px 下同样会溢出；其余页面未发现问题。',
          })
        },
        result:
          '检查了 12 个页面。\n`SettingsView.vue` 的 `.panel` 也写死了 `width: 520px`，在 375px 下同样会溢出；其余页面未发现问题。',
        extra: {
          meta: {
            kind: 'foreground',
            subagentId: 'showcase-child',
            description: '检查其他页面的同类溢出',
            mode: 'spawn',
          },
        },
      },
    ],
  )

  log.stepStart(1, 6)
  log.stream(1, 6, [{ text: FINAL_ANSWER }], { outputTokens: 420 })
  log.stepEnd(1, 6)
  log.turnEnd(1)

  const child = new ShowcaseLog(now - 8 * 60_000)
  child.add('subagent/descriptor', {
    parentSession: 'showcase',
    description: '检查其他页面的同类溢出',
    mode: 'spawn',
    parentCallId: 'call_sub',
  })
  child.turnStart(1)
  child.context(
    'subagent',
    '在 src/views 下查找固定宽度导致移动端横向溢出的卡片或容器，只汇报问题位置，不要修改代码。',
    {
      form: 'relay',
    },
  )
  child.toolStep(
    1,
    1,
    [{ text: '先搜一下写死宽度的样式。' }],
    [
      {
        id: 'c_grep',
        name: 'grep',
        args: { pattern: 'width: \\d{3}px', path: 'src/views' },
        result:
          'Found 2 matches\n\nsrc/views/SettingsView.vue\nLine 88:   width: 520px;\n\nsrc/views/AuthLayout.vue\nLine 30:   width: 100%;',
      },
    ],
  )
  child.stepStart(1, 2)
  child.stream(1, 2, [
    {
      text: '检查了 12 个页面。\n`SettingsView.vue` 的 `.panel` 也写死了 `width: 520px`，在 375px 下同样会溢出；其余页面未发现问题。',
    },
  ])
  child.stepEnd(1, 2)
  child.turnEnd(1)

  return {
    id: 'showcase',
    label: '完整一轮',
    sessions: [
      { id: 'showcase', events: log.events },
      { id: 'showcase-child', events: child.events, origin: 'subagent' },
    ],
  }
}

/** Retry / fallback / cost cap / turn error / max tokens / compaction / hooks. */
export function noticesScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 20 * 60_000)
  log.add('hook/invoked', {
    turn: 1,
    point: 'UserPromptSubmit',
    dialect: 'claude-code',
    handlerId: 'h:prompt',
  })
  log.add('hook/result', {
    turn: 1,
    point: 'UserPromptSubmit',
    handlerId: 'h:prompt',
    decision: 'pass',
    durationMs: 18,
  })
  log.user('把发布脚本改成先跑 smoke test，再上传产物。')
  log.turnStart(1)
  log.add('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: {
      id: 'g1',
      revision: 1,
      objective: '发布前自动跑 smoke test',
      phase: 'active',
      maxGoalRounds: 5,
    },
    roundsStarted: 1,
    createdAt: now,
    updatedAt: now,
  })
  log.context(
    'memory',
    '<system-reminder>\n用户偏好：命令行输出保持简洁；发布流程使用 pnpm。\n</system-reminder>',
    {
      summary: '2 条偏好',
    },
  )
  log.stepStart(1, 1)
  log.add('llm/retry', {
    retryId: 'r1',
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode: 'normal',
    retry: 1,
    maxRetries: 3,
    delayMs: 2000,
    failure: { message: 'upstream 502 Bad Gateway', code: 'SERVER' },
  })
  log.add('llm/retry-started', { retryId: 'r1', turn: 1, step: 1 })
  log.add('llm/retry', {
    retryId: 'r2',
    turn: 1,
    step: 1,
    provider: 'deepseek',
    mode: 'normal',
    retry: 2,
    maxRetries: 3,
    delayMs: 4000,
    failure: { message: 'upstream 502 Bad Gateway', code: 'SERVER' },
  })
  log.add('llm/retry-started', { retryId: 'r2', turn: 1, step: 1 })
  log.add('llm/fallback', {
    fallbackId: 'f1',
    turn: 1,
    step: 1,
    from: 'deepseek-v4',
    to: 'deepseek-v4-lite',
    trigger: 'transient',
    failure: { message: 'retries exhausted on primary route', code: 'SERVER' },
  })
  log.stream(1, 1, [{ text: '好的，我先看一下现有的发布脚本。' }])
  log.add('hook/invoked', {
    turn: 1,
    point: 'PreToolUse',
    dialect: 'claude-code',
    matcher: 'Bash',
    handlerId: 'h:guard',
  })
  log.add('hook/result', {
    turn: 1,
    point: 'PreToolUse',
    handlerId: 'h:guard',
    decision: 'deny',
    exitCode: 2,
    stderrSummary: 'blocked: `rm -rf dist` is not allowed in release scripts',
    durationMs: 42,
  })
  log.add('llm/cost-cap', {
    turn: 1,
    step: 1,
    capUsdNanos: 500_000_000,
    spentUsdNanos: 512_000_000,
  })
  log.stepEnd(1, 1)
  log.turnEnd(1, {
    kind: 'error',
    error: { message: '模型服务暂时不可用，请稍后重试。', code: 'SERVER' },
  })

  log.user('继续，把完整脚本写出来。')
  log.turnStart(2)
  log.stepStart(2, 1)
  log.stream(2, 1, [
    {
      text: '下面是调整后的发布脚本：\n\n```bash\n#!/usr/bin/env bash\nset -euo pipefail\npnpm install --frozen-lockfile\npnpm run build\npnpm run smoke\n# 上传产物\nfor file in dist/*.dmg dist/*.zip; do\n  gh release upload "$TAG" "$file"',
    },
  ])
  log.stepEnd(2, 1)
  log.turnEnd(2, { kind: 'max-tokens' })

  log.add('compaction/start', { compactionId: 'cmp1', turn: null })
  log.add('compaction/summary', {
    compactionId: 'cmp1',
    summary: [
      {
        type: 'text',
        text: '**已完成**：发布脚本改为先 `pnpm run smoke` 再上传产物。\n\n**待办**：补完上传循环的收尾，并在 CI 中加 `--frozen-lockfile`。',
      },
    ],
    shadowedRange: { start: 2, end: 20 },
    shadowedSeqs: Array.from({ length: 14 }, (_, index) => index + 2),
    shadowedTokenCount: 18_240,
  })
  log.add('compaction/end', { compactionId: 'cmp1', turn: null })

  log.user('再试一次上传。')
  log.turnStart(3)
  log.stepStart(3, 1)
  log.add('llm/retry', {
    retryId: 'r3',
    turn: 3,
    step: 1,
    provider: 'deepseek',
    mode: 'normal',
    retry: 1,
    maxRetries: 3,
    delayMs: 45_000,
    failure: {
      message: 'rate limited: 429 Too Many Requests',
      code: 'RATE_LIMIT',
    },
  })
  // Running clock: the open turn started a while ago.
  const events = log.events.map((event) =>
    event.type === 'turn/start' && (event.data as { turn?: number }).turn === 3
      ? ({ ...event, time: now - 22_000 } as WireSessionEvent)
      : event,
  )
  return {
    id: 'notices',
    label: '重试 / 错误 / 压缩',
    sessions: [{ id: 'notices', events }],
  }
}

/** Workflow + ralph runs, a standalone run and a background job. */
export function workflowScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 6 * 60_000)
  log.user('并行审查 auth、billing、search 三个模块，然后修复发现的问题。')
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [{ text: '我用一个工作流并行审查三个模块，再汇总修复。' }],
    [
      {
        id: 'call_wf',
        name: 'workflow',
        args: {
          meta: {
            name: 'module-review',
            description: '并行审查三个模块并修复',
            phases: ['审查', '修复'],
          },
          script:
            "export default async function run(ctx) {\n  ctx.phase('审查')\n  const reviews = await Promise.all(\n    ['auth', 'billing', 'search'].map((m) => ctx.agent(`审查 ${m}`, { prompt: m })),\n  )\n  ctx.phase('修复')\n  return ctx.agent('修复问题', { prompt: reviews.join('\\n') })\n}",
        },
        between: (l) => {
          l.add('tool-workflow/run-start', {
            runId: 'run-1',
            name: 'module-review',
            description: '并行审查三个模块并修复',
            tool: 'workflow',
            callId: 'call_wf',
          })
          l.add('tool-workflow/phase', { runId: 'run-1', title: '审查' })
          for (const [seq, label] of [
            [1, '审查 auth'],
            [2, '审查 billing'],
            [3, '审查 search'],
          ] as const)
            l.add('tool-workflow/agent-start', {
              runId: 'run-1',
              seq,
              label,
              childId: `wf-child-${seq}`,
            })
          l.add('tool-workflow/agent-end', {
            runId: 'run-1',
            seq: 1,
            outcome: 'completed',
          })
          l.add('tool-workflow/agent-end', {
            runId: 'run-1',
            seq: 3,
            outcome: 'failed',
          })
          l.add('tool-workflow/log', {
            runId: 'run-1',
            message: 'search 审查超时，已记录，继续修复阶段',
          })
          l.add('tool-workflow/phase', { runId: 'run-1', title: '修复' })
          l.add('tool-workflow/agent-start', {
            runId: 'run-1',
            seq: 4,
            label: '修复 auth 会话过期',
            childId: 'wf-child-4',
          })
        },
      },
    ],
  )
  // A settled ralph run earlier in the same step list (for the panel look).
  log.toolStep(
    1,
    2,
    [],
    [
      {
        id: 'call_bg',
        name: 'bash',
        args: {
          command: 'pnpm run e2e --reporter=line',
          description: '后台运行端到端测试',
          run_in_background: true,
        },
        between: (l) => {
          l.add('job/started', {
            jobId: 'job-7',
            kind: 'process',
            command: 'pnpm run e2e',
          })
        },
        result: 'started background job job-7',
        extra: { meta: { kind: 'background', jobId: 'job-7' } },
      },
      {
        id: 'call_ralph',
        name: 'ralph',
        args: { objective: '让 search 模块的集成测试全部通过', maxRounds: 4 },
        between: (l) => {
          l.add('tool-workflow/run-start', {
            runId: 'run-2',
            name: 'ralph-loop',
            tool: 'ralph',
            callId: 'call_ralph',
          })
          for (const seq of [1, 2, 3])
            l.add('tool-workflow/agent-start', {
              runId: 'run-2',
              seq,
              label: `第 ${seq} 轮`,
              childId: `ralph-${seq}`,
            })
          for (const seq of [1, 2, 3])
            l.add('tool-workflow/agent-end', {
              runId: 'run-2',
              seq,
              outcome: 'completed',
            })
          l.add('tool-workflow/run-end', {
            runId: 'run-2',
            stopReason: 'completed',
            agentsStarted: 3,
            result: '第 3 轮后集成测试全部通过',
          })
        },
        result: '第 3 轮后集成测试全部通过',
        extra: { meta: { kind: 'ralph', runId: 'run-2', agentsStarted: 3 } },
      },
    ],
  )
  log.add('tool-workflow/run-start', {
    runId: 'run-3',
    name: 'nightly-audit',
    description: '夜间依赖审计',
  })
  log.add('tool-workflow/agent-start', {
    runId: 'run-3',
    seq: 1,
    label: '扫描依赖漏洞',
    childId: 'audit-1',
  })
  log.add('tool-workflow/agent-end', {
    runId: 'run-3',
    seq: 1,
    outcome: 'completed',
  })
  log.add('tool-workflow/run-end', {
    runId: 'run-3',
    stopReason: 'completed',
    agentsStarted: 1,
  })
  log.toolStep(
    1,
    3,
    [],
    [
      {
        id: 'call_bg_sub',
        name: 'subagent',
        args: {
          description: '整理审查报告',
          prompt: '汇总三个模块的审查结论，写成 markdown 报告。',
          run_in_background: true,
        },
        between: (l) => {
          l.add('subagent/started', {
            subagentId: 'report-child',
            description: '整理审查报告',
            mode: 'spawn',
            background: true,
            callId: 'call_bg_sub',
          })
        },
        result: 'started subagent report-child',
        extra: {
          meta: {
            kind: 'continuable',
            subagentId: 'report-child',
            description: '整理审查报告',
            mode: 'spawn',
          },
        },
      },
    ],
  )
  const events = log.events.map((event) =>
    event.type === 'turn/start'
      ? ({ ...event, time: now - 95_000 } as WireSessionEvent)
      : event,
  )
  return {
    id: 'workflow',
    label: '工作流 / 子智能体',
    sessions: [{ id: 'workflow', events }],
  }
}

/** Interaction tools: ask_user_question, exit_plan_mode, MCP, skill, scheduler, memory. */
export function interactionsScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 30 * 60_000)
  log.user('/plan 设计一个每天早上汇总 GitHub 通知的定时任务')
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [{ text: '先确认几个细节。' }],
    [
      {
        id: 'call_ask',
        name: 'ask_user_question',
        args: {
          questions: [
            {
              id: 'time',
              header: '时间',
              question: '每天几点推送？',
              options: [
                { label: '08:30（推荐）', description: '上班前浏览' },
                { label: '10:00' },
              ],
            },
            {
              id: 'scope',
              header: '范围',
              question: '需要包含哪些通知？',
              multiSelect: true,
              options: [
                { label: 'PR 评审请求' },
                { label: 'Issue 提及' },
                { label: 'CI 失败' },
              ],
            },
          ],
        },
        between: (l) => {
          l.add('question/asked', {
            id: 'q1',
            callId: 'call_ask',
            questions: [
              {
                id: 'time',
                header: '时间',
                question: '每天几点推送？',
                options: [
                  { label: '08:30（推荐）', description: '上班前浏览' },
                  { label: '10:00' },
                ],
              },
              {
                id: 'scope',
                header: '范围',
                question: '需要包含哪些通知？',
                multiSelect: true,
                options: [
                  { label: 'PR 评审请求' },
                  { label: 'Issue 提及' },
                  { label: 'CI 失败' },
                ],
              },
            ],
          })
          l.add('question/answered', {
            id: 'q1',
            answers: {
              time: { selected: ['08:30（推荐）'] },
              scope: {
                selected: ['PR 评审请求', 'CI 失败'],
                custom: '忽略 dependabot',
              },
            },
          })
        },
        result: '{"answers":[...]}',
        extra: { meta: { answers: {} } },
      },
    ],
  )
  log.toolStep(
    1,
    2,
    [],
    [
      {
        id: 'call_mcp',
        name: 'mcp_github_list_notifications',
        args: { participating: true, since: '2026-09-21T00:00:00Z' },
        result:
          '[{"id":"1","reason":"review_requested","subject":{"title":"feat: dsh chat timeline","type":"PullRequest"}},{"id":"2","reason":"ci_activity","subject":{"title":"release-preview failed","type":"CheckSuite"}}]',
        extra: {
          meta: {
            mcp: true,
            server: 'github',
            tool: 'list_notifications',
            summary: '2 条通知',
          },
        },
      },
      {
        id: 'call_skill',
        name: 'skill',
        args: { name: 'github-digest' },
        result:
          '# GitHub Digest\n\n把通知按仓库分组，每组最多 5 条，PR 评审请求置顶。',
        extra: {
          meta: {
            name: 'github-digest',
            source: 'project',
            root: 'skills/github-digest',
          },
        },
      },
    ],
  )
  log.toolStep(
    1,
    3,
    [],
    [
      {
        id: 'call_plan',
        name: 'exit_plan_mode',
        args: {
          plan: '# GitHub 通知晨报\n\n1. 每天 08:30（Asia/Shanghai）触发定时任务。\n2. 通过 GitHub MCP 拉取 PR 评审请求与 CI 失败通知，忽略 dependabot。\n3. 用 `github-digest` 技能按仓库分组，生成晨报。\n4. 推送到本地运行界面。',
        },
        result:
          'Plan approved — plan mode exited; carry out the plan starting with your next step.',
        extra: { meta: { approved: true, title: 'GitHub 通知晨报' } },
      },
    ],
  )
  log.toolStep(
    1,
    4,
    [],
    [
      {
        id: 'call_sched',
        name: 'scheduler',
        args: {
          action: 'add',
          name: 'GitHub 通知晨报',
          message:
            '汇总昨晚以来的 GitHub 通知（PR 评审请求、CI 失败），按仓库分组。',
          cron_expr: '30 8 * * *',
          tz: 'Asia/Shanghai',
        },
        result: '已创建定时任务 job_2f81：每天 08:30 (Asia/Shanghai)',
      },
      {
        id: 'call_mem',
        name: 'memory_edit',
        args: {
          target: 'user',
          new_string: '- 每天 08:30 接收 GitHub 通知晨报，忽略 dependabot。',
        },
        result:
          'Updated user memory. The new memory reaches you from the next turn.',
        extra: { meta: { target: 'user' } },
      },
    ],
  )
  log.stepStart(1, 5)
  log.stream(1, 5, [{ text: '定时任务已创建，明早 08:30 会收到第一份晨报。' }])
  log.stepEnd(1, 5)
  log.turnEnd(1)
  return {
    id: 'interactions',
    label: '提问 / 计划 / MCP',
    sessions: [{ id: 'interactions', events: log.events }],
  }
}

/**
 * Streaming: history holds the prompt and turn start; the reasoning, text
 * and a running tool arrive live. `stage` stops the replay early.
 */
export function streamingScenario(
  now = Date.now(),
  stage: 'reasoning' | 'text' | 'tool' | 'all' = 'all',
): Scenario {
  const log = new ShowcaseLog(now - 1_500)
  log.user('解释一下这个仓库的会话持久化是怎么做的。')
  log.turnStart(1)
  log.stepStart(1, 1)
  const cut = log.events.length
  const reasoning =
    '会话持久化在 core 的 session-log 里。\n每个会话一个 history.jsonl，事件按 seq 追加。\n还有 _checkpoint.json 记录压缩后的表面。\nrenderer 通过 sessions.history 分页读取原始事件，再在 conversation/ 里投影成聊天节点。'
  const text =
    '会话持久化分三层：\n\n- **事件日志**：`stateRoot/sessions/<id>/history.jsonl`，只追加；\n- **检查点**：`_checkpoint.json` 保存压缩后的模型可见表面；\n- **运行事件**：`runtime/events.jsonl` 给侧栏和桌宠用。'
  const blocks =
    stage === 'reasoning'
      ? [{ reasoning }]
      : stage === 'text'
        ? [{ reasoning }, { text }]
        : [
            { reasoning },
            { text },
            {
              tool: {
                id: 'live_read',
                name: 'read',
                args: { file_path: 'packages/core/src/session-log/store.ts' },
              },
            },
          ]
  log.stream(1, 1, blocks, { settle: stage === 'all' || stage === 'tool' })
  if (stage === 'tool' || stage === 'all')
    log.call(1, 1, 'live_read', 'read', {
      file_path: 'packages/core/src/session-log/store.ts',
    })
  const trimmed =
    stage === 'reasoning'
      ? log.events.filter(
          (event) =>
            !(
              event.type === 'assistant/chunk' &&
              (event.data as { chunk: { type: string } }).chunk.type ===
                'block-end'
            ),
        )
      : log.events
  const history = trimmed.slice(0, cut)
  const live = trimmed.slice(cut)
  // Keep the partial reasoning of the reasoning stage mid-stream.
  const liveEvents =
    stage === 'reasoning' ? live.slice(0, Math.max(1, live.length - 3)) : live
  return {
    id: 'streaming',
    label: '流式输出',
    sessions: [{ id: 'streaming', events: history, live: liveEvents }],
  }
}

/** Long history (paging): many short turns. */
export function longScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 3 * 3600_000)
  for (let turn = 1; turn <= 30; turn++) {
    log.user(`第 ${turn} 个问题：帮我检查 module-${turn} 的导出。`)
    log.turnStart(turn)
    log.toolStep(
      turn,
      1,
      [],
      [
        {
          id: `l_${turn}`,
          name: 'grep',
          args: { pattern: 'export ', path: `src/module-${turn}` },
          result: `Found 1 match\n\nsrc/module-${turn}/index.ts\nLine 1: export * from './core'`,
        },
      ],
    )
    log.stepStart(turn, 2)
    log.stream(turn, 2, [{ text: `module-${turn} 只有一个桶导出，没有问题。` }])
    log.stepEnd(turn, 2)
    log.turnEnd(turn)
  }
  return {
    id: 'long',
    label: '长历史',
    sessions: [{ id: 'long', events: log.events }],
  }
}

/** A reply that links files of every kind (E-track contract §4). */
export function linksScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 4 * 60_000)
  log.user('这一轮改了哪些文件？')
  log.turnStart(1)
  log.stepStart(1, 1)
  log.stream(1, 1, [
    {
      text: [
        '这一轮改了这些文件：',
        '',
        '- [src/pages/Login.vue](src/pages/Login.vue)：表单容器改成响应式宽度',
        '- [login.ts:42](src/api/login.ts#L42)：接口错误提示',
        '- [布局修复说明](docs/login-layout.md) 与 [src/components/](src/components/)',
        '- [已删除的旧样式](src/styles/login-old.css)',
        '',
        '同目录的其他文件：[package.json](package.json)、[logo.png](public/logo.png)、[report.pdf](docs/report.pdf)、[data.xlsx](docs/data.xlsx)、[dist.zip](dist.zip)、[Main.java](app/Main.java)、[Dockerfile.dev](Dockerfile.dev)。',
        '',
        '脚本与原生代码：[main.py](scripts/main.py)、[deploy.sh](scripts/deploy.sh)、[App.swift](ios/App.swift)、[server.go](cmd/server.go)、[lib.rs](core/lib.rs)、[index.html](public/index.html)、[app.css](src/app.css)、[main.js](src/main.js)。',
        '',
        '参考 [MDN 媒体查询](https://developer.mozilla.org/zh-CN/docs/Web/CSS/Media_Queries)。',
      ].join('\n'),
    },
  ])
  log.stepEnd(1, 1)
  log.turnEnd(1)
  return {
    id: 'links',
    label: '文档链接',
    sessions: [{ id: 'links', events: log.events }],
  }
}

/**
 * Tasks of one turn each that changed files: a recorded card, an undone
 * one, an unrecorded one (UI-S15: every record names its task).
 */
export function turnFilesScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 8 * 60_000)
  const files = [
    {
      path: 'src/pages/Login.vue',
      status: 'modified',
      additions: 18,
      deletions: 6,
    },
    {
      path: 'src/pages/login.test.ts',
      status: 'added',
      additions: 42,
      deletions: 0,
    },
    {
      path: 'src/styles/很长的中文目录/with spaces/desktop-styles-and-resource-presentation-compatibility/login-old.css',
      status: 'deleted',
      additions: 0,
      deletions: 31,
    },
    {
      path: 'src/api/auth.ts',
      oldPath: 'src/api/login.ts',
      status: 'renamed',
      additions: 2,
      deletions: 2,
    },
    {
      path: 'public/login-hero.png',
      status: 'added',
      additions: null,
      deletions: null,
      binary: true,
    },
    { path: 'docs/login.md', status: 'modified', additions: 5, deletions: 1 },
    { path: 'package.json', status: 'modified', additions: 1, deletions: 1 },
  ]
  const turn = (number: number, prompt: string, reply: string) => {
    log.user(prompt)
    log.turnStart(number)
    log.stepStart(number, 1)
    log.stream(number, 1, [{ text: reply }])
    log.stepEnd(number, 1)
    log.turnEnd(number)
  }
  turn(
    1,
    '把登录页改成响应式，并补上测试。',
    '改好了：表单容器改为响应式宽度，旧样式删掉，补了登录测试。',
  )
  log.add('turn/files', {
    turn: 1,
    task: { firstTurn: 1, lastTurn: 1 },
    mode: 'git',
    status: 'recorded',
    files,
    totals: { files: 7, additions: 68, deletions: 41 },
    concurrent: true,
    snapshot: { before: 'b'.repeat(40), after: 'a'.repeat(40) },
  })
  turn(2, '顺便更新一下 README。', 'README 已更新。')
  log.add('turn/files', {
    turn: 2,
    task: { firstTurn: 2, lastTurn: 2 },
    mode: 'git',
    status: 'recorded',
    files: [
      { path: 'README.md', status: 'modified', additions: 4, deletions: 2 },
      { path: 'CHANGELOG.md', status: 'modified', additions: 1, deletions: 0 },
    ],
    totals: { files: 2, additions: 5, deletions: 2 },
    snapshot: { before: 'c'.repeat(40), after: 'd'.repeat(40) },
  })
  log.add('turn/files-reverted', {
    turn: 2,
    reverted: ['README.md'],
    skipped: [{ path: 'CHANGELOG.md', reason: 'changed-since' }],
  })
  turn(3, '整理一下 dist 目录。', '整理完成。')
  log.add('turn/files', {
    turn: 3,
    task: { firstTurn: 3, lastTurn: 3 },
    mode: 'git',
    status: 'skipped',
    skipReason: 'timeout',
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
  })
  return {
    id: 'turn-files',
    label: '改动卡',
    sessions: [{ id: 'turn-files', events: log.events }],
  }
}

/**
 * UI-S15: one task, two turns — the user's message starts three background
 * writers; their results wake Emperor, which assembles the book. While the
 * writers run there is no files card (`running`); once the woken turn ends
 * one card sums the whole task, after that turn, before its footer.
 */
export function taskFilesScenario(
  now = Date.now(),
  phase: 'running' | 'done' = 'done',
): Scenario {
  const log = new ShowcaseLog(now - (phase === 'done' ? 7 : 2) * 60_000)
  const writers = [
    { id: 'writer-1', chapter: '01-订单.md', title: '写第 1 章 订单' },
    { id: 'writer-2', chapter: '02-回声.md', title: '写第 2 章 回声' },
    { id: 'writer-3', chapter: '03-另一个我.md', title: '写第 3 章 另一个我' },
  ]
  log.user('设定圣经写好了。派三个子智能体各写一章，写完汇编成全书。')
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [{ reasoning: '先把设定圣经落盘，再把三章分给三个执笔者。' }],
    [
      {
        id: 'call_bible',
        name: 'write',
        args: { file_path: 'novel/00-设定圣经.md', content: '# 设定圣经\n' },
        result:
          '<path>novel/00-设定圣经.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>',
        extra: {
          meta: {
            path: 'novel/00-设定圣经.md',
            kind: 'write',
            operation: 'create',
            added: 153,
            removed: 0,
          },
        },
      },
      ...writers.map((writer) => ({
        id: `call_${writer.id}`,
        name: 'subagent',
        args: {
          description: writer.title,
          prompt: `按设定圣经${writer.title}，写进 novel/${writer.chapter}。`,
          run_in_background: true,
        },
        between: (l: ShowcaseLog) => {
          l.add('subagent/started', {
            subagentId: writer.id,
            description: writer.title,
            mode: 'spawn',
            background: true,
            callId: `call_${writer.id}`,
          })
        },
        result: `started subagent ${writer.id}`,
        extra: {
          meta: {
            kind: 'continuable',
            subagentId: writer.id,
            description: writer.title,
            mode: 'spawn',
          },
        },
      })),
    ],
  )
  log.stepStart(1, 2)
  log.stream(1, 2, [
    { text: '三位执笔者已经开工，三章都交回后我再统一校对、汇编全书。' },
  ])
  log.stepEnd(1, 2)
  log.turnEnd(1)
  if (phase === 'running')
    return {
      id: 'task-files-running',
      label: '任务进行中',
      sessions: [{ id: 'task-files-running', events: log.events }],
    }

  log.tick(5 * 60_000)
  for (const writer of writers)
    log.add('subagent/settled', {
      subagentId: writer.id,
      stopReason: 'completed',
      text: `${writer.chapter} 已写完。`,
    })
  // The writers' results wake Emperor: the same task goes on.
  log.turnStart(2)
  log.stepStart(2, 1)
  for (const writer of writers)
    log.context('subagent', `Subagent ${writer.id} completed.`, {
      form: 'notice',
      summary: `${writer.title} 已完成`,
    })
  log.stream(2, 1, [
    { reasoning: '三章都在了，读一遍再汇编。' },
    {
      tool: {
        id: 'call_read',
        name: 'read',
        args: { file_path: 'novel/02-回声.md' },
      },
    },
    {
      tool: {
        id: 'call_book',
        name: 'write',
        args: { file_path: 'novel/全书.md', content: '# 全书\n' },
      },
    },
  ])
  log.call(2, 1, 'call_read', 'read', { file_path: 'novel/02-回声.md' })
  log.result(2, 1, 'call_read', '# 第 2 章 回声\n……')
  log.call(2, 1, 'call_book', 'write', {
    file_path: 'novel/全书.md',
    content: '# 全书\n',
  })
  log.result(
    2,
    1,
    'call_book',
    '<path>novel/全书.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>',
    {
      meta: {
        path: 'novel/全书.md',
        kind: 'write',
        operation: 'create',
        added: 640,
        removed: 0,
      },
    },
  )
  log.stepEnd(2, 1)
  log.stepStart(2, 2)
  log.stream(2, 2, [
    {
      text: '全书已汇编并校对：第 2 章执笔者交回的是改过的版本，时间线和人物称谓都已统一。',
    },
  ])
  log.stepEnd(2, 2)
  log.turnEnd(2)
  log.add('turn/files', {
    turn: 2,
    task: { firstTurn: 1, lastTurn: 2 },
    mode: 'git',
    status: 'recorded',
    files: [
      {
        path: 'novel/00-设定圣经.md',
        status: 'added',
        additions: 153,
        deletions: 0,
      },
      {
        path: 'novel/01-订单.md',
        status: 'added',
        additions: 214,
        deletions: 0,
      },
      {
        path: 'novel/02-回声.md',
        status: 'added',
        additions: 192,
        deletions: 0,
      },
      {
        path: 'novel/03-另一个我.md',
        status: 'added',
        additions: 201,
        deletions: 0,
      },
      { path: 'novel/全书.md', status: 'added', additions: 640, deletions: 0 },
    ],
    totals: { files: 5, additions: 1400, deletions: 0 },
    snapshot: { before: 'e'.repeat(40), after: 'f'.repeat(40) },
  })
  return {
    id: 'task-files',
    label: '这次任务的改动',
    sessions: [{ id: 'task-files', events: log.events }],
  }
}

/**
 * AGT-06: subagent result cards — waiting to be applied, conflicting with
 * the project, applied (with 撤销), and one left alone for 15 days.
 */
export function subagentResultsScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 120_000)
  const turn = (number: number, prompt: string, reply: string) => {
    log.user(prompt)
    log.turnStart(number)
    log.stepStart(number, 1)
    log.stream(number, 1, [{ text: reply }])
    log.stepEnd(number, 1)
    log.turnEnd(number)
  }
  const result = (data: Record<string, unknown>) =>
    log.add('delegation/result', {
      backend: 'codex',
      state: 'ready',
      at: now - 60_000,
      ...data,
    })
  turn(
    1,
    '让 Codex 把登录页重构成响应式，Claude Code 补上测试。',
    '已经分别派给 Codex 和 Claude Code，它们在各自独立的工作区里改，完成后成果会出现在这里。',
  )
  result({
    delegation_id: 'dlg-login',
    run_id: 'dgr-login',
    title: '重构登录页',
    files: [
      {
        path: 'src/login/LoginForm.vue',
        status: 'modified',
        additions: 64,
        deletions: 5,
      },
      {
        path: 'src/login/useLogin.ts',
        status: 'added',
        additions: 38,
        deletions: 0,
      },
      {
        path: 'src/login/login.css',
        status: 'modified',
        additions: 12,
        deletions: 3,
      },
      {
        path: 'src/login/legacy.css',
        status: 'deleted',
        additions: 0,
        deletions: 0,
      },
      {
        path: 'public/login-hero.png',
        status: 'added',
        additions: null,
        deletions: null,
        binary: true,
      },
      { path: 'package.json', status: 'modified', additions: 6, deletions: 0 },
    ],
    totals: { files: 6, additions: 120, deletions: 8 },
  })
  result({
    delegation_id: 'dlg-tests',
    run_id: 'dgr-tests',
    backend: 'claude-code',
    title: '补全登录测试',
    state: 'conflicted',
    conflicts: ['src/login/LoginForm.vue'],
    files: [
      {
        path: 'src/login/LoginForm.vue',
        status: 'modified',
        additions: 3,
        deletions: 1,
      },
      {
        path: 'tests/login.spec.ts',
        status: 'added',
        additions: 42,
        deletions: 0,
      },
    ],
    totals: { files: 2, additions: 45, deletions: 1 },
  })
  turn(2, '文档也顺手更新一下。', 'Codex 改好了文档，我已经帮你应用到项目里。')
  result({
    delegation_id: 'dlg-docs',
    run_id: 'dgr-docs',
    title: '更新登录文档',
    state: 'applied',
    by: 'model',
    undoable: true,
    files: [
      {
        path: 'docs/login.md',
        status: 'modified',
        additions: 18,
        deletions: 6,
      },
      { path: 'README.md', status: 'modified', additions: 2, deletions: 1 },
    ],
    totals: { files: 2, additions: 20, deletions: 7 },
  })
  result({
    delegation_id: 'dlg-old',
    run_id: 'dgr-old',
    title: '清理旧脚本',
    at: now - 15 * 86_400_000,
    files: [
      {
        path: 'scripts/old-build.sh',
        status: 'deleted',
        additions: 0,
        deletions: 24,
      },
    ],
    totals: { files: 1, additions: 0, deletions: 24 },
  })
  return {
    id: 'subagent-results',
    label: '子智能体成果',
    sessions: [{ id: 'subagent-results', events: log.events }],
  }
}

/**
 * DSH-23: the model is writing an `edit` call — the file name is complete,
 * the replacement is still arriving (the replay stops mid-arguments).
 */
export function preparingScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 2_000)
  log.user('把登录卡片改成响应式宽度。')
  log.turnStart(1)
  log.stepStart(1, 1)
  const cut = log.events.length
  const chunk = (value: unknown): void => {
    log.add('assistant/chunk', { turn: 1, step: 1, chunk: value })
  }
  chunk({ type: 'block-start', index: 0, blockType: 'reasoning' })
  chunk({ type: 'reasoning-delta', index: 0, text: '直接改样式里的宽度。' })
  chunk({
    type: 'block-end',
    index: 0,
    block: { type: 'reasoning', text: '直接改样式里的宽度。' },
  })
  chunk({ type: 'block-start', index: 1, blockType: 'tool-call' })
  const args = JSON.stringify({
    file_path: 'src/components/LoginForm.vue',
    old_string: '.login-card {\n  width: 480px;\n}'.repeat(8),
    new_string: '.login-card {\n  width: min(480px, 100%);\n}',
  })
  for (let index = 0; index < args.length - 20; index += 8)
    chunk({
      type: 'tool-call-delta',
      index: 1,
      id: 'prep_edit',
      name: 'edit',
      argumentsDelta: args.slice(index, index + 8),
    })
  return {
    id: 'preparing',
    label: '准备工具调用',
    sessions: [
      {
        id: 'preparing',
        events: log.events.slice(0, cut),
        live: log.events.slice(cut),
      },
    ],
  }
}

/** UI-S03 scroll check: 500 finished turns, each with a process group. */
export function longProcessScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 48 * 3600_000)
  for (let turn = 1; turn <= 500; turn++) {
    log.user(`第 ${turn} 轮：检查 module-${turn}。`)
    log.turnStart(turn)
    log.toolStep(
      turn,
      1,
      [{ reasoning: `看看 module-${turn} 的导出。` }],
      [
        {
          id: `lp_${turn}`,
          name: 'grep',
          args: { pattern: 'export ', path: `src/module-${turn}` },
          result: `Found 1 match\n\nsrc/module-${turn}/index.ts\nLine 1: export * from './core'`,
        },
      ],
    )
    log.stepStart(turn, 2)
    log.stream(turn, 2, [{ text: `module-${turn} 没有问题。` }], {
      firstTokenMs: 200,
    })
    log.stepEnd(turn, 2)
    log.turnEnd(turn)
  }
  return {
    id: 'long-process',
    label: '500 轮',
    sessions: [{ id: 'long-process', events: log.events }],
  }
}

/** UI-S03 typography: a long prompt with a file, a reply with headings. */
export function typographyScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 3 * 60_000)
  log.user(
    '帮我整理一下登录页这次改动的说明：为什么会在移动端横向溢出、改了哪些文件、怎么验证，最好写成可以直接贴进 PR 描述的样子，标题层级清楚一点。',
    {
      attachments: [
        {
          id: 'att-notes',
          name: 'login-notes.md',
          mime: 'text/markdown',
          size: 2_310,
          kind: 'file',
        },
      ],
    },
  )
  log.turnStart(1)
  log.stepStart(1, 1)
  log.stream(1, 1, [
    {
      text: [
        '# 登录页移动端布局修复',
        '',
        '问题出在 [布局说明](docs/login-layout.md) 里记下的固定宽度：`.login-card` 写死了 `width: 480px`，375px 宽的屏幕会横向溢出。',
        '',
        '改成 `min(480px, 100%)` 之后，外边距用 `clamp()` 收紧，参见 [MDN · min()](https://developer.mozilla.org/docs/Web/CSS/min)。',
        '',
        '## 改动的文件',
        '',
        '- `LoginForm.vue`：卡片宽度与外边距',
        '- `LoginForm.spec.ts`：提交态与禁用态',
        '',
        '### 怎么验证',
        '',
        '在 375 × 812 的视口里打开登录页，页面不再出现横向滚动条。',
      ].join('\n'),
    },
  ])
  log.stepEnd(1, 1)
  log.turnEnd(1)
  return {
    id: 'typography',
    label: '排版',
    sessions: [{ id: 'typography', events: log.events }],
  }
}

// ── UI-S14: subagents in the conversation ──────────────────────────────

const CHAPTERS = [
  '订单',
  '回声',
  '旧磁带',
  '桥下',
  '另一个我',
  '白噪',
  '物证',
  '潮汐舱',
  '回声的源头',
  '末班潮',
] as const

const COVER_REFUSED = '模型 gpt-6.1-sol 被这个 ChatGPT 账号拒绝（400）'

interface Writer {
  readonly callId: string
  readonly id: string
  readonly description: string
  readonly backend?: 'codex' | 'claude-code'
}

/** The eleven subagents of the novel: ten chapters and a cover. */
function novelWriters(): Writer[] {
  const writers: Writer[] = CHAPTERS.map((title, index) => {
    const chapter = index + 1
    const description = `写第 ${chapter} 章 ${title}`
    if (chapter === 5)
      return {
        callId: `call_ch${chapter}`,
        id: `dlg-ch${chapter}`,
        description: `codex ${description}`,
        backend: 'codex',
      }
    if (chapter === 10)
      return {
        callId: `call_ch${chapter}`,
        id: `dlg-ch${chapter}`,
        description,
        backend: 'claude-code',
      }
    return { callId: `call_ch${chapter}`, id: `sub-ch${chapter}`, description }
  })
  writers.push({
    callId: 'call_cover',
    id: 'dlg-cover',
    description: 'codex 生图做小说封面',
    backend: 'codex',
  })
  return writers
}

function externalRun(
  log: ShowcaseLog,
  writer: Writer,
  task: Record<string, unknown>,
): void {
  log.add('delegation/projection', {
    event: 'delegation_run_changed',
    delegation_id: writer.id,
    run_id: `run-${writer.id}`,
    current_run_id: `run-${writer.id}`,
    parent_call_id: writer.callId,
    backend: writer.backend,
    journal_seq: 1,
    task: { description: writer.description, ...task },
  })
}

/**
 * One step sends the ten chapters and the cover out in the background
 * (UI-S14). `running`: eight still write, Codex refused both of its tasks,
 * Claude Code's run could not confirm its outcome. `continued`: two minutes
 * on, three chapters are back and the conversation went on below the group
 * (the status bar's case). `done`: every chapter is back, 6 分 12 秒 after
 * they started.
 */
export function subagentsScenario(
  now = Date.now(),
  stage: 'running' | 'continued' | 'done' = 'running',
): Scenario {
  const started =
    stage === 'running'
      ? now - 49_000
      : stage === 'continued'
        ? now - 130_000
        : now - 420_000
  const log = new ShowcaseLog(started - 41_000)
  log.user(
    '设定圣经写好了。派 10 个子智能体并行写十章，每章 1100 字左右；再让 Codex 生成一张封面。',
  )
  log.turnStart(1)
  log.toolStep(
    1,
    1,
    [
      { reasoning: '先读设定圣经，再分章节交给执笔者。' },
      { text: '先读一下设定圣经。' },
    ],
    [
      {
        id: 'call_bible',
        name: 'read',
        args: { file_path: 'novel/00-设定圣经.md' },
        result: readResult(
          'novel/00-设定圣经.md',
          '# 设定圣经\n\n时间线：九月。',
        ),
        extra: {
          meta: {
            path: 'novel/00-设定圣经.md',
            startLine: 1,
            endLine: 3,
            totalLines: 3,
          },
        },
      },
    ],
  )
  const writers = novelWriters()
  log.stepStart(1, 2)
  log.stream(1, 2, [
    { text: '我把设定圣经交给每个执笔者，十章同时开写；封面交给 Codex。' },
    ...writers.map((writer) => ({
      tool: {
        id: writer.callId,
        name: 'subagent',
        args: { description: writer.description },
      },
    })),
  ])
  log.tick(Math.max(0, started - (log.events.at(-1)?.time ?? started)))
  for (const writer of writers) {
    const args = {
      description: writer.description,
      prompt: `按设定圣经写「${writer.description}」，1100 字左右。`,
      run_in_background: true,
      ...(writer.backend ? { backend: writer.backend } : {}),
    }
    log.call(1, 2, writer.callId, 'subagent', args)
    if (writer.backend)
      externalRun(log, writer, { status: 'running', started_at: started })
    else
      log.add('subagent/started', {
        subagentId: writer.id,
        description: writer.description,
        mode: 'spawn',
        background: true,
        callId: writer.callId,
      })
    log.add(
      'tool/result',
      {
        turn: 1,
        step: 2,
        message: {
          id: `result-${writer.callId}`,
          role: 'user',
          source: { kind: 'tool', callId: writer.callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: writer.callId,
              content: [{ type: 'text', text: `started ${writer.id}` }],
            },
          ],
        },
        meta: { kind: 'continuable', subagentId: writer.id },
      },
      { surfaceOp: 'append' },
    )
  }
  log.stepEnd(1, 2)
  // Codex refused both of its tasks within seconds.
  for (const writer of writers.filter((item) => item.backend === 'codex'))
    externalRun(log, writer, {
      status: 'failed',
      started_at: started,
      finished_at: started + (writer.id === 'dlg-cover' ? 7_000 : 14_000),
      detail: COVER_REFUSED,
    })
  log.stepStart(1, 3)
  log.stream(1, 3, [
    {
      text: '十章都在写，封面那边 Codex 报错了（账号不支持 gpt-6.1-sol），我改用本地生图脚本补上。等剩下的章节写完，我再统一校对、汇编全书。',
    },
  ])
  log.stepEnd(1, 3)
  log.turnEnd(1)
  const chapterTen = writers.find((writer) => writer.id === 'dlg-ch10')!
  if (stage !== 'done') {
    externalRun(log, chapterTen, {
      status: 'outcome_unknown',
      started_at: started,
    })
    if (stage === 'continued') continueBelow(log, writers, started)
  } else {
    writers.forEach((writer, index) => {
      if (writer.backend === 'codex') return
      const ended = started + 300_000 + index * 8_000
      const report = `${writer.description.replace(/^写/u, '')}已写完，1100 字左右；人物称谓与时间线按设定圣经统一为九月。`
      if (writer.backend)
        externalRun(log, writer, {
          status: 'completed',
          started_at: started,
          finished_at: started + 372_000,
          detail: report,
        })
      else {
        log.tick(Math.max(0, ended - (log.events.at(-1)?.time ?? ended)))
        log.add('subagent/settled', {
          subagentId: writer.id,
          stopReason: 'completed',
          text: `## ${writer.description}\n\n${report}`,
        })
      }
    })
  }
  return {
    id: stage === 'done' ? 'subagents-done' : `subagents-${stage}`,
    label: stage === 'done' ? '子智能体（已结束）' : '子智能体（进行中）',
    sessions: [{ id: `subagents-${stage}`, events: log.events }],
  }
}

/** Chapters 1–3 come back; the user asks to check them; a long answer. */
function continueBelow(
  log: ShowcaseLog,
  writers: readonly Writer[],
  started: number,
): void {
  writers.slice(0, 3).forEach((writer, index) => {
    log.tick(
      Math.max(
        0,
        started + 70_000 + index * 4_000 - (log.events.at(-1)?.time ?? 0),
      ),
    )
    log.add('subagent/settled', {
      subagentId: writer.id,
      stopReason: 'completed',
      text: `${writer.description} 已写完，1100 字左右。`,
    })
  })
  log.user('先核对已经交回的章节。')
  log.turnStart(2)
  log.toolStep(
    2,
    1,
    [{ text: '逐章对照设定圣经。' }],
    ['01-订单', '02-回声', '03-旧磁带'].map((name, index) => ({
      id: `call_check_${index + 1}`,
      name: 'read',
      args: { file_path: `novel/${name}.md` },
      result: readResult(`novel/${name}.md`, `# ${name}\n\n正文……`),
      extra: {
        meta: {
          path: `novel/${name}.md`,
          startLine: 1,
          endLine: 3,
          totalLines: 3,
        },
      },
    })),
  )
  log.stepStart(2, 2)
  log.stream(2, 2, [
    {
      text: [
        '## 先核对已经交回的 3 章',
        '',
        '趁其他章节还在写，我把已经交回的第 1、2、3 章逐段对照设定圣经：',
        '',
        '- 第 1 章「订单」：人物出场顺序与设定一致；「七月」日期与时间线冲突，已记下，汇编时统一改成九月。',
        '- 第 2 章「回声」：林砚的病理写成「重复三天前听到的话」，与设定一致，后面几章都要沿用。',
        '- 第 3 章「旧磁带」：1542 字，比其余章节长；节奏偏慢，汇编时再看要不要压。',
        '',
        '## 封面',
        '',
        'Codex 那边的账号不支持 gpt-6.1-sol，我改写本地脚本 `tools/compose_cover.py`：标题、作者和副标题排版，背景用纯色渐变，生成后你再看一眼。',
        '',
        '## 接下来',
        '',
        '等第 4 到第 10 章交回，我再整体校对：统一时间线和人物称谓，检查每章的字数，最后汇编成 `novel/全书.md`。',
      ].join('\n'),
    },
  ])
  log.stepEnd(2, 2)
  log.turnEnd(2)
}

/**
 * UI-S14: one subagent per turn, in each state a single row shows — a
 * report, a refusal, Claude Code's review, a question, one still writing.
 */
export function subagentRowsScenario(now = Date.now()): Scenario {
  const log = new ShowcaseLog(now - 600_000)
  let turn = 0
  const dispatch = (
    prompt: string,
    writer: Writer,
    settle: (log: ShowcaseLog, startedAt: number) => void,
    answer: string,
  ): void => {
    turn += 1
    log.user(prompt)
    log.turnStart(turn)
    log.stepStart(turn, 1)
    log.stream(turn, 1, [
      {
        tool: {
          id: writer.callId,
          name: 'subagent',
          args: { description: writer.description },
        },
      },
    ])
    log.call(turn, 1, writer.callId, 'subagent', {
      description: writer.description,
      prompt: writer.description,
      run_in_background: true,
      ...(writer.backend ? { backend: writer.backend } : {}),
    })
    const startedAt = log.events.at(-1)?.time ?? now
    if (writer.backend)
      externalRun(log, writer, { status: 'running', started_at: startedAt })
    else
      log.add('subagent/started', {
        subagentId: writer.id,
        description: writer.description,
        mode: 'spawn',
        background: true,
        callId: writer.callId,
      })
    log.result(turn, 1, writer.callId, `started ${writer.id}`, {
      meta: { kind: 'continuable', subagentId: writer.id },
    })
    log.stepEnd(turn, 1)
    settle(log, startedAt)
    log.stepStart(turn, 2)
    log.stream(turn, 2, [{ text: answer }])
    log.stepEnd(turn, 2)
    log.turnEnd(turn)
  }
  dispatch(
    '看看 tankwar 的素材和文档能不能瘦身。',
    {
      callId: 'call_assets',
      id: 'sub-assets',
      description: '分析 tankwar 的素材与文档',
    },
    (l) => {
      l.tick(60_000)
      l.add('subagent/settled', {
        subagentId: 'sub-assets',
        stopReason: 'completed',
        text: '报告已交回：public/ 没有 publicDir 覆盖，assets/audio 24.4 MB 可以压缩到 6 MB 以内，docs/ 里有 3 份重复的截图。',
      })
    },
    '报告交回来了，音频是大头。',
  )
  const chapterFive: Writer = {
    callId: 'call_codex_ch5',
    id: 'dlg-codex-ch5',
    description: 'codex 写第 5 章 另一个我',
    backend: 'codex',
  }
  dispatch(
    '第 5 章交给 Codex 写。',
    chapterFive,
    (l, startedAt) =>
      externalRun(l, chapterFive, {
        status: 'failed',
        started_at: startedAt,
        finished_at: startedAt + 14_000,
        detail: COVER_REFUSED,
      }),
    'Codex 那边账号不支持这个模型，第 5 章我改派本地子智能体。',
  )
  const review: Writer = {
    callId: 'call_review',
    id: 'dlg-review',
    description: '审查 math.js',
    backend: 'claude-code',
  }
  dispatch(
    '让 Claude Code 审一下 math.js。',
    review,
    (l, startedAt) =>
      externalRun(l, review, {
        status: 'completed',
        started_at: startedAt,
        finished_at: startedAt + 38_000,
        detail: '没有参数校验；PI 精度只有两位，建议用 Math.PI。',
      }),
    '审查结果在上面，两处都值得改。',
  )
  const question: Writer = {
    callId: 'call_question',
    id: 'dlg-question',
    description: '整理发布说明',
    backend: 'codex',
  }
  dispatch(
    '发布说明交给 Codex 整理。',
    question,
    (l, startedAt) =>
      externalRun(l, question, {
        status: 'waiting_input',
        started_at: startedAt,
      }),
    'Codex 在问版本号写 0.2.0 还是 0.2，回答后它会继续。',
  )
  log.tick(Math.max(0, now - 49_000 - (log.events.at(-1)?.time ?? now)))
  dispatch(
    '第 9 章也开始写吧。',
    { callId: 'call_ch9', id: 'sub-ch9', description: '写第 9 章 回声的源头' },
    () => undefined,
    '第 9 章在写，写完我再看。',
  )
  return {
    id: 'subagent-rows',
    label: '子智能体行',
    sessions: [{ id: 'subagent-rows', events: log.events }],
  }
}

export const SCENARIO_BUILDERS: Record<string, (now: number) => Scenario> = {
  showcase: showcaseScenario,
  notices: noticesScenario,
  workflow: workflowScenario,
  interactions: interactionsScenario,
  streaming: (now) => streamingScenario(now, 'all'),
  'streaming-reasoning': (now) => {
    const scenario = streamingScenario(now, 'reasoning')
    return { ...scenario, id: 'streaming-reasoning' }
  },
  long: longScenario,
  links: linksScenario,
  'turn-files': turnFilesScenario,
  'task-files': (now) => taskFilesScenario(now, 'done'),
  'task-files-running': (now) => taskFilesScenario(now, 'running'),
  'subagent-results': subagentResultsScenario,
  preparing: preparingScenario,
  'long-process': longProcessScenario,
  typography: typographyScenario,
  subagents: (now) => subagentsScenario(now, 'running'),
  'subagents-done': (now) => subagentsScenario(now, 'done'),
  'subagent-rows': subagentRowsScenario,
}

/** History page over one fixture session (cut at turn boundaries). */
export function fixturePage(
  session: ScenarioSession,
  query: { beforeSeq?: number; maxMessages?: number },
  header: SessionHistoryPage['header'],
): SessionHistoryPage {
  const all = session.events
  const eligible = all.filter(
    (event) => query.beforeSeq === undefined || event.seq < query.beforeSeq,
  )
  const limit = query.maxMessages ?? 50
  let messages = 0
  let start = eligible.length
  while (start > 0 && messages < limit) {
    start--
    const type = eligible[start]?.type
    if (type === 'user/message' || type === 'assistant/message') messages++
  }
  // Snap back to the event right after the previous turn's end.
  while (start > 0 && eligible[start - 1]?.type !== 'turn/end') start--
  const events = eligible.slice(start)
  return {
    header,
    events,
    hasMore: start > 0,
    lastSeq: all.at(-1)?.seq ?? -1,
  }
}

/** VER-06: the version context of the failed Claude Code run below. */
export const VERSION_FAILURE_FIXTURE = {
  backend: 'claude-code' as const,
  profileId: 'claude-default',
  current: '2.1.315',
  lastGood: '2.1.310',
  verifiedMax: '2.1.310',
  reason:
    'Claude Code 2.1.315 自检不兼容：加载了 MCP server「x」，子智能体不允许使用 MCP',
  actions: ['rollback' as const, 'open_settings' as const],
}

/**
 * VER-06 (preview § 8): one Claude Code task fails because the installed
 * 2.1.315 loads an MCP server; the row says why, the last good version,
 * and offers 退回 2.1.310 and 打开设置.
 */
export function versionFailureScenario(now = Date.now()): Scenario {
  const started = now - 30_000
  const log = new ShowcaseLog(started - 20_000)
  log.user('让 Claude Code 读一下 README，总结三点。')
  log.turnStart(1)
  const writer: Writer = {
    callId: 'call_readme',
    id: 'dlg-readme',
    description: '读一下 README 总结三点',
    backend: 'claude-code',
  }
  log.stepStart(1, 1)
  log.stream(1, 1, [
    { text: '交给 Claude Code。' },
    {
      tool: {
        id: writer.callId,
        name: 'subagent',
        args: { description: writer.description },
      },
    },
  ])
  log.call(1, 1, writer.callId, 'subagent', {
    description: writer.description,
    prompt: '读 README.md，用三点总结。',
    run_in_background: true,
    backend: 'claude-code',
  })
  externalRun(log, writer, { status: 'running', started_at: started })
  log.add(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `result-${writer.callId}`,
        role: 'user',
        source: { kind: 'tool', callId: writer.callId },
        content: [
          {
            type: 'tool-result',
            toolCallId: writer.callId,
            content: [{ type: 'text', text: `started ${writer.id}` }],
          },
        ],
      },
      meta: { kind: 'continuable', subagentId: writer.id },
    },
    { surfaceOp: 'append' },
  )
  log.stepEnd(1, 1)
  externalRun(log, writer, {
    status: 'failed',
    started_at: started,
    finished_at: started + 2_000,
    detail:
      'Claude Code 2.1.315 自检不兼容：加载了 MCP server「x」，子智能体不允许使用 MCP。可以在 设置 › 子智能体 退回上一个正常版本，或点「重新检查」。',
    version_failure: VERSION_FAILURE_FIXTURE,
  })
  log.stepStart(1, 2)
  log.stream(1, 2, [
    {
      text: 'Claude Code 这次没能运行：当前版本 2.1.315 不兼容。可以在设置里退回上次正常的 2.1.310。',
    },
  ])
  log.stepEnd(1, 2)
  log.turnEnd(1)
  return {
    id: 'version-failure',
    label: '子智能体（版本不兼容）',
    sessions: [{ id: 'version-failure', events: log.events }],
  }
}
