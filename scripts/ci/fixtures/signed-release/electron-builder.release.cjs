// A signed builder config; scripts/ci/check-unsigned-release.mjs must refuse
// it (REL-05 test 1, negative fixture).
module.exports = {
  extends: './electron-builder.yml',
  forceCodeSigning: true,
  mac: {
    identity: 'Developer ID Application: Emperor Agent (ABCDE12345)',
    hardenedRuntime: true,
    notarize: true,
  },
  win: {
    azureSignOptions: {
      endpoint: 'https://eus.codesigning.azure.net/',
      certificateProfileName: 'emperor-release',
      codeSigningAccountName: 'emperor-signing',
    },
  },
}
