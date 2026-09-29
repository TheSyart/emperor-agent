/**
 * The Electron main process's Computer Use host port. Core talks to GUI
 * drivers only through this object; drivers that are not built yet report
 * themselves as unavailable (spec 00 §3.3: say exactly what exists).
 */

import type {
  BrowserDriver,
  ComputerUseHostPort,
  CredentialVaultPort,
  NativeDesktopDriver,
} from '@emperor/core/host-capabilities'
import type {
  ControlIndicatorState,
  DriverCapability,
  HostPlatform,
} from '@emperor/core/runtime-contract'

export function hostPlatform(platform: NodeJS.Platform): HostPlatform {
  return platform === 'darwin'
    ? 'macos'
    : platform === 'win32'
      ? 'windows'
      : 'linux'
}

export interface DesktopComputerUsePortOptions {
  readonly platform: NodeJS.Platform
  embeddedBrowser?(): BrowserDriver | null
  externalBrowser?(): BrowserDriver | null
  desktop?(): NativeDesktopDriver | null
  credentials?(): CredentialVaultPort | null
  indicate?(state: ControlIndicatorState): void
}

export class DesktopComputerUsePort implements ComputerUseHostPort {
  readonly platform: HostPlatform

  constructor(private readonly options: DesktopComputerUsePortOptions) {
    this.platform = hostPlatform(options.platform)
  }

  embeddedBrowser(): BrowserDriver | null {
    return this.options.embeddedBrowser?.() ?? null
  }

  externalBrowser(): BrowserDriver | null {
    return this.options.externalBrowser?.() ?? null
  }

  desktop(): NativeDesktopDriver | null {
    return this.options.desktop?.() ?? null
  }

  credentials(): CredentialVaultPort | null {
    return this.options.credentials?.() ?? null
  }

  async capabilities(): Promise<DriverCapability[]> {
    const embedded = this.embeddedBrowser()
    const external = this.externalBrowser()
    const desktop = this.desktop()
    // TCC can change while the helper stays connected; its hello permissions
    // describe only the initial handshake.
    await desktop?.permissions().catch(() => undefined)
    const unavailable = (
      driver: DriverCapability['driver'],
      label: string,
      reason: string,
    ): DriverCapability => ({
      driver,
      platform: this.platform,
      stage: 'unavailable',
      label,
      enabled: false,
      available: false,
      actions: [],
      missing: [],
      reason,
    })
    return [
      embedded?.capability() ??
        unavailable('embedded-browser', '内置浏览器', '内置浏览器驱动尚未就绪'),
      external?.capability() ??
        unavailable('external-browser', 'Chrome/Edge 连接', '尚未开放'),
      desktop?.capability() ??
        unavailable(
          'desktop',
          this.platform === 'macos' ? 'macOS 桌面' : '桌面',
          '尚未开放',
        ),
    ]
  }

  indicateControl(state: ControlIndicatorState): void {
    this.options.indicate?.(state)
  }
}
