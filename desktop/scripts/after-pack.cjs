const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { validateRuntimeManifest } = require('./before-pack.cjs')

module.exports = async function afterPack(context) {
  const appInfo = context.packager.appInfo
  const macResources = join(
    context.appOutDir,
    `${appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  )
  const resourcesRoot = existsSync(macResources)
    ? macResources
    : join(context.appOutDir, 'resources')
  validateRuntimeManifest(
    join(resourcesRoot, 'runtime-defaults'),
    appInfo.version,
  )
}
