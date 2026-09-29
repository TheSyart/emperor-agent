import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = readFileSync(
  new URL('../content-script.js', import.meta.url),
  'utf8',
)

function fixture() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
    <label for="user">User</label><input id="user" value="private autofill">
    <label for="pass">Password</label><input id="pass" type="password" value="SECRET_DO_NOT_SEND">
    <input type="hidden" value="HIDDEN_TOKEN">
    <textarea id="note">SECRET_TEXTAREA</textarea>
    <div contenteditable="true">SECRET_EDITABLE</div>
    <button id="go">Continue</button>
  </body></html>`,
    {
      url: 'https://example.com',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  )
  const { window } = dom
  Object.defineProperty(window.crypto, 'randomUUID', {
    value: () => 'document-1',
  })
  window.Element.prototype.getBoundingClientRect = () => ({
    x: 1,
    y: 2,
    width: 100,
    height: 24,
  })
  let listener
  window.chrome = {
    runtime: {
      id: 'extension-id',
      onMessage: {
        addListener(fn) {
          listener = fn
        },
      },
    },
  }
  window.eval(source)
  const send = (message) => {
    let response
    listener(
      { channel: 'emperor-content-v1', ...message },
      { id: 'extension-id' },
      (value) => {
        response = value
      },
    )
    return response
  }
  return { window, send }
}

test('snapshot omits password, hidden token and every input value', () => {
  const { send } = fixture()
  const identity = send({ method: 'identity' })
  assert.equal(identity.ok, true)
  assert.equal(identity.documentId, 'document-1')
  const result = send({ method: 'observe', revision: 1, maxElements: 200 })
  assert.equal(result.ok, true)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('SECRET_DO_NOT_SEND'), false)
  assert.equal(serialized.includes('HIDDEN_TOKEN'), false)
  assert.equal(serialized.includes('private autofill'), false)
  assert.equal(serialized.includes('SECRET_TEXTAREA'), false)
  assert.equal(serialized.includes('SECRET_EDITABLE'), false)
  assert.equal(
    result.elements.find((item) => item.name === 'Password').actions.length,
    0,
  )
  assert.equal(
    result.elements.some((item) => item.name === 'Continue'),
    true,
  )
})

test('fixed click and fill act on observed refs once; stale revisions fail', async () => {
  const { window, send } = fixture()
  let clicks = 0
  window.document.getElementById('go').addEventListener('click', () => {
    clicks++
  })
  const observed = send({ method: 'observe', revision: 4 })
  const user = observed.elements.find((item) => item.name === 'User')
  const button = observed.elements.find((item) => item.name === 'Continue')
  const fill = send({
    method: 'act',
    kind: 'fill',
    ref: user.ref,
    text: 'Alice',
    documentId: observed.documentId,
    revision: 4,
    mutationVersion: observed.mutationVersion,
  })
  assert.equal(fill.ok, true)
  assert.equal(window.document.getElementById('user').value, 'Alice')
  const stale = send({
    method: 'act',
    kind: 'click',
    ref: button.ref,
    documentId: observed.documentId,
    revision: 4,
    mutationVersion: observed.mutationVersion,
  })
  assert.equal(stale.error, 'STALE_ELEMENT')
  await Promise.resolve()
  const again = send({ method: 'observe', revision: 5 })
  const newButton = again.elements.find((item) => item.name === 'Continue')
  const clicked = send({
    method: 'act',
    kind: 'click',
    ref: newButton.ref,
    documentId: again.documentId,
    revision: 5,
    mutationVersion: again.mutationVersion,
  })
  assert.equal(clicked.ok, true)
  assert.equal(clicks, 1)
  assert.equal(
    send({
      method: 'act',
      kind: 'click',
      ref: newButton.ref,
      documentId: again.documentId,
      revision: 5,
      mutationVersion: again.mutationVersion,
    }).error,
    'STALE_ELEMENT',
  )
})

test('password fill and fabricated refs are refused', () => {
  const { send } = fixture()
  const snapshot = send({ method: 'observe', revision: 1 })
  const password = snapshot.elements.find((item) => item.name === 'Password')
  assert.equal(
    send({
      method: 'act',
      kind: 'fill',
      ref: password.ref,
      text: 'should-not-write',
      documentId: snapshot.documentId,
      revision: 1,
      mutationVersion: snapshot.mutationVersion,
    }).error,
    'CAPABILITY_DISABLED',
  )
  assert.equal(
    send({
      method: 'act',
      kind: 'click',
      ref: 'r1.999',
      documentId: snapshot.documentId,
      revision: 1,
      mutationVersion: snapshot.mutationVersion,
    }).error,
    'STALE_ELEMENT',
  )
})
