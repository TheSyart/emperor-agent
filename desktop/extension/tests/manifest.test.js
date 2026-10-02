import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { browserName, SITE_ORIGINS } from '../protocol.js'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root)))

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path) {
  const bytes = readFileSync(new URL(path, root))
  assert.equal(
    bytes.subarray(1, 4).toString('latin1'),
    'PNG',
    `${path} is a PNG`,
  )
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

test('the extension carries the Emperor icon at every size Chrome asks for', () => {
  assert.deepEqual(Object.keys(manifest.icons).sort(), [
    '128',
    '16',
    '32',
    '48',
  ])
  for (const [size, path] of Object.entries(manifest.icons))
    assert.deepEqual(pngSize(path), [Number(size), Number(size)], path)
  for (const [size, path] of Object.entries(manifest.action.default_icon))
    assert.deepEqual(pngSize(path), [Number(size), Number(size)], path)
})

test('the onboarding page and every file the manifest names ship with it', () => {
  for (const file of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    'welcome.html',
    'welcome.js',
    'welcome.css',
  ])
    assert.ok(existsSync(new URL(file, root)), file)
  const page = readFileSync(new URL('welcome.html', root), 'utf8')
  assert.match(page, /<script src="welcome\.js" type="module"><\/script>/)
  // Same site grant the onboarding page asks for, nothing broader.
  assert.deepEqual(manifest.optional_host_permissions, SITE_ORIGINS)
  // Removal and reload need no extra permission.
  assert.ok(!manifest.permissions.includes('management'))
})

test('the browser is told apart by its brand, then by its user agent', () => {
  assert.equal(
    browserName({
      userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '150' }] },
    }),
    'edge',
  )
  assert.equal(
    browserName({
      userAgentData: { brands: [{ brand: 'Google Chrome', version: '154' }] },
    }),
    'chrome',
  )
  assert.equal(
    browserName({ userAgent: 'Mozilla/5.0 Chrome/150.0 Edg/150.0' }),
    'edge',
  )
  assert.equal(browserName({ userAgent: 'Mozilla/5.0 Chrome/154.0' }), 'chrome')
  assert.equal(browserName(undefined), 'chrome')
})
