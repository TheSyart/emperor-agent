// The commit a packaged smoke receipt names (EMPEROR_BUILD_COMMIT), read
// from the files git keeps, without running git. Works in a plain checkout
// (.git is a folder) and in a worktree (.git is a file naming its git dir,
// whose commondir holds the refs); 'local' when there is no commit to name.
const { existsSync, readFileSync, statSync } = require('node:fs')
const { isAbsolute, join, resolve } = require('node:path')

const COMMIT = /^[a-f0-9]{40}$/i

function gitDirs(root) {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit)) return null
  if (statSync(dotGit).isDirectory()) return { gitDir: dotGit, common: dotGit }
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
  if (!pointer) return null
  const gitDir = resolve(root, pointer[1].trim())
  const commonFile = join(gitDir, 'commondir')
  if (!existsSync(commonFile)) return { gitDir, common: gitDir }
  const relative = readFileSync(commonFile, 'utf8').trim()
  return {
    gitDir,
    common: isAbsolute(relative) ? relative : resolve(gitDir, relative),
  }
}

function readRef(dirs, ref) {
  for (const dir of [dirs.gitDir, dirs.common]) {
    const loose = join(dir, ...ref.split('/'))
    if (existsSync(loose)) {
      const value = readFileSync(loose, 'utf8').trim()
      if (COMMIT.test(value)) return value.toLowerCase()
    }
  }
  const packedFile = join(dirs.common, 'packed-refs')
  if (!existsSync(packedFile)) return null
  const line = readFileSync(packedFile, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.endsWith(` ${ref}`))
  const value = line?.split(' ')[0] || ''
  return COMMIT.test(value) ? value.toLowerCase() : null
}

function readGitCommit(root) {
  try {
    const dirs = gitDirs(root)
    if (!dirs) return 'local'
    const head = readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8').trim()
    if (COMMIT.test(head)) return head.toLowerCase()
    if (!head.startsWith('ref: ')) return 'local'
    return readRef(dirs, head.slice(5).trim()) || 'local'
  } catch {
    return 'local'
  }
}

module.exports = { readGitCommit }
