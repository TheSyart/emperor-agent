function releaseTarget() {
  const target = String(process.env.EMPEROR_RELEASE_TARGET || '').trim()
  if (!['mac', 'win'].includes(target))
    throw new Error(
      'EMPEROR_RELEASE_TARGET must be mac or win for trusted releases',
    )
  return target
}

function requiredWindowsSigningValue(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required for Windows trusted release`)
  return value
}

module.exports = function trustedReleaseConfig() {
  const target = releaseTarget()
  if (target === 'mac') {
    return {
      extends: './electron-builder.yml',
      mac: {
        forceCodeSigning: true,
        hardenedRuntime: true,
        minimumSystemVersion: '14.0',
        notarize: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      },
    }
  }

  const endpoint = requiredWindowsSigningValue('WINDOWS_SIGNING_ENDPOINT')
  const certificateProfileName = requiredWindowsSigningValue(
    'WINDOWS_SIGNING_PROFILE',
  )
  const codeSigningAccountName = requiredWindowsSigningValue(
    'WINDOWS_SIGNING_ACCOUNT',
  )
  const publisherName = requiredWindowsSigningValue('WINDOWS_SIGNING_PUBLISHER')

  return {
    extends: './electron-builder.yml',
    win: {
      forceCodeSigning: true,
      publisherName: [publisherName],
      azureSignOptions: {
        endpoint,
        certificateProfileName,
        codeSigningAccountName,
      },
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
    },
  }
}
