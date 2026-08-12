import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { isPathWithin } from '../util/paths'

export interface StaticProjectHost {
  url: string
  close(): Promise<void>
}

export async function startStaticProjectHost(input: {
  projectRoot: string
  port: number
}): Promise<StaticProjectHost> {
  const root = realpathSync(resolve(input.projectRoot))
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(
        new URL(request.url || '/', 'http://local').pathname,
      )
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    const relative =
      pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    let target: string
    try {
      target = realpathSync(join(root, relative))
      if (!isPathWithin(target, root) || !lstatSync(target).isFile())
        throw new Error('outside project')
    } catch {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'Content-Type': contentType(target),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:",
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(target).pipe(response)
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(input.port, '127.0.0.1', () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })
  return {
    url: `http://127.0.0.1:${input.port}/`,
    close: async () => await closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise())
  })
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}
