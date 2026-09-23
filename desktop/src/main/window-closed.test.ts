import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

/** Bodies of every `.on('closed', () => { … })` handler in index.ts. */
function closedHandlerBodies(source: string): string[] {
  const bodies: string[] = []
  const opener = /\.on\('closed',\s*\(\)\s*=>\s*\{/g
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1
    let index = opener.lastIndex
    while (depth > 0 && index < source.length) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    bodies.push(source.slice(opener.lastIndex, index - 1))
  }
  return bodies
}

describe('window closed handlers', () => {
  it('never read webContents from a window Electron already destroyed', () => {
    // By 'closed' the BrowserWindow is destroyed: `win.webContents` throws
    // "Object has been destroyed", which surfaced as an Uncaught Exception
    // dialog every time the app was closed. Capture the reference earlier.
    const bodies = closedHandlerBodies(mainSource)
    expect(bodies.length).toBeGreaterThanOrEqual(3)
    for (const body of bodies) expect(body).not.toMatch(/\.webContents\b/)
  })
})
