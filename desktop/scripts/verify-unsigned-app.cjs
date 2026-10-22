#!/usr/bin/env node
// REL-05: one built macOS app is an unsigned public build, sealed ad hoc.
//
//   node desktop/scripts/verify-unsigned-app.cjs "<path>/Emperor Agent.app" <arm64|x64>
//
// - codesign --verify --deep --strict passes, and the app, the Electron
//   framework, both helpers, the NM host and credential-auth have this
//   architecture (after-sign.cjs validateMacPackage);
// - none of them carries a signing identity: ad hoc only, no Authority, no
//   Team ID (releases are never signed, decided 2026-10-01);
// - the SEC-04 seal: the identifier, the hardened runtime and exactly the
//   planned entitlements on every piece of Emperor's code, and the fuses
//   (harden-package.cjs verifyMacHardening).
//
// Prints the path-free seal summary a release receipt carries; exits 1 with
// the reasons otherwise.
const { validateMacPackage } = require('./after-sign.cjs')
const { verifyMacHardening } = require('./harden-package.cjs')

/** Every labelled piece of code that is signed by someone, not sealed ad hoc. */
function unsignedIdentityProblems(entries) {
  return entries
    .filter(
      (entry) =>
        !entry.adHoc ||
        Boolean(entry.authority) ||
        (Boolean(entry.teamId) && entry.teamId !== 'not set'),
    )
    .map((entry) => {
      const signer =
        entry.authority ||
        (entry.teamId && entry.teamId !== 'not set'
          ? `team ${entry.teamId}`
          : 'an identity that is not ad hoc')
      return `${entry.label} is signed by ${signer}; every release is sealed ad hoc only`
    })
}

async function verifyUnsignedMacApp(app, arch) {
  const entries = validateMacPackage(app, arch)
  const problems = unsignedIdentityProblems(entries)
  if (problems.length)
    throw new Error(
      `release app carries a signing identity:\n- ${problems.join('\n- ')}`,
    )
  const seal = await verifyMacHardening(app)
  return {
    adHoc: true,
    codesignStrict: seal.codesignStrict === true,
    identifier: seal.identifier,
    sealedCode: seal.sealedCode,
    // verifyMacHardening throws unless every piece has the runtime and the
    // fuses are as planned.
    hardenedRuntime: Object.values(seal.runtime).every((value) => value),
    fusesVerified: true,
  }
}

if (require.main === module) {
  const [app, arch] = process.argv.slice(2)
  if (!app || !['arm64', 'x64'].includes(arch)) {
    console.error(
      'usage: verify-unsigned-app.cjs "<path>/Emperor Agent.app" <arm64|x64>',
    )
    process.exit(2)
  }
  verifyUnsignedMacApp(app, arch).then(
    (summary) => console.log(JSON.stringify(summary)),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}

module.exports = { unsignedIdentityProblems, verifyUnsignedMacApp }
