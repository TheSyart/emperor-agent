/**
 * Shared types for "从浏览器导入" (ST-06). The whole read path runs in the main
 * process: the renderer only triggers it over trusted IPC and is told counts,
 * never a password or a cookie value. These types describe what a discovery /
 * detection / read step returns, plus the injectable seams the tests drive so
 * the real Keychain and a real browser profile are never touched under test.
 */

/** The browsers Emperor can import from on macOS. */
export type BrowserId = 'chrome' | 'edge'

/** One Chrome/Edge profile, as named in Local State's `profile.info_cache`. */
export interface BrowserProfile {
  /** Directory name under the user-data dir, e.g. `Default`, `Profile 1`. */
  readonly dir: string
  /** Display name the user gave the profile, e.g. `Person 1`. */
  readonly name: string
}

/** A browser found (or not) on this machine, with its profiles. */
export interface DiscoveredBrowser {
  readonly browser: BrowserId
  /** Product name for the source dropdown, e.g. `Google Chrome`. */
  readonly name: string
  /** `~/Library/Application Support/…` for this browser. */
  readonly userDataDir: string
  /** The user-data dir exists on disk. */
  readonly installed: boolean
  readonly profiles: readonly BrowserProfile[]
}

/** Why a browser counts as running (or not); the dialog blocks import unless
 *  it is closed, so a crash-residue lock must read as `stale-lock`. */
export type RunningReason = 'running' | 'stale-lock' | 'no-lock' | 'unknown'

export interface RunningStatus {
  readonly running: boolean
  readonly reason: RunningReason
}

/** A saved password, normalized for the vault (the back half maps it onto a
 *  `CredentialDraft` with an `origin` binding). The plaintext lives only here,
 *  in main-process memory. */
export interface PasswordRecord {
  /** Canonical origin from `origin_url`/`signon_realm`, e.g. `https://a.test`. */
  readonly origin: string
  readonly username: string
  /** Decrypted plaintext; never logged, never sent to the renderer. */
  readonly password: string
  /** Unix seconds the login was first saved, when Chrome recorded one. */
  readonly createdAt?: number
}

/** A cookie, normalized so the back half can hand it to Electron's
 *  `session.cookies.set` for the chosen persistent profile. */
export interface CookieRecord {
  /** Chrome's `host_key`, keeping any leading dot (`.a.test`). */
  readonly hostKey: string
  readonly name: string
  /** Decrypted plaintext; never logged, never sent to the renderer. */
  readonly value: string
  readonly path: string
  /** Unix seconds; absent for a session cookie (`expires_utc` = 0). */
  readonly expiresAt?: number
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** What a single read produced, plus the counts the renderer is told. */
export interface BrowserData {
  readonly passwords: readonly PasswordRecord[]
  readonly cookies: readonly CookieRecord[]
  readonly counts: { readonly passwords: number; readonly cookies: number }
}

/** Runs `security find-generic-password` (or a stand-in under test). The
 *  default is the only place the real Keychain is reached, and passing a
 *  stand-in keeps automation away from the authorization prompt entirely. */
export type SecurityRunner = (service: string, account: string) => string

export interface ReadBrowserDataOptions {
  readonly browser: BrowserId
  /** Profile directory name, e.g. `Default` or `Profile 1`. */
  readonly profileDir: string
  readonly want: { readonly passwords?: boolean; readonly cookies?: boolean }
}

export interface ReadBrowserDataDeps {
  /** Home directory to resolve the user-data dir under (default: `os.homedir()`). */
  readonly homeDir?: string
  /** Clock for cookie-expiry filtering, in ms (default: `Date.now`). */
  readonly now?: () => number
  /** Reads the browser's Safe Storage password (default: the Keychain). */
  readonly readSafeStoragePassword?: (browser: BrowserId) => string
  /** Parent dir for the private copy (default: `os.tmpdir()`). */
  readonly tmpParent?: string
  /** Test seam: the basenames copied into a temp dir before reading. */
  readonly onCopied?: (names: readonly string[]) => void
}
