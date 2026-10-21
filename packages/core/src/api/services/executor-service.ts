import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ViewScope } from '../../harness/host/scope'
import {
  ExecutorConfigStore,
  parseExecutorConfig,
} from '../../harness/delegation/config'
import {
  checkSignIn,
  type ExecutorRegistry,
} from '../../harness/delegation/registry'
import type { ExecutorFactsStore } from '../../harness/delegation/facts'
import { executorSpecialties } from '../../harness/delegation/specialties'
import type { ExecutorModelCatalogService } from '../../harness/delegation/models'
import type { ExecutorConsentStore } from '../../harness/delegation/consent'
import type { SecretSealer } from '../../security/secret-sealer'
import {
  DelegationError,
  type ClaudeSignInView,
  type ExecutorAuthState,
  type ExecutorProbe,
  type ExecutorProfile,
} from '../../harness/delegation/types'
import type {
  ClaudeLogin,
  ClaudeLoginOutcome,
} from '../../harness/delegation/claude-sign-in'
import { logger } from '../../util/log'

const log = logger.child({ component: 'executors' })

/** A 登录 Claude Code that is running (FIX-11). */
interface SignInRun {
  view: ClaudeSignInView
  login: ClaudeLogin
  /** The same sign-in as one line for Terminal, shown if it fails. */
  command: string
}

export class CoreExecutorService {
  /** At most one `claude auth login` at a time (FIX-11). */
  private signInRun: SignInRun | null = null
  private signInStarting: Promise<ClaudeSignInView> | null = null
  constructor(
    private readonly options: {
      store: ExecutorConfigStore
      registry: ExecutorRegistry
      facts: ExecutorFactsStore
      modelCatalog: ExecutorModelCatalogService
      /** The mutation guard of the session the caller shows (KRN-01). */
      refresh: () => Promise<void>
      checkAuth?: (
        profile: ExecutorProfile,
      ) => Promise<ExecutorAuthState | undefined>
      /** "以后都允许" per profile (AGT-05). */
      consent?: ExecutorConsentStore
      /** Where 使用 API Key keeps the user's own key (AGT-12). */
      claudeKeys?: { root: string; sealer: SecretSealer }
      /**
       * Claude Code's own sign-in (AGT-12): 登录 Claude Code starts the
       * installed claude's `auth login` (FIX-11, finished in the browser);
       * 退出登录 runs `claude auth logout`, both in the run's environment.
       */
      claudeSignIn?: {
        start(
          profile: ExecutorProfile,
          console: boolean,
        ): Promise<{ login: ClaudeLogin; command: string }>
        signOut(profile: ExecutorProfile): Promise<void>
      }
      /** Pushes a sign-in's progress to the UI (`executor_sign_in`). */
      signInChanged?: (change: {
        signIn: ClaudeSignInView
        probe?: ExecutorProbe
      }) => void
    },
  ) {}
  async close() {
    // A sign-in still waiting for the browser ends with Emperor.
    await this.signInStarting?.catch(() => undefined)
    await this.signInRun?.login.cancel()
    return this.options.modelCatalog.close()
  }
  async models(input: { profileId: string; refresh?: boolean }) {
    const profile = this.profile(input.profileId)
    return this.options.modelCatalog.list(profile, input.refresh)
  }
  list() {
    try {
      const config = this.options.store.read()
      return {
        config,
        diagnostic: null,
        /** Once after the upgrade that deleted a saved Claude token (AGT-12). */
        signInNotice: this.signInNotice(),
        /** 登录 Claude Code while it runs (FIX-11). */
        signIn: this.signInRun?.view ?? null,
        profiles: config.profiles.map((profile) => ({
          profile,
          probe: this.options.facts.probe(profile),
          specialties: executorSpecialties(profile),
          runtime: this.options.facts.view(profile),
          /** The user chose 以后都允许 for this executor. */
          consent: this.options.consent?.granted(profile.id)
            ? ('always' as const)
            : null,
        })),
      }
    } catch {
      return {
        config: null,
        diagnostic: 'EXECUTOR_CONFIG_INVALID: original configuration retained',
        signInNotice: false,
        signIn: this.signInRun?.view ?? null,
        profiles: [],
      }
    }
  }
  private profile(profileId: string): ExecutorProfile {
    const profile = this.options.store
      .read()
      .profiles.find((p) => p.id === profileId)
    if (!profile)
      throw new DelegationError(
        'EXECUTOR_NOT_FOUND',
        'unknown executor profile',
      )
    return profile
  }
  async probe(input: { profileId: string }) {
    const profile = this.profile(input.profileId)
    let value = await this.options.registry.probe(profile)
    const check = this.options.checkAuth
    if (check) value = (await checkSignIn(value, () => check(profile))).probe
    this.options.facts.setProbe(profile, value)
    return value
  }
  private claudeProfile(profileId: string): ExecutorProfile {
    const profile = this.profile(profileId)
    if (profile.backend !== 'claude-code')
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'only Claude Code signs in or takes an API key here',
      )
    return profile
  }
  private keyStore() {
    const keys = this.options.claudeKeys
    if (!keys)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'this Emperor keeps no Claude Code API key',
      )
    return import('../../harness/delegation/claude-sign-in').then(
      (m) => new m.ClaudeKeyStore(keys),
    )
  }
  private signInNotice(): boolean {
    const keys = this.options.claudeKeys
    if (!keys) return false
    try {
      const raw = JSON.parse(
        readFileSync(join(keys.root, 'credentials.json'), 'utf8'),
      ) as { notice?: unknown }
      return raw.notice === 'claude-sign-in'
    } catch {
      return false
    }
  }
  // 使用 API Key / 移除 (AGT-12): the user's own Console key, sealed; the
  // reply is the new probe, whose `auth` shows 末 4 位, never the key.
  async setCredential(
    input: { profileId: string; kind: 'api-key'; token: string },
    _view: ViewScope,
  ) {
    const profile = this.claudeProfile(input.profileId)
    const { isClaudeAiToken } =
      await import('../../harness/delegation/claude-sign-in')
    // A Claude.ai token is claude's own sign-in: 登录 Claude Code instead.
    if (input.kind !== 'api-key' || isClaudeAiToken(input.token))
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'only an API key is saved in Emperor; sign in to Claude Code with its own login',
      )
    const store = await this.keyStore()
    try {
      store.set(profile.id, input.token)
    } catch {
      throw new DelegationError(
        'CREDENTIAL_UNAVAILABLE',
        "Emperor's local key cannot seal the API key",
      )
    }
    return { probe: await this.probe(input) }
  }
  async clearCredential(input: { profileId: string }, _view: ViewScope) {
    const profile = this.claudeProfile(input.profileId)
    const store = await this.keyStore()
    try {
      store.clear(profile.id)
    } catch {
      throw new DelegationError(
        'CREDENTIAL_UNAVAILABLE',
        "Emperor's local key file cannot be changed",
      )
    }
    return { probe: await this.probe(input) }
  }
  /**
   * 登录 Claude Code (FIX-11): starts the installed claude's own
   * `claude auth login` and answers once it runs; the user finishes in the
   * browser, and `executor_sign_in` says how it ended. A click while one
   * runs joins it: one claude at a time.
   */
  async signIn(
    input: { profileId: string; method: 'claude-ai' | 'console' },
    _view: ViewScope,
  ): Promise<{ signIn: ClaudeSignInView }> {
    const profile = this.claudeProfile(input.profileId)
    const host = this.options.claudeSignIn
    if (!host)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'this Emperor cannot start a sign-in',
      )
    if (this.signInRun) return { signIn: this.signInRun.view }
    this.signInStarting ??= this.startSignIn(
      host,
      profile,
      input.method,
    ).finally(() => {
      this.signInStarting = null
    })
    return { signIn: await this.signInStarting }
  }
  private async startSignIn(
    host: NonNullable<CoreExecutorService['options']['claudeSignIn']>,
    profile: ExecutorProfile,
    method: ClaudeSignInView['method'],
  ): Promise<ClaudeSignInView> {
    const { login, command } = await host.start(profile, method === 'console')
    const view: ClaudeSignInView = {
      profileId: profile.id,
      method,
      state: 'running',
      startedAt: Date.now(),
    }
    if (!login.started) {
      const failed = this.ended(view, await login.done, command)
      this.options.signInChanged?.({ signIn: failed })
      return failed
    }
    const run: SignInRun = { view, login, command }
    this.signInRun = run
    log.info('claude sign-in started', { profileId: profile.id, method })
    this.options.signInChanged?.({ signIn: view })
    void login.done.then((outcome) => this.finishSignIn(run, outcome))
    return view
  }
  /** How a sign-in ended; only the exit code of claude's own output. */
  private ended(
    view: ClaudeSignInView,
    outcome: ClaudeLoginOutcome,
    command: string,
  ): ClaudeSignInView {
    const finished = { ...view, finishedAt: Date.now() }
    if (outcome.ended === 'cancelled')
      return { ...finished, state: 'cancelled' }
    return {
      ...finished,
      state: 'failed',
      reason: outcome.ended,
      ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
      command,
    }
  }
  private async finishSignIn(run: SignInRun, outcome: ClaudeLoginOutcome) {
    let next: ClaudeSignInView
    let probe: ExecutorProbe | undefined
    if (outcome.ended === 'exit' && outcome.exitCode === 0) {
      // claude saved its login: ask it again, as 重新检测 would.
      try {
        probe = await this.probe({ profileId: run.view.profileId })
      } catch {
        probe = undefined
      }
      next =
        probe?.status === 'available'
          ? { ...run.view, state: 'signed-in', finishedAt: Date.now() }
          : {
              ...run.view,
              state: 'failed',
              reason: 'not-signed-in',
              exitCode: 0,
              finishedAt: Date.now(),
              command: run.command,
            }
    } else next = this.ended(run.view, outcome, run.command)
    if (this.signInRun === run) this.signInRun = null
    log.info('claude sign-in ended', {
      profileId: next.profileId,
      state: next.state,
      ...(next.reason ? { reason: next.reason } : {}),
      ...(next.exitCode !== undefined ? { exitCode: next.exitCode } : {}),
    })
    this.options.signInChanged?.({ signIn: next, ...(probe ? { probe } : {}) })
  }
  /** 取消: ends the running sign-in (claude's whole process group). */
  async cancelSignIn(
    input: { profileId: string },
    _view: ViewScope,
  ): Promise<{ signIn: ClaudeSignInView | null }> {
    this.claudeProfile(input.profileId)
    await this.signInStarting?.catch(() => undefined)
    const run = this.signInRun
    if (!run || run.view.profileId !== input.profileId) return { signIn: null }
    const outcome = await run.login.cancel()
    // claude may have finished first: then its own end is what is pushed.
    return {
      signIn:
        outcome.ended === 'cancelled'
          ? this.ended(run.view, outcome, run.command)
          : null,
    }
  }
  /** 退出登录: `claude auth logout` in the run's environment. */
  async signOut(input: { profileId: string }, _view: ViewScope) {
    const profile = this.claudeProfile(input.profileId)
    const signIn = this.options.claudeSignIn
    if (!signIn)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'this Emperor cannot sign out',
      )
    await signIn.signOut(profile)
    return { probe: await this.probe(input) }
  }
  /** 知道了 on the upgrade notice (AGT-12). */
  async dismissNotice(_input: { notice: 'claude-sign-in' }, _view: ViewScope) {
    if (this.options.claudeKeys) (await this.keyStore()).dismissNotice()
    return {}
  }
  async configure(
    input: { expectedRevision: number; config: unknown },
    _view: ViewScope,
  ) {
    const before = this.options.store.read()
    const parsed = parseExecutorConfig(input.config),
      config = this.options.store.update(input.expectedRevision, parsed)
    // Turning an executor off forgets 以后都允许: turning it back on asks
    // again before the first dispatch.
    for (const profile of config.profiles)
      if (
        !profile.enabled &&
        before.profiles.find((p) => p.id === profile.id)?.enabled
      )
        this.options.consent?.revoke(profile.id)
    await this.options.refresh()
    return config
  }
}
