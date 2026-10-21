#!/usr/bin/env node
// A fake GitHub release feed on 127.0.0.1 for testing 检查更新 (REL-02):
// the release list, the DMG and SHA256SUMS.txt, the way GitHub serves them
// (the download link redirects once). Emperor reads it when started with
// EMPEROR_UPDATE_FEED_URL pointing here; the address must be loopback, and
// 设置 › 常规 › 更新 and 诊断 then say a test feed is in effect.
//
//   node scripts/test-update-feed.mjs --dmg <file> [--version 0.2.1]
//        [--port 8765] [--electron 45.0.0] [--tamper]
//
// --dmg: any file, served as Emperor-Agent-<version>-macos-<arch>.dmg for
//   both architectures (REL-07: a test build's DMG).
// --tamper: SHA256SUMS.txt lists a wrong digest (Emperor must refuse the
//   download and delete it).
// --electron: the Electron the release claims to bundle (诊断 reminds when
//   the running one is more than 2 majors behind).
// The e2e (tests/electron/updates) imports startTestUpdateFeed().
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

export const FEED_PATH = '/repos/TheSyart/emperor-agent/releases'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function dmgName(version, arch) {
  return version.includes('-preview.')
    ? `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-${arch}.dmg`
    : `Emperor-Agent-${version}-macos-${arch}.dmg`
}

/**
 * Serve one release. Returns the feed URL, the requests seen (path and
 * headers), `set(next)` to change what is served, and `close()`.
 */
export async function startTestUpdateFeed(options) {
  const state = {
    version: options.version ?? '0.2.1',
    dmg: options.dmg,
    electron: options.electron ?? '',
    tamper: Boolean(options.tamper),
  }
  const requests = []
  let origin = ''
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    requests.push({ path, headers: { ...req.headers }, at: Date.now() })
    const tag = `v${state.version}`
    const names = [
      dmgName(state.version, 'arm64'),
      dmgName(state.version, 'x64'),
      'SHA256SUMS.txt',
    ]
    if (path === FEED_PATH || path.startsWith(`${FEED_PATH}?`)) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify([
          {
            tag_name: tag,
            name: `Emperor Agent ${tag}`,
            draft: false,
            prerelease: state.version.includes('-'),
            html_url: `https://github.com/TheSyart/emperor-agent/releases/tag/${tag}`,
            published_at: new Date().toISOString(),
            body: state.electron
              ? `Test release.\n\n<!-- emperor-release electron=${state.electron} -->\n`
              : 'Test release.\n',
            assets: names.map((name) => ({
              name,
              size: name === 'SHA256SUMS.txt' ? 300 : state.dmg.byteLength,
              browser_download_url: `${origin}/download/${tag}/${name}`,
            })),
          },
        ]),
      )
      return
    }
    const match = /^\/(download|served)\/([^/]+)\/([^?]+)/.exec(path)
    if (!match || match[2] !== tag || !names.includes(match[3])) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const name = match[3]
    if (name === 'SHA256SUMS.txt') {
      const digest = state.tamper ? 'f'.repeat(64) : sha256(state.dmg)
      res.end(
        names
          .slice(0, 2)
          .map((dmg) => `${digest}  ${dmg}`)
          .join('\n') + '\n',
      )
      return
    }
    if (match[1] === 'download') {
      // Like GitHub: the download link redirects to the asset host.
      res.statusCode = 302
      res.setHeader('location', `/served/${tag}/${name}`)
      res.end()
      return
    }
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-length', String(state.dmg.byteLength))
    res.end(state.dmg)
  })
  await new Promise((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve),
  )
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    url: `${origin}${FEED_PATH}`,
    requests,
    set(next) {
      Object.assign(state, next)
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function cli() {
  const file = argument('dmg')
  if (!file) {
    console.error(
      'usage: node scripts/test-update-feed.mjs --dmg <file> [--version 0.2.1] [--port 8765] [--electron 45.0.0] [--tamper]',
    )
    process.exit(2)
  }
  const feed = await startTestUpdateFeed({
    dmg: readFileSync(file),
    version: argument('version'),
    port: Number(argument('port') ?? 8765),
    electron: argument('electron'),
    tamper: process.argv.includes('--tamper'),
  })
  console.log(`test update feed: ${feed.url}`)
  console.log(
    `start Emperor with it:\n  EMPEROR_UPDATE_FEED_URL=${feed.url} "/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent"`,
  )
  console.log('every request is printed below; Ctrl-C stops the feed.')
  setInterval(() => {
    while (feed.requests.length) {
      const request = feed.requests.shift()
      console.log(
        `${new Date(request.at).toISOString()} ${request.path} ${JSON.stringify(request.headers)}`,
      )
    }
  }, 500)
}

// Run as a script (the e2e bundles this file and only imports it).
if (/test-update-feed\.mjs$/.test(process.argv[1] ?? '')) void cli()
