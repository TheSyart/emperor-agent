/**
 * Local fixture site for the Computer Use end-to-end suite. Serves the same
 * page names and semantics as the core fake driver's `FIXTURE_PAGES`, so the
 * driver contract cases run against both, on two origins (127.0.0.1 and
 * localhost on different ports) for cross-origin checks.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureSite {
  readonly origin: string
  readonly otherOrigin: string
  /** URL-encoded form posts the site received (path + decoded fields). */
  submissions(): ReadonlyArray<{
    path: string
    fields: Readonly<Record<string, string>>
  }>
  close(): Promise<void>
}

const page = (title: string, body: string, head = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

function pages(otherOrigin: string): Record<string, string> {
  const long = Array.from(
    { length: 400 },
    (_, index) => `<li><a href="/long#${index + 1}">Item ${index + 1}</a></li>`,
  ).join('')
  return {
    '/form': page(
      'Fixture form',
      `<p>Sign up for the fixture newsletter.</p>
<form action="/done" method="post">
  <label>Name <input name="name" type="text"></label>
  <label>Email <input name="email" type="email"></label>
  <label>Password <input name="password" type="password"></label>
  <label>Card number <input name="card" autocomplete="cc-number"></label>
  <label>One-time code <input name="otp" autocomplete="one-time-code"></label>
  <input type="hidden" name="csrf" value="secret-token">
  <label>Country <select name="country"><option>China</option><option>Japan</option><option>France</option></select></label>
  <label><input type="checkbox" name="agree"> I agree</label>
  <button type="submit">Submit</button>
  <button type="button" disabled>Disabled</button>
</form>`,
    ),
    '/done': page(
      'Thanks',
      '<p>Thanks for signing up.</p><a href="/form">Back to form</a>',
    ),
    '/spa': page(
      'SPA',
      `<p>Single page app.</p>
<div role="tablist">
  <button role="tab" onclick="history.pushState({}, '', '/spa#a')">Tab A</button>
  <button role="tab" onclick="history.pushState({}, '', '/spa#b')">Tab B</button>
</div>`,
    ),
    '/long': page('Long list', `<p>A long list of links.</p><ul>${long}</ul>`),
    '/frames': page(
      'Frames',
      `<p>A page with frames.</p>
<button>Outer button</button>
<iframe title="same" src="/frame-inner" width="300" height="80"></iframe>
<iframe title="other" src="${otherOrigin}/embed" width="300" height="80"></iframe>`,
    ),
    '/frame-inner': page(
      'Inner',
      `<button onclick="this.textContent='Inner clicked'">Inner button</button>`,
    ),
    '/animate': page(
      'Animate',
      `<div id="box" style="width:120px;height:120px;background:#c33"></div>
<script>let a = 0; (function spin() { a += 3; box.style.transform = 'rotate(' + a + 'deg)'; requestAnimationFrame(spin) })()</script>`,
    ),
    '/overlay': page(
      'Overlay',
      `<button onclick="this.textContent='reached'">Covered button</button>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><button onclick="this.parentElement.remove()">Accept cookies</button></div>`,
    ),
    '/dialog': page(
      'Dialog',
      `<button onclick="alert('hello from the page');document.getElementById('o').textContent='after alert'">Show alert</button>
<button onclick="document.getElementById('o').textContent=confirm('sure?')?'confirmed':'declined'">Ask confirm</button>
<div id="o">idle</div>`,
    ),
    '/embed': page(
      'Embed',
      `<button onclick="this.textContent='Cross-origin clicked'">Cross-origin button</button>
<label>Embedded note <input name="note"></label>`,
    ),
    '/shadow': page(
      'Shadow DOM',
      `<p>Custom elements.</p><fixture-card></fixture-card>
<script>
customElements.define('fixture-card', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<button>Shadow button</button>'
  }
})
</script>`,
    ),
    '/popup': page(
      'Popup',
      `<p>Opens a window.</p><button onclick="window.open('/done')">Open window</button>`,
    ),
    '/slow': page(
      'Slow',
      `<p>Loading…</p>
<script>setTimeout(() => {
  const button = document.createElement('button')
  button.textContent = 'Ready'
  document.body.append(button)
}, 120)</script>`,
    ),
    '/upload': page(
      'Upload',
      `<p>Attach a document.</p>
<form action="/done" method="post" enctype="multipart/form-data">
  <label>Document <input type="file" name="doc"></label>
  <button type="submit">Send</button>
</form>`,
    ),
    '/files': page(
      'Files',
      `<p>Reports to download.</p>
<a href="/files/report.csv">Download report</a>
<a href="/files/setup.dmg">Download installer</a>`,
    ),
    '/checkout': page(
      'Checkout',
      `<p>Review your order.</p>
<form action="/done" method="post"><button type="submit">Pay now</button></form>
<button>删除账户</button>`,
    ),
    // Profile isolation probe (spec 00 §7.2). `?set=<value>` stores the value
    // as a persistent cookie (Set-Cookie, see the handler) and in
    // localStorage; every load prints what this profile holds as page text.
    '/storage': page(
      'Storage',
      `<p id="state">cookie=unread local=unread</p>
<script>
const value = new URLSearchParams(location.search).get('set')
if (value) localStorage.setItem('cu_probe', value)
const cookie = document.cookie.match(/(?:^|; )cu_probe=([^;]*)/)
document.getElementById('state').textContent =
  'cookie=' + (cookie ? cookie[1] : 'none') +
  ' local=' + (localStorage.getItem('cu_probe') ?? 'none')
</script>`,
    ),
  }
}

/** A probe value for `/storage?set=`: letters, digits and dashes only. */
const PROBE_VALUE = /^[\w-]{1,64}$/

const DOWNLOADS: Record<string, { type: string; body: string }> = {
  '/files/report.csv': { type: 'text/csv', body: 'month,total\n2026-08,42\n' },
  '/files/setup.dmg': {
    type: 'application/x-apple-diskimage',
    body: 'not really a disk image',
  },
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, host, () =>
      resolve((server.address() as AddressInfo).port),
    ),
  )
}

export async function startFixtureSite(): Promise<FixtureSite> {
  let routes: Record<string, string> = {}
  const submissions: Array<{ path: string; fields: Record<string, string> }> =
    []
  const handler = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    const path = url.pathname
    if (
      request.method === 'POST' &&
      (request.headers['content-type'] ?? '').startsWith(
        'application/x-www-form-urlencoded',
      )
    ) {
      // Record what a form really sent, so a test can check the submission
      // itself rather than which tab happens to still be open.
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const fields = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
        )
        submissions.push({ path, fields })
      })
    } else if (request.method === 'POST') request.resume()
    const probe = url.searchParams.get('set')
    if (path === '/storage' && probe !== null && PROBE_VALUE.test(probe))
      response.setHeader(
        'set-cookie',
        `cu_probe=${probe}; Path=/; Max-Age=86400; SameSite=Lax`,
      )
    const file = DOWNLOADS[path]
    if (file !== undefined) {
      response.setHeader('content-type', file.type)
      response.setHeader(
        'content-disposition',
        `attachment; filename="${path.split('/').pop()}"`,
      )
      response.end(file.body)
      return
    }
    const body = routes[path === '/' ? '/form' : path]
    if (body === undefined) {
      response.statusCode = 404
      response.end('not found')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  })
  const other = createServer(handler.listeners('request')[0] as never)
  const port = await listen(handler, '127.0.0.1')
  const otherPort = await listen(other, '127.0.0.1')
  const origin = `http://127.0.0.1:${port}`
  const otherOrigin = `http://localhost:${otherPort}`
  routes = pages(otherOrigin)
  return {
    origin,
    otherOrigin,
    submissions: () => submissions,
    close: async () => {
      await Promise.all(
        [handler, other].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      )
    },
  }
}
