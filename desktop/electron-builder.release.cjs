function releaseTarget() {
  const target = String(process.env.EMPEROR_RELEASE_TARGET || '').trim()
  if (!['mac', 'win'].includes(target))
    throw new Error(
      'EMPEROR_RELEASE_TARGET must be mac or win for trusted releases',
    )
  return target
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

  throw new Error('Windows trusted release configuration is not implemented')
}
