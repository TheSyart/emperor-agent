module.exports = {
  extends: './electron-builder.yml',
  mac: {
    target: ['dmg', 'zip'],
    identity: null,
    artifactName:
      'Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-${arch}.${ext}',
  },
  win: {
    target: ['nsis'],
    artifactName:
      'Emperor-Agent-${version}-UNSIGNED-PREVIEW-windows-${arch}.${ext}',
  },
  linux: {
    target: ['AppImage', 'deb'],
    artifactName: 'Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.${ext}',
    maintainer: 'Emperor Agent maintainers',
    vendor: 'Emperor Agent',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
}
