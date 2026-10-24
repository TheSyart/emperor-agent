import { describe, expect, it } from 'vitest'
import type {
  ExecutorUpgradeView,
  ExecutorVersionView,
  ExecutorVersionsView,
} from '@emperor/core/runtime-contract'
import {
  attentionNeeded,
  checkedText,
  confirmContent,
  failedRun,
  failureContent,
  installText,
  noticeContent,
  rollbackAction,
  rollbackContent,
  rollbackOffered,
  rowUpgradeLine,
  runBadge,
  runningLine,
} from './upgradeText'

// AGT-13: what 设置 › 子智能体 says about versions and 升级, word for word
// from the approved design (executor-upgrade.html).

const NOW = Date.UTC(2026, 9, 22, 8, 0, 0)

function claude(over: Partial<ExecutorVersionView> = {}): ExecutorVersionView {
  return {
    profileId: 'claude-default',
    backend: 'claude-code',
    enabled: true,
    installed: '2.1.281',
    install: {
      kind: 'npm',
      location: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code',
    },
    latest: '2.1.308',
    verified: [],
    target: '2.1.308',
    unverified: null,
    upgrade: {
      oneClick: true,
      command: 'npm install -g @anthropic-ai/claude-code@2.1.308',
    },
    activeRuns: 0,
    ...over,
  }
}
function codex(over: Partial<ExecutorVersionView> = {}): ExecutorVersionView {
  return {
    profileId: 'codex-default',
    backend: 'codex',
    enabled: true,
    installed: '0.153.4',
    install: {
      kind: 'npm',
      location: '/opt/homebrew/lib/node_modules/@openai/codex',
    },
    latest: '0.163.0',
    verified: ['0.153', '0.163'],
    target: '0.163.0',
    unverified: null,
    upgrade: {
      oneClick: true,
      command: 'npm install -g @openai/codex@0.163.0',
    },
    activeRuns: 1,
    ...over,
  }
}
function run(over: Partial<ExecutorUpgradeView> = {}): ExecutorUpgradeView {
  return {
    profileId: 'codex-default',
    backend: 'codex',
    from: '0.153.4',
    target: '0.163.0',
    command: 'npm install -g @openai/codex@0.163.0',
    state: 'running',
    startedAt: NOW - 12_000,
    log: ['$ npm install -g @openai/codex@0.163.0'],
    ...over,
  }
}
function versions(
  executors: ExecutorVersionView[],
  over: Partial<ExecutorVersionsView> = {},
): ExecutorVersionsView {
  return {
    checkedAt: NOW - 10 * 60_000,
    checking: false,
    error: null,
    executors,
    upgrades: [],
    dismissed: false,
    ...over,
  }
}

describe('row', () => {
  it('本机 x · 可升级到 y, with the offer highlighted', () => {
    expect(rowUpgradeLine('已登录 Claude 账号', claude(), null, NOW)).toEqual({
      text: '已登录 Claude 账号 · 本机 2.1.281',
      highlight: '可升级到 2.1.308',
    })
  })

  it('already the latest, or the latest Emperor verified', () => {
    expect(
      rowUpgradeLine(
        '已登录 Claude 账号',
        claude({ installed: '2.1.308', target: null, upgrade: null }),
        null,
        NOW,
      ),
    ).toEqual({ text: '已登录 Claude 账号 · 本机 2.1.308 · 已是最新' })
    expect(
      rowUpgradeLine(
        '沿用你的配置',
        codex({
          target: null,
          upgrade: null,
          unverified: '0.163.0',
          verified: ['0.153'],
        }),
        null,
        NOW,
      ),
    ).toEqual({
      text: '沿用你的配置 · 本机 0.153.4 · 已是验证过的最新版 · 0.163.0 尚未验证',
    })
  })

  it('a desktop app’s copy updates with the app; unknown latest says nothing', () => {
    expect(
      rowUpgradeLine(
        'B',
        codex({
          install: { kind: 'desktop', location: '/Applications/Codex.app' },
          upgrade: { oneClick: false, command: null, manual: 'desktop' },
        }),
        null,
        NOW,
      ),
    ).toEqual({ text: 'B · 本机 0.153.4 · 0.163.0 随桌面版更新' })
    expect(
      rowUpgradeLine(
        'A',
        claude({ latest: null, target: null, upgrade: null }),
        null,
        NOW,
      ),
    ).toEqual({ text: 'A · 本机 2.1.281' })
  })

  it('just upgraded, or an upgrade that did not finish', () => {
    expect(
      rowUpgradeLine(
        'B',
        codex({ installed: '0.163.0', target: null, upgrade: null }),
        run({
          state: 'succeeded',
          installed: '0.163.0',
          finishedAt: NOW - 5_000,
        }),
        NOW,
      ),
    ).toEqual({ text: 'B · 本机 0.163.0 · 已是最新 · 刚刚升级' })
    expect(
      rowUpgradeLine(
        'B',
        codex(),
        run({ state: 'failed', reason: 'permission', finishedAt: NOW }),
        NOW,
      ),
    ).toEqual({ text: 'B · 本机 0.153.4 · 升级没有完成' })
  })

  it('while it runs: waiting, queued, then the time it has taken', () => {
    expect(runningLine(run({ state: 'waiting', waitingFor: 1 }), NOW)).toBe(
      '等 1 个子任务结束后升级到 0.163.0…',
    )
    expect(runningLine(run({ state: 'waiting', queued: true }), NOW)).toBe(
      '等另一个升级完成后升级到 0.163.0…',
    )
    expect(runningLine(run({ state: 'waiting' }), NOW)).toBe(
      '正在准备升级到 0.163.0…',
    )
    expect(runningLine(run(), NOW)).toBe('正在升级到 0.163.0… 已用 12 秒')
    expect(runningLine(run({ startedAt: NOW - 75_000 }), NOW)).toBe(
      '正在升级到 0.163.0… 已用 1 分 15 秒',
    )
  })
})

describe('top notice', () => {
  it('both have a new version: 全部升级', () => {
    expect(noticeContent(versions([claude(), codex()]))).toEqual({
      title: 'Claude Code 和 Codex 有新版本',
      body: 'Claude Code 2.1.281 → 2.1.308；Codex 0.153.4 → 0.163.0。用你安装它们时的方式（npm 全局安装）升级，不改动登录和设置。',
      action: '全部升级',
      profileIds: ['claude-default', 'codex-default'],
    })
  })

  it('Codex 0.163 not verified yet: only Claude Code is offered', () => {
    expect(
      noticeContent(
        versions([
          claude(),
          codex({
            target: null,
            upgrade: null,
            unverified: '0.163.0',
            verified: ['0.153'],
          }),
        ]),
      ),
    ).toEqual({
      title: 'Claude Code 有新版本',
      body: 'Claude Code 2.1.281 → 2.1.308。Codex 0.163.0 已发布，但 Emperor 还没验证，暂不升级。',
      action: '升级 Claude Code',
      profileIds: ['claude-default'],
    })
  })

  it('one executor, another install method; nothing for 稍后, a run, or one that is off', () => {
    expect(
      noticeContent(
        versions([
          claude({
            install: { kind: 'claude-native', location: null },
            upgrade: { oneClick: true, command: 'claude install 2.1.308' },
          }),
          codex({ target: null, upgrade: null, latest: '0.153.4' }),
        ]),
      ),
    ).toEqual({
      title: 'Claude Code 有新版本',
      body: 'Claude Code 2.1.281 → 2.1.308。用你安装它时的方式（Claude 官方安装器）升级，不改动登录和设置。',
      action: '升级 Claude Code',
      profileIds: ['claude-default'],
    })
    expect(
      noticeContent(versions([claude(), codex()], { dismissed: true })),
    ).toBeNull()
    expect(
      noticeContent(versions([claude(), codex()], { upgrades: [run()] })),
    ).toBeNull()
    expect(
      noticeContent(
        versions([claude({ enabled: false }), codex({ enabled: false })]),
      ),
    ).toBeNull()
    // A command to copy is not one click: the row offers it, the notice does not.
    expect(
      noticeContent(
        versions([
          claude({
            upgrade: {
              oneClick: false,
              command: 'claude update',
              manual: 'unknown',
            },
          }),
        ]),
      ),
    ).toBeNull()
  })
})

describe('confirmation', () => {
  it('Codex: the command and what it leaves alone; its running subtask finishes first', () => {
    expect(confirmContent([codex()])).toEqual({
      title: '升级 Codex 到 0.163.0？',
      lead: 'Emperor 会用你当初安装它的方式升级，运行：',
      commands: ['npm install -g @openai/codex@0.163.0'],
      points: [
        '不改动你的 Codex 登录和设置（~/.codex），Codex 桌面版不受影响',
        '升级期间不派新的 Codex 子任务；正在运行的 1 个会先跑完',
        '升级后 Emperor 会重新检测，失败时可以按提示自己在终端里装回去',
      ],
      action: '升级',
    })
  })

  it('Claude Code', () => {
    expect(confirmContent([claude()])).toEqual({
      title: '升级 Claude Code 到 2.1.308？',
      lead: 'Emperor 会用你当初安装它的方式升级，运行：',
      commands: ['npm install -g @anthropic-ai/claude-code@2.1.308'],
      points: [
        '不改动你的 Claude 登录和设置；Emperor 那份专用登录也保留',
        '升级期间不派新的 Claude Code 子任务',
        '升级后 Emperor 会重新检测它的能力',
      ],
      action: '升级',
    })
  })

  it('全部升级: both, one after the other', () => {
    expect(confirmContent([claude(), codex()])).toEqual({
      title: '升级 Claude Code 和 Codex？',
      lead: 'Emperor 会用你当初安装它们的方式依次升级，运行：',
      commands: [
        'npm install -g @anthropic-ai/claude-code@2.1.308',
        'npm install -g @openai/codex@0.163.0',
      ],
      points: [
        '不改动你的 Claude、Codex 登录和设置（包括 ~/.codex 和 Emperor 那份专用登录），Codex 桌面版不受影响',
        '升级期间不派新的子任务；正在运行的 1 个会先跑完',
        '升级后 Emperor 会重新检测，失败时可以按提示自己在终端里装回去',
      ],
      action: '全部升级',
    })
  })

  it('a command to copy instead of one click', () => {
    expect(
      confirmContent([
        claude({
          install: { kind: 'unknown', location: '/usr/local/bin/claude' },
          upgrade: {
            oneClick: false,
            command: 'claude update',
            manual: 'unknown',
          },
        }),
      ]),
    ).toEqual({
      title: '升级 Claude Code 到 2.1.308',
      lead: 'Emperor 认不出 Claude Code 的安装方式，不能替你升级。在终端里运行下面这条命令，完成后点「重新检测」：',
      commands: ['claude update'],
      points: [],
      action: null,
    })
    expect(
      confirmContent([
        codex({
          install: { kind: 'homebrew', location: '/opt/homebrew/Cellar/codex' },
          upgrade: {
            oneClick: false,
            command: 'brew upgrade codex',
            manual: 'homebrew',
          },
        }),
      ]).lead,
    ).toBe(
      'Homebrew 现在提供的不是 0.163.0，Emperor 不替你升级。在终端里先运行 brew update，再运行下面这条命令，完成后点「重新检测」：',
    )
  })
})

describe('failure', () => {
  const failed = (over: Partial<ExecutorUpgradeView>) =>
    run({
      state: 'failed',
      finishedAt: NOW,
      manualCommand: 'npm install -g @openai/codex@0.163.0',
      ...over,
    })

  it('no write permission: the folder, no admin rights, the command to run', () => {
    expect(
      failureContent(
        failed({
          reason: 'permission',
          path: '/opt/homebrew/lib/node_modules',
          exitCode: 243,
        }),
      ),
    ).toEqual({
      title: 'Codex 升级失败：没有写入 /opt/homebrew/lib/node_modules 的权限',
      body: 'Emperor 不会用管理员权限运行。你可以在终端里自己运行下面这条命令，完成后点「重新检测」：',
      command: 'npm install -g @openai/codex@0.163.0',
    })
  })

  it('network, time limit, start, exit code, and a version that did not change', () => {
    const body = '你可以在终端里自己运行下面这条命令，完成后点「重新检测」：'
    expect(failureContent(failed({ reason: 'network' }))).toMatchObject({
      title: 'Codex 升级失败：连不上网络，没有下载到新版本',
      body,
    })
    expect(failureContent(failed({ reason: 'timeout' })).title).toBe(
      'Codex 升级失败：10 分钟没有完成，已停止',
    )
    expect(failureContent(failed({ reason: 'start' })).title).toBe(
      'Codex 升级失败：升级命令没能启动',
    )
    expect(
      failureContent(failed({ reason: 'exit', exitCode: 1 })),
    ).toMatchObject({
      title: 'Codex 升级失败：命令以退出码 1 结束',
      body: '可以点「查看过程」看命令输出；也可以在终端里自己运行下面这条命令，完成后点「重新检测」：',
    })
    expect(
      failureContent(failed({ reason: 'not-upgraded', installed: '0.153.4' }))
        .title,
    ).toBe('Codex 升级失败：命令已结束，但重新检测到的仍是 0.153.4')
  })

  it('stays until the version is there (the user ran the command) or it is tried again', () => {
    const f = failed({ reason: 'permission' })
    expect(failedRun(codex(), f)).toBe(f)
    expect(failedRun(codex({ installed: '0.163.0' }), f)).toBeNull()
    expect(failedRun(codex(), run())).toBeNull()
    expect(failedRun(codex(), null)).toBeNull()
  })
})

describe('detail and nav', () => {
  it('安装方式 in words', () => {
    expect(installText(claude())).toBe('npm 全局安装')
    expect(
      installText(codex({ install: { kind: 'homebrew', location: null } })),
    ).toBe('Homebrew')
    expect(
      installText(
        claude({ install: { kind: 'claude-native', location: null } }),
      ),
    ).toBe('Claude 官方安装器')
    expect(
      installText(codex({ install: { kind: 'desktop', location: null } })),
    ).toBe('Codex 桌面版自带')
    expect(
      installText(codex({ install: { kind: 'unknown', location: null } })),
    ).toBe('认不出安装方式')
  })

  it('when it last checked, and that it reads only public version numbers', () => {
    expect(checkedText(versions([]), NOW)).toBe(
      '10 分钟前检查过 · 只读取公开的版本号',
    )
    expect(checkedText(versions([], { checkedAt: NOW - 20_000 }), NOW)).toBe(
      '刚刚检查过 · 只读取公开的版本号',
    )
    expect(checkedText(versions([], { checkedAt: null }), NOW)).toBe(
      '还没有检查过 · 只读取公开的版本号',
    )
    expect(
      checkedText(
        versions([], { checkedAt: NOW - 3 * 3600_000, error: 'offline' }),
        NOW,
      ),
    ).toBe('这次没有连上 npm · 3 小时前检查过')
    expect(checkedText(versions([], { checking: true }), NOW)).toBe('正在检查…')
  })

  it('the dot on 子智能体: a new version not put off, or a failed upgrade', () => {
    expect(attentionNeeded(versions([claude()]))).toBe(true)
    expect(attentionNeeded(versions([claude()], { dismissed: true }))).toBe(
      false,
    )
    expect(
      attentionNeeded(
        versions([codex({ target: null, upgrade: null })], {
          dismissed: true,
          upgrades: [run({ state: 'failed', reason: 'network' })],
        }),
      ),
    ).toBe(true)
    expect(attentionNeeded(null)).toBe(false)
  })
})

describe('退回 (VER-03)', () => {
  const offer = {
    target: '2.1.310',
    because: '2.1.315 上有 2 次任务因版本不兼容失败',
    oneClick: true,
    command: 'npm install -g @anthropic-ai/claude-code@2.1.310',
  }
  const broken = (over: Partial<ExecutorVersionView> = {}) =>
    claude({
      installed: '2.1.315',
      latest: '2.1.315',
      target: null,
      upgrade: null,
      rollback: offer,
      ...over,
    })
  const back = (over: Partial<ExecutorUpgradeView> = {}) =>
    run({
      profileId: 'claude-default',
      backend: 'claude-code',
      kind: 'rollback',
      from: '2.1.315',
      target: '2.1.310',
      command: offer.command,
      ...over,
    })

  it('the button under 本机版本, or why there is none', () => {
    expect(rollbackOffered(broken(), null)).toBe(true)
    expect(rollbackAction(broken())).toEqual({
      label: '退回 2.1.310（上次正常）',
      note: null,
    })
    // While it (or an upgrade) runs, and for an executor that is off: no.
    expect(rollbackOffered(broken(), back())).toBe(false)
    expect(rollbackOffered(broken({ enabled: false }), null)).toBe(false)
    expect(rollbackOffered(claude(), null)).toBe(false)
    // Homebrew still has the button: it opens the command to copy.
    expect(
      rollbackAction(
        broken({ rollback: { ...offer, oneClick: false, manual: 'homebrew' } }),
      ).label,
    ).toBe('退回 2.1.310（上次正常）')
    // A desktop app's copy goes with the app.
    expect(
      rollbackAction(
        codex({
          rollback: {
            target: '0.153.4',
            because: '0.163.0 上有 1 次任务因版本不兼容失败',
            oneClick: false,
            command: null,
            manual: 'desktop',
          },
        }),
      ),
    ).toEqual({ label: null, note: 'Codex 随桌面版更新，不能在这里退回。' })
  })

  it('11 · the confirmation: why, the command, and for Claude Code the auto-update note', () => {
    expect(rollbackContent(broken())).toEqual({
      title: '退回 Claude Code 2.1.310？',
      lead: '2.1.315 上有 2 次任务因版本不兼容失败。退回会用你安装 Claude Code 的同一方式运行：',
      commands: ['npm install -g @anthropic-ai/claude-code@2.1.310'],
      points: [],
      note: {
        before:
          '你在终端里直接用 claude 时，它可能自动更新回新版本；需要时可在 shell 配置里加 ',
        code: 'export DISABLE_AUTOUPDATER=1',
        after: '。',
      },
      action: '退回',
    })
    const codexBack = rollbackContent(
      codex({
        installed: '0.163.0',
        target: null,
        upgrade: null,
        rollback: {
          target: '0.153.4',
          because: '0.163.0 上有 1 次任务因版本不兼容失败',
          oneClick: true,
          command: 'npm install -g @openai/codex@0.153.4',
        },
      }),
    )
    expect(codexBack).toMatchObject({
      title: '退回 Codex 0.153.4？',
      lead: '0.163.0 上有 1 次任务因版本不兼容失败。退回会用你安装 Codex 的同一方式运行：',
      action: '退回',
    })
    // Codex does not update itself: no such note.
    expect(codexBack.note).toBeNull()
  })

  it('Homebrew or an unknown install: the npm command to run, no one click', () => {
    const brew = rollbackContent(
      broken({
        install: {
          kind: 'homebrew',
          location: '/opt/homebrew/Caskroom/claude-code',
        },
        rollback: { ...offer, oneClick: false, manual: 'homebrew' },
      }),
    )
    expect(brew).toMatchObject({
      title: '退回 Claude Code 到 2.1.310',
      lead: '2.1.315 上有 2 次任务因版本不兼容失败。Homebrew 装不了旧版本，Emperor 不替你退回。在终端里运行下面这条命令（会另装一份，PATH 里靠前的那份生效），完成后点「重新检测」：',
      commands: ['npm install -g @anthropic-ai/claude-code@2.1.310'],
      action: null,
    })
    expect(brew.note).not.toBeNull()
    expect(
      rollbackContent(
        broken({ rollback: { ...offer, oneClick: false, manual: 'unknown' } }),
      ).lead,
    ).toBe(
      '2.1.315 上有 2 次任务因版本不兼容失败。Emperor 认不出 Claude Code 的安装方式，不能替你退回。在终端里运行下面这条命令，完成后点「重新检测」：',
    )
  })

  it('progress and results say 退回, not 升级', () => {
    expect(runBadge(back())).toBe('退回中')
    expect(runBadge(run())).toBe('升级中')
    expect(runningLine(back(), NOW)).toBe('正在退回到 2.1.310… 已用 12 秒')
    expect(runningLine(back({ state: 'waiting', waitingFor: 1 }), NOW)).toBe(
      '等 1 个子任务结束后退回到 2.1.310…',
    )
    expect(runningLine(back({ state: 'waiting' }), NOW)).toBe(
      '正在准备退回到 2.1.310…',
    )
    const failed = back({
      state: 'failed',
      reason: 'network',
      manualCommand: offer.command,
      finishedAt: NOW,
    })
    expect(failureContent(failed).title).toBe(
      'Claude Code 退回失败：连不上网络，没有下载到 2.1.310',
    )
    expect(failureContent({ ...failed, reason: 'start' }).title).toBe(
      'Claude Code 退回失败：退回命令没能启动',
    )
    expect(rowUpgradeLine('', broken(), failed, NOW).text).toBe(
      '本机 2.1.315 · 退回没有完成',
    )
  })

  it('back on the last good version: 刚刚退回, and the version it left is not offered', () => {
    const after = claude({
      installed: '2.1.310',
      latest: '2.1.315',
      target: null,
      upgrade: null,
    })
    const done = back({
      state: 'succeeded',
      installed: '2.1.310',
      finishedAt: NOW - 60_000,
    })
    expect(rowUpgradeLine('', after, done, NOW).text).toBe(
      '本机 2.1.310 · 已从 2.1.315 退回，暂不升级 · 刚刚退回',
    )
    expect(rowUpgradeLine('', after, null, NOW).text).toBe(
      '本机 2.1.310 · 已从 2.1.315 退回，暂不升级',
    )
    // Core skips the version it left: nothing to offer, no notice, no dot.
    const view = versions(
      [after, codex({ target: null, upgrade: null, latest: '0.153.4' })],
      {
        upgrades: [done],
      },
    )
    expect(noticeContent(view)).toBeNull()
    expect(attentionNeeded(view)).toBe(false)
    // A newer release later is offered as usual.
    expect(
      noticeContent(
        versions([
          claude({
            installed: '2.1.310',
            latest: '2.1.318',
            target: '2.1.318',
            upgrade: {
              oneClick: true,
              command: 'npm install -g @anthropic-ai/claude-code@2.1.318',
            },
          }),
        ]),
      )?.title,
    ).toBe('Claude Code 有新版本')
  })
})
