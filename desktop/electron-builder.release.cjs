// The Stable release (REL-05), unsigned like Preview (decided 2026-10-01):
// no signing identity, so electron-builder signs and notarizes nothing, and
// after-pack seals every piece of Emperor's code ad hoc with the hardened
// runtime once the fuses are flipped (scripts/after-pack.cjs,
// scripts/harden-package.cjs). macOS only. Build with
// CSC_IDENTITY_AUTO_DISCOVERY=false (scripts/build_desktop_release.sh).
module.exports = {
  extends: './electron-builder.yml',
  mac: {
    target: ['dmg', 'zip'],
    identity: null,
    artifactName: 'Emperor-Agent-${version}-macos-${arch}.${ext}',
  },
}
