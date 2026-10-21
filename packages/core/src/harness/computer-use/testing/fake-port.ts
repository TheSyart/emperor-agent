/** A `ComputerUseHostPort` around the fake browser driver (tests only). */

import type { ComputerUseHostPort } from '../port'
import type { ControlIndicatorState, DriverCapability } from '../types'
import { FakeBrowserDriver } from './fake-browser-driver'
import { FakeCredentialVault } from './fake-vault'

export class FakeComputerUsePort implements ComputerUseHostPort {
  readonly platform = 'macos' as const
  readonly browser: FakeBrowserDriver
  readonly indicator: ControlIndicatorState[] = []
  readonly vault: FakeCredentialVault
  /** Further drivers to report (Chrome pairing, the macOS Helper) as the host would. */
  extraDrivers: DriverCapability[] = []
  /** How often the service asked for capabilities (a real host may launch the Helper). */
  capabilityCalls = 0
  /** The options of every capabilities() call, in order. */
  readonly capabilityOptions: Array<{ readonly connect?: boolean }> = []

  constructor(
    browser = new FakeBrowserDriver(),
    vault = new FakeCredentialVault(),
  ) {
    this.browser = browser
    this.vault = vault
    browser.reveal = (handleId, field) => vault.reveal(handleId, field)
  }

  credentials(): FakeCredentialVault {
    return this.vault
  }

  embeddedBrowser(): FakeBrowserDriver {
    return this.browser
  }

  externalBrowser(): null {
    return null
  }

  desktop(): null {
    return null
  }

  async capabilities(
    options: { readonly connect?: boolean } = {},
  ): Promise<DriverCapability[]> {
    this.capabilityCalls += 1
    this.capabilityOptions.push(options)
    return [this.browser.capability(), ...this.extraDrivers]
  }

  indicateControl(state: ControlIndicatorState): void {
    this.indicator.push(state)
  }
}
