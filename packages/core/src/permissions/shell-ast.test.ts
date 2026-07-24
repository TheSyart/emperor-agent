import { describe, expect, it } from 'vitest'
import {
  analyzeShellCommand,
  analyzeShellCommandFailClosed,
  gitShellExplicitDenyReason,
  isShellAstReadonly,
  isShellAstReadonlySequence,
  shellAstSummary,
  type ShellAstAnalysis,
} from './shell-ast'
import { isHighRiskCommand, isReadonlyCommand } from '../tools/resolvers'

describe('shell AST permission analysis', () => {
  it('resolves quoted word fragments into a trustworthy simple argv', () => {
    const analysis = analyzeShellCommand(`g'i't "sta"tus --short`)

    expect(analysis).toMatchObject({
      version: 1,
      status: 'parsed',
      features: [],
      commands: [{ argv: ['git', 'status', '--short'], redirects: [] }],
    })
    expect(isShellAstReadonly(analysis)).toBe(true)
  })

  it.each([
    ['pipeline', 'git status | tee status.txt', 'pipeline'],
    ['and-list', 'git status && rm -rf /', 'and'],
    ['redirection', 'git status 2>status.err', 'redirection'],
    ['heredoc', 'git status <<EOF\nvalue\nEOF', 'heredoc'],
    ['subshell', '(git status)', 'subshell'],
  ])(
    'recognizes %s structure and never calls it read-only',
    (_, command, feature) => {
      const analysis = analyzeShellCommand(command)

      expect(analysis.features).toContain(feature)
      expect(isShellAstReadonly(analysis)).toBe(false)
    },
  )

  it('recursively exposes command substitution without trusting the outer argv', () => {
    const analysis = analyzeShellCommand('echo "$(git push origin main)"')

    expect(analysis.features).toContain('command_substitution')
    expect(analysis.commands.map((command) => command.argv)).toEqual([
      ['echo', '__SHELL_DYNAMIC__'],
      ['git', 'push', 'origin', 'main'],
    ])
    expect(isShellAstReadonly(analysis)).toBe(false)
  })

  it('keeps substitution-looking text inside single quotes literal', () => {
    const analysis = analyzeShellCommand("git status '$(rm -rf /)'")

    expect(analysis.features).not.toContain('command_substitution')
    expect(analysis.commands[0]?.argv).toEqual(['git', 'status', '$(rm -rf /)'])
    expect(isShellAstReadonly(analysis)).toBe(true)
  })

  it.each([
    ['unclosed quote', `git 'status`, 'unclosed_quote'],
    ['unicode whitespace', 'git\u00a0status', 'unicode_whitespace'],
    ['parameter expansion', 'git "$COMMAND"', 'dynamic_expansion'],
    [
      'process substitution',
      'git status <(cat secret)',
      'process_substitution',
    ],
    ['UNC path', String.raw`ls \\server\share`, 'outside_path_argument'],
    ['parent traversal', 'ls ../private', 'outside_path_argument'],
  ])('fails closed for %s', (_, command, reasonCode) => {
    const analysis = analyzeShellCommand(command)

    expect(isShellAstReadonly(analysis)).toBe(false)
    expect(analysis.reasonCodes).toContain(reasonCode)
  })

  it('returns a deterministic redacted summary without command text or argv', () => {
    const first = shellAstSummary(
      analyzeShellCommand('git status && rm -rf /private-name'),
    )
    const second = shellAstSummary(
      analyzeShellCommand('git status && rm -rf /private-name'),
    )

    expect(second).toEqual(first)
    expect(second.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(second)).not.toContain('private-name')
    expect(JSON.stringify(second)).not.toContain('rm')
  })

  it('rejects node-budget overflow and malformed parser adapter results', () => {
    const tooLarge = analyzeShellCommand(
      `git status ${Array.from({ length: 600 }, (_, index) => `path-${index}`).join(' ')}`,
    )
    const malformed = analyzeShellCommandFailClosed(
      'git status',
      () => ({}) as ShellAstAnalysis,
    )

    expect(tooLarge).toMatchObject({
      status: 'too_complex',
      reasonCodes: expect.arrayContaining(['ast_node_limit']),
    })
    expect(isShellAstReadonly(tooLarge)).toBe(false)
    expect(malformed).toMatchObject({
      status: 'invalid',
      reasonCodes: ['parser_invalid_result'],
    })
    expect(isShellAstReadonly(malformed)).toBe(false)
  })
})

describe('AST-backed command risk corpus', () => {
  it.each([
    `g'i't pu'sh' origin main`,
    `echo "$(git push origin main)"`,
    'git status | rm -rf /',
    `rm '-r''f' /tmp/value`,
    `npm pu'blish'`,
  ])('finds dangerous commands after shell parsing: %s', (command) => {
    expect(isHighRiskCommand(command)).toBe(true)
  })

  it.each([
    'git status > status.txt',
    'git status | tee status.txt',
    'git status && pwd',
    'git branch feature/new',
    'git branch -D old',
    'git diff --output=result.patch',
    'git diff --ext-diff',
    'git status --help',
    'git -c core.pager=evil status',
    'ls linked-outside',
    'ls ../outside',
    String.raw`ls \\server\share`,
  ])(
    'does not promote structurally or semantically unsafe reads: %s',
    (command) => {
      expect(isReadonlyCommand(command)).toBe(false)
    },
  )

  it.each([
    `g'i't "sta"tus --short`,
    'git --no-pager status --porcelain=v2',
    'git branch --list feature/*',
    'ls -la',
    'pwd -P',
  ])('keeps a narrow positively-proven read-only subset: %s', (command) => {
    expect(isReadonlyCommand(command)).toBe(true)
  })
})

describe('Git command security matrix', () => {
  it.each([
    ['git push --force origin main', 'force_push'],
    ['git reset --hard HEAD~1', 'history_rewrite'],
    ['git commit --amend --no-edit', 'history_rewrite'],
    ['git commit --no-verify -m unsafe', 'hooks_bypass'],
    ['git -c alias.status=!rm status', 'dynamic_config'],
    ['git --git-dir=.git status', 'repository_override'],
    ['git diff --ext-diff', 'external_diff'],
    ['git update-ref refs/heads/main HEAD', 'git_internal_write'],
  ])('hard-denies %s as %s', (command, reason) => {
    expect(
      gitShellExplicitDenyReason(analyzeShellCommand(command), {
        workspaceRoot: process.cwd(),
        cwd: process.cwd(),
      }),
    ).toBe(reason)
  })

  it('allows only contained -C and --no-index read paths', () => {
    const context = { workspaceRoot: process.cwd(), cwd: process.cwd() }
    expect(
      isShellAstReadonlySequence(
        analyzeShellCommand('git -C . status --short'),
        context,
      ),
    ).toBe(true)
    expect(
      isShellAstReadonlySequence(
        analyzeShellCommand('git diff --no-index package.json src/index.ts'),
        context,
      ),
    ).toBe(true)
    expect(
      gitShellExplicitDenyReason(
        analyzeShellCommand('git -C /tmp status'),
        context,
      ),
    ).toBe('repository_override')
    expect(
      gitShellExplicitDenyReason(
        analyzeShellCommand('git diff --no-index package.json /etc/passwd'),
        context,
      ),
    ).toBe('no_index_containment')
  })
})
