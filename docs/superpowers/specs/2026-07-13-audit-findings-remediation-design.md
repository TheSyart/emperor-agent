# Audit Findings Remediation Design

> Date: 2026-07-13  
> Status: approved for implementation  
> Source: `docs/audit/2026-07-13-code-audit.md`  
> Baseline: `main@53a54aaa495f449e78d5d4db996f50db950362a0`

## 1. Purpose

Eliminate all five confirmed findings from the 2026-07-13 repository audit without restoring the retired Python runtime, changing persisted business schemas, or weakening existing desktop and agent capabilities. The implementation must turn each audit invariant into an automated regression test and must preserve browser-development fallback, cross-platform Electron behavior, Scheduler semantics for non-concurrent runs, and existing model/MCP configuration shapes.

## 2. Decisions

### 2.1 Selected approach

Use defense in depth at the boundary where each unsafe effect originates:

1. Lock the Electron window to trusted renderer origins and authenticate every privileged IPC call.
2. In AUTO mode, automatically permit only commands positively classified as read-only diagnostics; require approval for every other `run_command` invocation.
3. Make active-task registration own creation of the effectful Promise, and add a Scheduler per-job lease before mutating run state.
4. Move public-network validation into a reusable HTTP fetch component that validates DNS, IP ranges, every redirect hop, and streamed response size.
5. Reuse the shared atomic JSON store for Model/MCP writes and isolate corrupt boot-critical files before falling back to validated defaults.

### 2.2 Rejected approaches

- **Patch only known examples:** adding checks for `bash script.sh`, `[::1]`, or one external-link form leaves equivalent interpreters, DNS aliases, redirects, and alternate navigation APIs open.
- **Disable the affected features:** disabling links, AUTO, WebFetch, Scheduler manual run, or MCP would remove product capabilities instead of repairing their trust boundaries.
- **String blacklists as the primary boundary:** command and hostname blacklists cannot prove the safety of nested code or the address actually reached by the network stack.

## 3. Global constraints

- TypeScript and Electron remain the only product runtime. Do not add Python runtime files or fallbacks.
- Runtime data remains under `stateRoot`; no new repository-local runtime data.
- Existing `model_config.json` and `mcp_config.json` schemas remain readable without migration.
- Desktop development through `ELECTRON_RENDERER_URL` remains supported, but only its exact origin is trusted.
- New CoreApi operations or runtime events are not needed for these fixes.
- All behavior changes use TDD: regression test must fail for the audited reason before production code changes.
- No destructive exploit is executed during verification; tests use fakes, loopback fixtures, temporary directories, and inert marker callbacks.

## 4. Architecture

### 4.1 Trusted Electron boundary

Create a focused main-process module that derives a `TrustedRendererPolicy` from the production app URL and optional development URL.

```typescript
export interface TrustedRendererPolicy {
  isTrustedUrl(value: string): boolean
  handleNavigation(event: { preventDefault(): void }, targetUrl: string): void
  handleWindowOpen(details: { url: string }): { action: 'deny' }
  assertTrustedIpc(event: Electron.IpcMainInvokeEvent): void
}
```

Trust rules:

- Production trusts only URLs whose protocol is `app:`, host is `bundle`, and whose credentials are empty.
- Development trusts only the exact origin of the parsed `ELECTRON_RENDERER_URL`; path changes within that origin are allowed.
- Every other navigation is prevented. Only `http:` and `https:` URLs are forwarded to `shell.openExternal`; other schemes are denied without dispatch.
- `setWindowOpenHandler` always returns `{ action: 'deny' }`; eligible external HTTP(S) targets are opened through the injected external opener.
- IPC is trusted only when `senderFrame` exists, is the top frame, its URL passes the same policy, and its `webContents` is the registered main window contents.
- `registerCoreIpc` receives an authorization callback and rejects before argument parsing or CoreApi invocation.
- Non-Core privileged handlers (`open-path`, directory selection, pet controls) use the same authorization callback.

The policy is a pure, dependency-injected unit so URL and caller checks can be tested without launching a real Electron process. An Electron main-process integration test verifies it is wired to BrowserWindow and IPC registration.

### 4.2 AUTO command policy

The permission pipeline changes from negative detection to positive authorization:

| Command classification                | AUTO result                   |
| ------------------------------------- | ----------------------------- |
| `isReadonlyCommand(command) === true` | allow                         |
| Any other `run_command`               | require high-risk approval    |
| Non-command tool                      | retain existing AUTO behavior |

This intentionally treats tests, builds, package-manager scripts, interpreters, workspace executables, redirections, control operators, and unknown binaries as approval-required. `RunCommand` retains its last-resort deny rules for commands that must never execute, but refusal text no longer recommends script indirection.

The approved command text remains the effect-bearing input passed to the existing permission interaction. No new persistent approval token is introduced in this change; the current runner already re-evaluates permission after Hook input transformation.

### 4.3 Scheduler at-most-once dispatch

Change `ActiveTaskRegistry.run` to accept an effect factory:

```typescript
async run<T>(opts: {
  taskId: string
  kind: ActiveTaskKind
  label: string
  execute: () => Promise<T>
  // existing metadata and abort callback
}): Promise<T>
```

The registry checks uniqueness, records the active task, and only then calls `execute()`. Existing callers are migrated from pre-created `awaitable` Promises.

SchedulerService additionally owns `Set<string> inFlightJobIds`. `runJob` and timer execution attempt to acquire the job ID before changing Scheduler state or emitting `scheduler_run_start`. A duplicate manual run returns `false`; a timer duplicate is skipped. Release happens in `finally`, including cancellation and errors.

This yields two protections:

1. The generic registry guarantees a rejected task factory never starts.
2. SchedulerService guarantees duplicate runs never create task records or transient Scheduler state before reaching the registry.

### 4.4 Public HTTP fetch boundary

Extract the hardened address and redirect logic currently embedded in `environment/download.ts` into a reusable module, keeping the environment downloader's behavior stable.

```typescript
export interface PublicHttpRequest {
  url: string
  protocols: readonly ('http:' | 'https:')[]
  maxBytes: number
  signal: AbortSignal
}

export interface PublicHttpResponse {
  url: string
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Uint8Array
}

export interface PublicAddressPolicy {
  resolve(hostname: string): Promise<ResolvedAddress[]>
  assertPublic(url: URL, addresses: ResolvedAddress[]): void
}
```

Required behavior:

- Reject credentials, fragments, `localhost`, `.local`, loopback, private, link-local, CGNAT, documentation, multicast, unspecified, reserved, and IPv4-mapped private addresses.
- Resolve and validate before every connection and every redirect hop.
- Connect to the selected validated address while retaining the original hostname for TLS SNI and Host.
- Allow at most five redirects.
- Stream at most `maxBytes`; abort and close immediately when the declared or actual size exceeds the limit.
- WebFetch permits `http:` and `https:` for compatibility. The environment asset downloader continues to require `https:`.
- WebFetch maps policy and transport errors to stable `[ERR]` strings without exposing stack traces.

The response body bound for WebFetch is 1 MiB. Its model-visible output remains capped by the existing tool result limit.

### 4.5 Recoverable Model/MCP configuration

Extend the shared atomic JSON store only where required for boot-critical configuration:

```typescript
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  opts?: { mode?: number },
): Promise<void>
```

- Atomic write creates a same-directory temporary file, writes complete UTF-8 JSON, syncs and closes it, applies the requested mode, then renames it over the destination.
- Model configuration uses mode `0o600` because it may contain API keys.
- MCP configuration uses the existing private `stateRoot` boundary and mode `0o600` for consistency.
- Write failure removes only the temporary file and leaves the previous destination unchanged.

Read behavior:

- On invalid JSON, atomically rename the original to a versioned `.corrupt-*` path.
- Load and validate the existing default configuration.
- Invoke a diagnostic callback with original path, backup path, and parse error.
- Model startup continues with an incomplete/default configuration so the existing onboarding/model setup UI can recover.
- MCP startup continues with no enabled servers.
- Empty files are treated as corrupt, preserved, and recovered; silently interpreting them as `{}` would hide data loss.
- Semantically invalid but parseable configuration is also isolated before fallback.

No legacy file is deleted and no disk schema changes are introduced.

## 5. Data flows

### 5.1 External link

```text
Markdown link → will-navigate → TrustedRendererPolicy
  ├─ trusted internal URL → navigation allowed
  ├─ http(s) external URL → prevent + system browser
  └─ other scheme → prevent + deny
```

### 5.2 Core IPC

```text
renderer invoke → IPC authorization → schema validation → CoreApi
                     └─ untrusted → safe forbidden envelope, no Core call
```

### 5.3 AUTO command

```text
run_command → prepareCall → PermissionPipeline
  ├─ positively read-only → execute
  └─ everything else → approval interaction → recheck → execute/deny
```

### 5.4 Scheduler

```text
manual/timer → acquire job lease → update running state → register task
  → start lazy effect → finalize state → release lease
duplicate → return/skip before state, task, or effect creation
```

### 5.5 Configuration recovery

```text
load → parse + validate
  ├─ valid → normal startup
  └─ invalid → isolate corrupt file → diagnostics → validated default → startup
```

## 6. Error handling

- External URL open failures are logged without allowing navigation to proceed.
- Untrusted IPC calls return the existing safe IPC error shape with a stable forbidden code and no sensitive caller details.
- Permission approval denial remains a normal tool result, not an exception that crashes a turn.
- Duplicate Scheduler requests are non-errors at the service boundary and produce no run events.
- Network policy errors distinguish blocked target, redirect limit, timeout, response-too-large, and generic fetch failure internally; WebFetch exposes concise stable messages.
- Corrupt config isolation failure is reported, but startup still uses defaults when doing so does not overwrite the original file.
- Atomic rename or permission failure propagates to the save caller while preserving the prior config.

## 7. Testing strategy

Each remediation begins with a focused failing regression test and proceeds RED → GREEN before the next finding.

### 7.1 Electron

- Production `app://bundle` navigation allowed.
- Exact dev origin allowed; origin confusion and subdomains denied.
- HTTP(S) link is prevented and opened externally.
- `file:`, `javascript:`, custom schemes and malformed URLs are denied.
- Popup creation always denied.
- Trusted top-frame IPC allowed.
- remote, subframe, missing-frame and wrong-webContents IPC denied.
- CoreApi is not called when authorization fails.

### 7.2 AUTO permission

- Known readonly diagnostics remain automatic.
- `bash script.sh`, `sh`, `zsh`, PowerShell and workspace executables require approval.
- test/build/package-manager scripts require approval.
- direct destructive commands remain denied by `RunCommand` safety policy.
- refusal text does not recommend indirection.
- Hook-transformed commands are reclassified before execution.

### 7.3 Scheduler

- A duplicate active task factory is never called.
- Two concurrent manual runs produce one dispatch and one run record.
- Manual/timer collision produces one dispatch.
- Duplicate team wake persists one message.
- cancellation/error releases the lease.
- a later run after completion succeeds.

### 7.4 Network

- IPv4, IPv6 and IPv4-mapped blocked ranges.
- DNS resolving to any blocked address is rejected.
- public-to-private redirect is rejected.
- redirect limit enforced.
- declared and streamed response limits enforced.
- timeout/cancellation closes transport.
- WebFetch text extraction and raw mode remain compatible.
- environment HTTPS download regression remains green.

### 7.5 Configuration

- Model/MCP writes replace valid files atomically.
- injected write/rename failure preserves previous bytes.
- invalid JSON and invalid schema are isolated.
- fallback startup succeeds for Model and MCP corruption.
- diagnostic includes backup path.
- model secret file mode is `0o600` on POSIX.
- existing valid schemas load without migration.

## 8. Acceptance criteria

- All five audit findings have regression tests that fail on the baseline and pass after implementation.
- No remote or untrusted frame can invoke Core or desktop privileged IPC.
- AUTO cannot execute an unclassified effectful shell command without approval.
- A rejected duplicate Scheduler run creates zero effectful dispatches.
- WebFetch cannot connect to private or special-use addresses through literals, DNS, mapped IPv6, or redirects, and cannot buffer more than 1 MiB.
- Corrupt Model/MCP configuration no longer prevents CoreHost startup, and corrupt bytes remain recoverable.
- Existing disk schemas and browser-development fallback remain compatible.
- `make check`, targeted security tests, desktop build, and packaged smoke pass.
- The audit report is updated with fix commits, regression tests, and residual risks.

## 9. Non-goals

- Replacing Electron IPC with HTTP or another transport.
- Building a general OS sandbox in this remediation.
- Adding persistent “approve forever” command grants.
- Changing MCP server schema or model provider schema.
- Providing access to private or loopback WebFetch targets through an escape hatch.
- Refactoring unrelated Scheduler, Team, renderer, or storage behavior.
