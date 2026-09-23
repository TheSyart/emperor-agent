import { describe, expect, it } from 'vitest'
import { diffFileStartsOpen, splitPullRequestDiff } from './pullDiff'

describe('splitPullRequestDiff', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' export { a }',
    '@@ -10,2 +11,2 @@',
    ' x',
    '-y',
    '+z',
    'diff --git a/docs/new.md b/docs/new.md',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/docs/new.md',
    '@@ -0,0 +1,2 @@',
    '+# New',
    '+text',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '\\ No newline at end of file',
    'diff --git a/lib/a.ts b/lib/b.ts',
    'similarity index 100%',
    'rename from lib/a.ts',
    'rename to lib/b.ts',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n')

  it('splits files with status, counts and DiffBlock hunks', () => {
    const files = splitPullRequestDiff(diff)
    expect(
      files.map(({ path, oldPath, status, additions, deletions }) => ({
        path,
        oldPath,
        status,
        additions,
        deletions,
      })),
    ).toEqual([
      {
        path: 'src/app.ts',
        oldPath: null,
        status: 'modified',
        additions: 3,
        deletions: 2,
      },
      {
        path: 'docs/new.md',
        oldPath: null,
        status: 'added',
        additions: 2,
        deletions: 0,
      },
      {
        path: 'old.txt',
        oldPath: null,
        status: 'deleted',
        additions: 0,
        deletions: 1,
      },
      {
        path: 'lib/b.ts',
        oldPath: 'lib/a.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
      {
        path: 'logo.png',
        oldPath: null,
        status: 'binary',
        additions: 0,
        deletions: 0,
      },
    ])
    const [app, added, deleted, renamed, binary] = files
    expect(app!.hunks).toEqual([
      {
        path: 'src/app.ts',
        oldText: 'const a = 1\nconst b = 2\nexport { a }\n',
        newText: 'const a = 1\nconst b = 3\nconst c = 4\nexport { a }\n',
      },
      { path: 'src/app.ts', oldText: 'x\ny\n', newText: 'x\nz\n' },
    ])
    expect(added!.hunks).toEqual([
      { path: 'docs/new.md', oldText: '', newText: '# New\ntext\n' },
    ])
    expect(deleted!.hunks).toEqual([
      { path: 'old.txt', oldText: 'gone\n', newText: '' },
    ])
    expect(renamed!.hunks).toEqual([])
    expect(binary!.hunks).toEqual([])
  })

  it('handles an empty or header-less diff', () => {
    expect(splitPullRequestDiff('')).toEqual([])
    expect(splitPullRequestDiff('garbage\n+x')).toEqual([])
  })

  it('opens small files near the top, collapses big / lock / many', () => {
    const [app] = splitPullRequestDiff(diff)
    expect(diffFileStartsOpen(app!, 0)).toBe(true)
    expect(diffFileStartsOpen(app!, 20)).toBe(false)
    expect(diffFileStartsOpen({ ...app!, additions: 500 }, 0)).toBe(false)
    expect(diffFileStartsOpen({ ...app!, path: 'web/pnpm-lock.yaml' }, 0)).toBe(
      false,
    )
    expect(diffFileStartsOpen({ ...app!, hunks: [] }, 0)).toBe(false)
  })
})
