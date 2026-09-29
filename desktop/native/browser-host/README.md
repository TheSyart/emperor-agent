# macOS Native Messaging host (M5.2)

`emperor-nm-host` is a Swift native executable. It uses no Node runtime and contains no model, browser-action, or pairing implementation. It only validates the local socket peer and relays opaque length-prefixed frames. It never parses, logs, or changes page content, pairing proofs, or encrypted traffic.

## Build and package

From the repository root:

```sh
desktop/native/browser-host/build.sh arm64 release
# or on Intel CI:
desktop/native/browser-host/build.sh x86_64 release
```

The script prints the absolute artifact path, `desktop/native/browser-host/build/<arch>/release/emperor-nm-host`. It compiles with the macOS 14 deployment target, ad-hoc signs the build artifact for local verification, and does **not** register it with any browser. The packager copies this binary to `Emperor Agent.app/Contents/Library/Helpers/emperor-nm-host` and signs the nested binary with the production identity before signing the outer app. The fixture build (`build.sh <arch> fixture`) enables an explicit test-only peer executable and socket override; never package that binary.

The default socket is `<getpwuid(uid).pw_dir>/.emperor/run/nm-<uid>.sock`. Emperor main must create `run/` owned by the user with mode **0700** and the socket owned by the user with no group/other permissions (use **0600**). The host checks these before connecting, then verifies `getpeereid` and `LOCAL_PEERPID` on the connected socket. A production-signed host requires the main process signature to satisfy bundle identifier `com.emperor.agent.desktop`, Apple generic anchor, and the host's own Team ID. An ad-hoc development host accepts only the precise executable path derived from its nested app location: `Emperor Agent.app/Contents/MacOS/Emperor Agent`. It does not trust an environment variable or a command-line path in production.

The socket uses the **Chrome Native Messaging** frame format: native-endian unsigned 32-bit payload byte count followed by UTF-8 JSON bytes. This differs from the separate §11 platform-helper protocol's big-endian framing. The host enforces 64 MiB from browser to main and 1 MiB from main to browser, before allocating a payload buffer. Main must validate JSON and the encrypted extension protocol itself. A missing main emits one fixed `response` with `id:0`, `error.code:"EMPEROR_NOT_RUNNING"`, then closes; a peer-identity failure emits `PEER_IDENTITY_REJECTED`. Main must not rely on the host for pairing authentication.

## Manifest generation and registration

A packaged Emperor registers the manifest itself (Settings › 电脑操作 › 连接 Chrome/Edge, for the pinned extension ID `oobcokoopgkhlhpohfdpelkafiidojjn`), keeps its `path` on the running app at startup, and removes it when the last pairing is revoked in Settings. The commands below are for development and diagnosis. Read the 32-character extension ID from `chrome://extensions` or `edge://extensions`. The manifest has exactly one `allowed_origins` entry. Generate a reviewable manifest without installing it:

```sh
desktop/native/browser-host/manifest.sh generate \
  '/absolute/path/Emperor Agent.app/Contents/Library/Helpers/emperor-nm-host' \
  '<extension-id>' \
  /tmp/com.emperor.agent.browser.json
```

After the user chooses to connect a browser, Emperor can call the equivalent explicit registration operation:

```sh
desktop/native/browser-host/manifest.sh install chrome '<absolute-host-binary>' '<extension-id>'
desktop/native/browser-host/manifest.sh uninstall chrome '<absolute-host-binary>'
```

Supported browser keys: `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `chrome-for-testing`, `chromium`, `edge`. Registration creates `com.emperor.agent.browser.json` in that browser's user-level `NativeMessagingHosts/` directory. Uninstall removes only a regular, user-owned manifest with this host name. The app should re-register when its bundle path moves. For the macOS Chrome integration check on 2026-09-24, the user loaded the extension and the host manifest was installed for its exact ID; see `private-docs/progress/2026-09-23-computer-use/receipts/M5-chrome-pairing.md` for the observed behavior and remaining limits.

## Checks

```sh
desktop/native/browser-host/build.sh arm64 fixture
python3 desktop/native/browser-host/smoke.py \
  desktop/native/browser-host/build/arm64/fixture/emperor-nm-host
desktop/native/browser-host/build.sh arm64 release
```

The fixture uses a real Unix socket and subprocess. It verifies unmodified bidirectional frames, rejects the wrong peer executable and invalid extension origin, handles an absent main, and rejects oversized frames in both directions. The signed production host and Emperor main completed a real Chrome pairing and page operation check on 2026-09-24. Extension worker lifetime, real tab ID reuse, and Edge loading remain unverified.

Reference: [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
