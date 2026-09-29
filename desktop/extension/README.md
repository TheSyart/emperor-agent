# Emperor Agent Chrome/Edge connector (M5.1)

Load this folder as an unpacked extension in `chrome://extensions` or `edge://extensions`. Enable Developer mode, choose **Load unpacked**, and select `desktop/extension/`. The native host source and registration commands are in [../native/browser-host/README.md](../native/browser-host/README.md). Local Chrome and packaged Emperor pairing, tab attachment, main-frame observation, fill, click, extension reload invalidation, and active disconnect invalidation were observed on 2026-09-24. The exact evidence and remaining limits are in `private-docs/progress/2026-09-23-computer-use/receipts/M5-chrome-pairing.md`. Until the extension and host are installed and connected, the popup reports a disconnected host. The native host manifest must use `name: "com.emperor.agent.browser"`, `type: "stdio"`, and an `allowed_origins` entry containing **only** the installed extension ID.

The `key` in `manifest.json` pins the extension ID to `oobcokoopgkhlhpohfdpelkafiidojjn` (only the public key is kept; `nm-manifest.test.ts` re-derives the ID from it). With a packaged Emperor, **Settings › 电脑操作 › 连接 Chrome/Edge** writes the host manifest for this ID in every Chrome or Edge profile directory that exists; then start pairing from the extension popup. An unpacked copy loaded before the key was added had a different ID: reload it and pair again. Publishing through the Chrome Web Store assigns the store's own ID; update `EMPEROR_EXTENSION_ID` then.

The extension asks for site permission one exact origin at a time, when the user clicks **连接当前标签页**. It then attaches only that tab. The popup shows the attached-tab count and whether the current tab is attached separately from **已连接 Emperor**, which means only that pairing and the native connection succeeded. Emperor Settings shows the same distinction. `tabs.discover` reports the origin and tab/window IDs for browser tabs, with no URL path, query, title, page text, or input values. Discovery does not attach or authorize a tab. Site permission and a user attachment are both required before observe or act. M5 uses content scripts and does not request the `debugger` permission. Chrome does not permit `debugger` in `optional_permissions`; a future CDP path would require a separate design and a required manifest permission.

## Native Messaging envelope

The host is a byte-for-byte relay between the extension and Emperor main. Chrome frames each JSON message to/from the host with native-endian 32-bit length; the extension uses `chrome.runtime.connectNative()` and never writes framing bytes itself. The host must enforce Chrome's 1 MiB host-to-extension and 64 MiB extension-to-host limits; this extension caps each JSON message to 900,000 UTF-8 bytes. No page data or action command may go over an unencrypted native frame.

The inner protocol is version 1 and uses the §11 shapes: `request { type, id, method, params, deadlineMs }`, `response { type, id, ok, result | error }`, `event { type, name, data }`, `cancel { type, id }`, `ping { type, seq }`, `pong { type, seq }`. IDs are nonnegative safe integers. The extension accepts only these fixed methods after authentication:

| Main → extension method | Params                                                | Result                                                                                                                                      |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs.discover`         | `{}`                                                  | `{tabs:[{tabId,windowId,origin,attached}]}`                                                                                                 |
| `target.list`           | `{}`                                                  | `{targets:[{targetId,tabId,windowId,origin,generation,revision}]}`                                                                          |
| `target.observe`        | `{targetId,generation,budget?:{maxElements?:number}}` | `{targetId,generation,revision,origin,viewport,elements,truncated,redactions,notes}`                                                        |
| `target.act`            | `{targetId,generation,expectedRevision,action}`       | `{dispatched:true,outcome:"unknown",valuePresent?:boolean}`; only `{kind:"click",ref,button?:"left",count?:1}` and `{kind:"fill",ref,text}` |
| `target.detach`         | `{targetId,generation}`                               | `{released:true}`                                                                                                                           |

`target.attached {targetId,tabId,windowId,origin,generation}`, `target.lost {targetId,generation,reason}`, and `bridge.ready {protocol,extensionId,workerEpoch}` are extension → main events. `target.act` deliberately reports `outcome:"unknown"` after dispatch; main must re-observe or use its operation journal, and must never replay an action blindly. A failed `target.act` after sending can return `OUTCOME_UNKNOWN`.

## Pairing and encrypted channel

This is the extension half of the §7.6 six-digit pairing process. The main implementation must follow the same steps before pairing is a safe, usable feature:

1. The popup starts a plaintext `pair.begin` request with `{protocol:1,extensionId,publicKey,nonce}`. `publicKey` is an uncompressed P-256 point (65 bytes, base64url) and `nonce` is 16 random bytes (base64url).
2. Main responds with `{pairingId,publicKey,nonce}` and displays its six-digit code. Both sides derive 256 ECDH bits. `transcript = JSON.stringify(["emperor-browser-pair-v1",extensionId,pairingId,extensionPublicKey,mainPublicKey,extensionNonce,mainNonce])`. The 32-byte `secret` is HKDF-SHA256 of those bits with UTF-8 transcript as salt and info `emperor-browser-pair-v1:secret`. The code is the unsigned big-endian first four bytes of `HMAC-SHA256(secret, "emperor-browser-pair-v1:sas:" + transcript)` modulo 1,000,000, zero-padded to six digits. The extension emits `pair.displayed {pairingId}` after showing its code. Emperor must require the user to compare both codes and explicitly confirm in Emperor.
3. On confirmation, main emits plaintext `pair.approved {pairingId,proof}` where `proof = base64url(HMAC-SHA256(secret, "emperor-browser-pair-v1:main-approved:" + transcript))`. The extension verifies before saving `{pairingId,secret}` in `chrome.storage.local`, restricted to trusted extension contexts via `setAccessLevel`. It replies `pair.ready {pairingId,proof}` with HMAC label `extension-ready`. Rejection emits `pair.rejected {}`. The host sees only public keys, nonces, pairing ID, and proofs; it never receives the shared secret.
4. Every native connection runs `auth.begin {protocol,pairingId,nonce}` (extension nonce); main responds `{nonce,proof}` with `HMAC(secret, JSON.stringify(["emperor-browser-pair-v1","auth","main",extensionNonce,mainNonce]))`. Extension verifies and requests `auth.finish {pairingId,proof}` with side `"extension"`; main replies `{accepted:true}`. Until this completes, all operational frames are rejected.
5. For each authenticated connection, both sides HKDF the stored secret with UTF-8 `JSON.stringify(["emperor-browser-pair-v1","traffic",extensionNonce,mainNonce])` as salt. Info strings `emperor-browser-pair-v1:extension-to-main` and `emperor-browser-pair-v1:main-to-extension` derive distinct AES-256-GCM keys. Encrypted outer frames are `{type:"secure",pairingId,counter,ciphertext}`. `counter` starts at 1 separately in each direction and increases by exactly one. AES-GCM IV is 12 bytes: four zero bytes then the counter as uint64 big-endian. AAD is UTF-8 `JSON.stringify(["emperor-browser-pair-v1",pairingId,counter,direction])`; `ciphertext` is base64url ciphertext plus tag. Inner JSON is the §11 message above. Wrong pairing ID, counter, AAD, or tag closes the port.

The six-digit code is for human comparison, not the encryption key. A relay that substitutes a public key produces a different code on each side. Main must not accept `pair.approved` before its own UI approval, and should enable confirmation only after `pair.displayed`. The extension has no way to attest Emperor's installed binary; M5.2's native host must check the main process identity as specified in §7.6.

## Target and data boundaries

- Each service worker start increments a persisted generation counter. Bind, reload, cross-document navigation, tab replacement/removal, window transfer, permission revocation, and disconnection invalidate old targets. An exact origin or URL match never restores an old handle.
- Each observation increments revision and returns `r<revision>.<n>` references. The content script holds only the current ref map. DOM mutation or user input invalidates the observation; action checks `targetId`, generation, revision, document ID, mutation count, and current tab/window/URL/site permission before dispatch.
- The content script runs in Chrome's isolated world. It has no listener for page `postMessage`, no `eval`, no remote code, and no host-provided selectors or scripts. It never reads cookies, storage, hidden inputs, any input/textarea/contenteditable value, or page text excerpts. Sensitive controls are observed only with a safe label and no actions. The fixed `fill` path refuses password, OTP, payment, token, and similarly named fields. Credential filling needs the separate main vault path in a later milestone.
- Observation currently covers only the main frame. No screenshots, cross-origin frames, uploads, downloads, navigation, keyboard shortcuts, scrolling, or debugger actions are exposed through this extension. The main driver must advertise those absent capabilities accurately.

## Local checks

From the repository root:

```sh
node --test desktop/extension/tests/*.test.js
node --check desktop/extension/service-worker.js
node --check desktop/extension/content-script.js
```

Real Chrome loading, Native Messaging, tab attachment, main-frame actions, extension reload, and active disconnect have local integration evidence. Real tab ID reuse, service-worker lifetime, and Edge remain unverified.

Chrome references: [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).
