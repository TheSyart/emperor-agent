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

  async capabilities(): Promise<DriverCapability[]> {
    return [this.browser.capability()]
  }

  indicateControl(state: ControlIndicatorState): void {
    this.indicator.push(state)
  }
}
