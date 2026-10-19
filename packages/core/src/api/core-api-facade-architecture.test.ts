import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every non-test TypeScript file under `packages/core/src`. */
function coreSources(): Array<{ path: string; text: string }> {
  const root = new URL('..', import.meta.url).pathname
  const out: Array<{ path: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts'))
        out.push({ path, text: readFileSync(path, 'utf8') })
    }
  }
  walk(root)
  return out
}

/** The source of one method of a class body, from its signature to its closing brace. */
function methodBody(source: string, signature: RegExp): string {
  const start = source.search(signature)
  if (start < 0) return ''
  const open = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return source.slice(start)
}

describe('the session in view is UI state (KRN-01)', () => {
  it('nothing outside activateSession and bootstrap reads it', () => {
    const sources = coreSources()
    // The kernel keeps no focus: no `activeSessionId`, no focus-derived roots.
    const focusReads = sources.flatMap(({ path, text }) =>
      [
        ...text.matchAll(
          /\.(activeSessionId|activeWorkspaceRoot|activeProjectRoot|ensureDefaultSession)\b|\.activeSession\(\)/g,
        ),
      ].map((match) => `${path.split('/src/')[1]}: ${match[0]}`),
    )
    expect(focusReads).toEqual([])

    // CoreApi owns the one field, written by activateSession and read by bootstrap.
    const coreApi = readFileSync(
      new URL('./core-api.ts', import.meta.url),
      'utf8',
    )
    const outside = coreApi
      .replace(methodBody(coreApi, /\n {2}private activateSession\(/), '')
      .replace(methodBody(coreApi, /\n {2}async bootstrap\(/), '')
    expect(coreApi).toMatch(/private focusedSessionId: string \| null/)
    expect(
      outside.match(/focusedSessionId/g) ?? [],
      'focusedSessionId outside activateSession/bootstrap',
    ).toHaveLength(1)
  })
})

describe('CoreApi application facade ownership', () => {
  it('delegates command, session, and workspace use cases without selected-session authority', () => {
    const source = readFileSync(
      new URL('./core-api.ts', import.meta.url),
      'utf8',
    )
    const sessionService = readFileSync(
      new URL('./services/session-application-service.ts', import.meta.url),
      'utf8',
    )
    const workspaceService = readFileSync(
      new URL('./services/workspace-application-service.ts', import.meta.url),
      'utf8',
    )
    const commandService = readFileSync(
      new URL('./services/command-application-service.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('this.commandApplicationService.executeBuiltin')
    expect(source).toContain('this.sessionApplicationService.')
    expect(source).toContain('this.workspaceApplicationService.snapshot')
    expect(source).not.toContain('private async executeBuiltinCommand')
    expect(source).not.toContain('private async executePlanCommand')
    expect(source).not.toContain('private async executeGoalCommand')
    expect(source).not.toContain(
      'this.loop.controlManager.planStore.deleteBySession',
    )
    expect(commandService).not.toContain('activeSessionId')
    expect(commandService).not.toContain('activeSession')
    expect(sessionService).not.toContain('activeSessionId')
    expect(workspaceService).not.toContain('activeSessionId')
    expect(workspaceService).not.toContain('controlManager.planStore')
  })
})
