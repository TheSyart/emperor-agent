/**
 * What run-packaged-smoke.cjs adds as `package`: on macOS the seal
 * (harden-package.cjs verifyMacHardening), elsewhere the fuses alone.
 */
export interface PackagedSmokeSealFixture {
  codesignStrict?: boolean
  identifier?: string
  sealedCode?: number
  runtime?: Record<string, boolean>
  fuses: Record<string, boolean>
}

function sealFixture(platform: string): PackagedSmokeSealFixture {
  const fuses = {
    RunAsNode: false,
    EnableCookieEncryption: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: platform === 'darwin',
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
  }
  if (platform !== 'darwin') return { fuses }
  return {
    codesignStrict: true,
    identifier: 'com.emperor.agent.desktop',
    sealedCode: 20,
    runtime: {
      'Computer Helper': true,
      'Dictation Helper': true,
      'Native Messaging host': true,
    },
    fuses,
  }
}

/** Complete, hand-written schema 2 fixture for the release consumers. */
export function packagedSmokeFixture(
  platform: string,
  arch: string,
  appVersion: string,
  commit: string,
) {
  return {
    schemaVersion: 2,
    appVersion,
    commit,
    platform,
    arch,
    exitCode: 0,
    stateRoot: '$TEMP/stateRoot',
    runtimeManifestHash: 'b'.repeat(64),
    runtimeRevision: 'c'.repeat(64),
    installJobs: { before: 0, after: 0 },
    operations: {
      bootstrap: { ok: true },
      diagnostics: {
        ok: true,
        sandbox: {
          backend:
            platform === 'darwin'
              ? 'macos-seatbelt'
              : platform === 'win32'
                ? 'windows-unsupported'
                : 'linux-bwrap',
          status: platform === 'win32' ? 'unsupported' : 'available',
          provenance: 'host-os',
        },
        lifecycle: {
          state: 'ready',
          readyServices: [
            'harness-kernel',
            'mcp',
            'process-runtime',
            'scheduler',
          ],
        },
      },
      environment: { ok: true },
      glob: { ok: true },
      grep: { ok: true },
      terminal: { ok: true, outputBytes: 1 },
      seatbelt: {
        ok: true,
        mode: platform === 'darwin' ? 'workspace-write' : 'not-macos',
        commands: platform === 'darwin' ? 18 : 0,
        protectedStateDenied: platform === 'darwin',
      },
      renderer: {
        ok: true,
        nodeGlobalsAbsent: true,
        coreBridge: true,
        coreBootstrap: true,
        appVersion,
        deepLinkRenders: true,
        attachment: { ok: true, bytes: 34 },
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
        chromiumSandbox: 'enabled',
        security: {
          cspHeader: true,
          cspMeta: true,
          evalBlocked: true,
          microphoneDenied: true,
          devToolsDisabled: true,
          productionMenu: true,
          rendererUrlPinned: true,
        },
      },
      helpers: {
        ok: true,
        mode: platform === 'darwin' ? 'macos' : 'not-macos',
        computerUse: {
          handshake: platform === 'darwin',
          hardenedCopy: platform === 'darwin',
        },
        dictation: { available: platform === 'darwin' },
      },
    },
    package: sealFixture(platform),
  }
}
