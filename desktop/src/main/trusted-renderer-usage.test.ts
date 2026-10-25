import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
const rendererRoot = resolve(__dirname, '../renderer/src')

function rendererSources(dir: string = rendererRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return rendererSources(path)
    if (!/\.(?:ts|tsx|js|mjs|vue)$/.test(entry.name)) return []
    if (/\.(?:test|spec)\.[a-z]+$/.test(entry.name)) return []
    return [relative(rendererRoot, path).split(sep).join('/')]
  })
}

describe('trusted renderer policy wiring', () => {
  it('reads ELECTRON_RENDERER_URL only through the packaged-aware helper (SEC-04)', () => {
    expect(source).not.toContain('process.env.ELECTRON_RENDERER_URL')
    expect(source).toMatch(
      /developmentUrl: developmentRendererUrl\(\{\s*isPackaged: app\.isPackaged,/,
    )
    expect(source).toMatch(
      /mainWindow\.loadURL\(\s*mainRendererUrl\(\{ isPackaged: app\.isPackaged, env: process\.env \}\),?\s*\)/,
    )
  })

  it('guards navigation, redirects, frames and popups', () => {
    expect(source).toContain("contents.on('will-navigate'")
    expect(source).toContain("contents.on('will-frame-navigate'")
    expect(source).toContain("contents.on('will-redirect'")
    expect(source).toContain('contents.setWindowOpenHandler')
  })

  it('authorizes Core IPC and every desktop channel, named by contract constants', () => {
    expect(source).toContain('authorizeIpc: (event) =>')
    // No channel name is a string literal in main (MAIN-27).
    expect(source).not.toMatch(/ipcMain\.(?:handle|on)\('emperor:/)

    for (const channel of [
      'SELECT_DIRECTORY_CHANNEL',
      'PET_OPEN_CHANNEL',
      'PET_CLOSE_CHANNEL',
      'PET_STATUS_REQUEST_CHANNEL',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `ipcMain\\.handle\\(${channel},[\\s\\S]{0,180}trustedRendererPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )
    }
    for (const register of [
      'registerOpenPathIpc',
      'registerRemoteImageIpc',
      'registerScreenshotIpc',
      // REL-05: the renderer's app version comes from app.getVersion().
      'registerAppVersionIpc',
      // BUG-05: 「用默认应用打开」 for a granted video.
      'registerWorkspaceMediaIpc',
    ])
      expect(source).toMatch(
        new RegExp(
          `${register}\\(\\{\\s*ipcMain,\\s*authorize: \\(event\\) => trustedRendererPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )

    for (const channel of [
      'PET_RENDERER_BOOTSTRAP_CHANNEL',
      'PET_RENDERER_CLOSE_CHANNEL',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `ipcMain\\.handle\\(${channel},[\\s\\S]{0,220}trustedPetPolicy\\.authorizeIpc\\(event\\)`,
        ),
      )
    }
  })
})

/**
 * Why a Vue SFC's `openBrowserUrl(` calls are not all explicit user submits,
 * or null when they are: each call must sit in a top-level function that the
 * script never calls itself and the template only binds to DOM events
 * (`@submit`, `@keydown.enter`, `@click`), so no watch, mount hook or prop
 * can open a URL on its own.
 */
function browserOpenViolation(sfc: string): string | null {
  const script = (/<script[^>]*>([\s\S]*?)<\/script>/.exec(sfc)?.[1] ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const template = (
    /<template>([\s\S]*)<\/template>/.exec(sfc)?.[1] ?? ''
  ).replace(/<!--[\s\S]*?-->/g, '')
  if (/\bopenBrowserUrl\b/.test(template))
    return 'the template calls openBrowserUrl directly'
  const calls = [...script.matchAll(/\bopenBrowserUrl\s*\(/g)]
  if (!calls.length) return null
  for (const call of calls) {
    const before = script.slice(0, call.index)
    const declarations = [
      ...before.matchAll(
        /^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
      ),
    ]
    const declaration = declarations.at(-1)
    if (!declaration) return 'openBrowserUrl is called at the top level'
    const name = declaration[1] ?? declaration[2] ?? ''
    // Any other top-level statement after the declaration ends its body.
    const body = script.slice(
      declaration.index! + declaration[0].length,
      call.index,
    )
    if (
      body
        .split('\n')
        .slice(1)
        .some((line) => /^[^\s)]/.test(line))
    )
      return 'openBrowserUrl is called outside a top-level submit handler'
    const scriptUses = script.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []
    if (scriptUses.length !== 1)
      return `${name} is also called from the script (watch, hook or helper)`
    const templateUses = template.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []
    const eventUses =
      template.match(
        new RegExp(`(?:@|v-on:)[\\w.-]+="[^"]*\\b${name}\\b[^"]*"`, 'g'),
      ) ?? []
    if (!templateUses.length || templateUses.length !== eventUses.length)
      return `${name} must be bound only to template DOM events`
  }
  return null
}

describe('embedded browser trust boundary', () => {
  it('lets only the BrowserPane address bar open URLs in the embedded browser', () => {
    // Markdown links, tool output and model text must never reach the browser
    // view: openBrowserUrl is reserved for an explicit address-bar submit.
    const callers = rendererSources().filter((file) =>
      readFileSync(join(rendererRoot, file), 'utf8').includes('openBrowserUrl'),
    )
    expect(callers).toContain('api/backend.ts')
    expect(callers.filter((file) => file !== 'api/backend.ts')).toEqual(
      callers.includes('components/workspace/BrowserPane.vue')
        ? ['components/workspace/BrowserPane.vue']
        : [],
    )
    const pane = readFileSync(
      join(rendererRoot, 'components/workspace/BrowserPane.vue'),
      'utf8',
    )
    expect(browserOpenViolation(pane)).toBeNull()
  })

  it('recognizes address-bar submits and rejects automatic opens', () => {
    const submit = `<script setup lang="ts">
import { openBrowserUrl } from '../../api/backend'
const address = ref(props.url ?? '')
async function submitAddress(
  event?: Event,
): Promise<void> {
  const result = await openBrowserUrl(address.value)
  if (!result.ok) error.value = result.error ?? ''
}
</script>
<template>
  <form @submit.prevent="submitAddress"><input v-model="address" /></form>
</template>`
    expect(browserOpenViolation(submit)).toBeNull()
    expect(
      browserOpenViolation(
        submit.replace(
          '</script>',
          'watch(() => props.url, () => submitAddress())\n</script>',
        ),
      ),
    ).toMatch(/also called/)
    expect(
      browserOpenViolation(
        submit.replace(
          '</script>',
          'watch(() => props.url, (url) => openBrowserUrl(url))\n</script>',
        ),
      ),
    ).toMatch(/outside/)
    expect(
      browserOpenViolation(
        submit.replace(
          '</script>',
          'onMounted(() => {\n  void openBrowserUrl(address.value)\n})\n</script>',
        ),
      ),
    ).toMatch(/outside/)
    expect(
      browserOpenViolation(
        submit.replace(
          '@submit.prevent="submitAddress"',
          ':on-ready="submitAddress"',
        ),
      ),
    ).toMatch(/DOM events/)
    expect(
      browserOpenViolation(
        submit.replace(
          '<input v-model="address" />',
          '<a @click="openBrowserUrl(link)">x</a>',
        ),
      ),
    ).toMatch(/template/)
  })

  it('keeps the browser view in its own sandboxed, memory-only partition', () => {
    const host = readFileSync(resolve(__dirname, 'browser-view.ts'), 'utf8')
    expect(host).toContain("BROWSER_PARTITION = 'emperor-browser'")
    expect(host).not.toMatch(/['"`]persist:/)
    expect(host).not.toMatch(/\bpreload\s*:/)
    expect(source).toMatch(/new BrowserViewHost\(mainWindow[,)]/)
    expect(source).not.toMatch(/new WebContentsView\(/)
    // Clearing its data reaches no other partition (the Agent's profiles).
    expect(host.match(/fromPartition\(([^)]*)\)/g)).toEqual([
      'fromPartition(BROWSER_PARTITION)',
    ])
  })
})
