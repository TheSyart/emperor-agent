const { createHash, randomBytes } = require('node:crypto')
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require('node:path')

const TEMPLATE_RUNTIME_FILES = [
  'SOUL.md',
  'TOOL.md',
  'agent/compact_prompt.md',
  'agent/identity.md',
  'agent/skills_section.md',
  'init/MEMORY.md',
  'init/USER.md',
  'subagents/agents.json',
  'subagents/dongchang_tanshi.md',
  'subagents/neiguan_yingzao.md',
  'subagents/shangbao_dianbu.md',
  'subagents/sili_suitang.md',
  'subagents/verification_reviewer.md',
  'subagents/xiaohuangmen.md',
]

const SOURCE_MAPPINGS = [
  ...TEMPLATE_RUNTIME_FILES.map((path) => ({
    source: `templates/${path}`,
    target: `templates/${path}`,
  })),
  { source: 'skills', target: 'skills' },
  { source: 'assets/desktop-pet', target: 'assets/desktop-pet' },
  {
    source: 'config/examples/model_config.example.json',
    target: 'model_config.example.json',
  },
  {
    source: 'config/examples/mcp_config.example.json',
    target: 'mcp_config.example.json',
  },
  { source: '.env.example', target: '.env.example' },
]

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function runtimeRevision(files) {
  return sha256(
    files
      .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
      .join(''),
  )
}

function slash(value) {
  return value.split(sep).join('/')
}

function collectMappingFiles(repoRoot, mapping) {
  const sourceRoot = resolve(repoRoot, mapping.source)
  const sourceStat = lstatSync(sourceRoot)
  if (sourceStat.isSymbolicLink())
    throw new Error(`runtime source must not be a symlink: ${mapping.source}`)
  if (sourceStat.isFile()) {
    const content = readFileSync(sourceRoot)
    return [
      {
        path: mapping.target,
        sha256: sha256(content),
        size: content.byteLength,
      },
    ]
  }
  if (!sourceStat.isDirectory())
    throw new Error(`runtime source is not regular: ${mapping.source}`)

  const out = []
  const stack = [sourceRoot]
  while (stack.length) {
    const current = stack.pop()
    for (const name of readdirSync(current).sort().reverse()) {
      const source = join(current, name)
      const stat = lstatSync(source)
      const rel = slash(relative(sourceRoot, source))
      if (stat.isSymbolicLink())
        throw new Error(
          `runtime source must not contain symlink: ${mapping.source}/${rel}`,
        )
      if (stat.isDirectory()) stack.push(source)
      else if (stat.isFile()) {
        const content = readFileSync(source)
        out.push({
          path: `${mapping.target}/${rel}`,
          sha256: sha256(content),
          size: content.byteLength,
        })
      } else {
        throw new Error(
          `runtime source is not a regular file: ${mapping.source}/${rel}`,
        )
      }
    }
  }
  return out
}

function createRuntimeManifest({ repoRoot, appVersion, outputPath }) {
  const files = SOURCE_MAPPINGS.flatMap((mapping) =>
    collectMappingFiles(repoRoot, mapping),
  ).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  const paths = new Set()
  for (const file of files) {
    if (paths.has(file.path))
      throw new Error(`duplicate runtime resource path: ${file.path}`)
    paths.add(file.path)
  }
  const builtInSkills = [
    ...new Set(
      files
        .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1])
        .filter(Boolean),
    ),
  ].sort()
  const manifest = {
    schemaVersion: 1,
    appVersion,
    runtimeRevision: runtimeRevision(files),
    builtInSkills,
    files,
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(tempPath, outputPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
  return manifest
}

function validateRuntimeManifest(runtimeRoot, expectedAppVersion) {
  const root = resolve(runtimeRoot)
  const manifestPath = join(root, 'runtime-manifest.json')
  if (!existsSync(manifestPath))
    throw new Error(`runtime manifest is missing: ${manifestPath}`)
  if (lstatSync(manifestPath).isSymbolicLink())
    throw new Error('runtime manifest must not be a symlink')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files))
    throw new Error('runtime manifest schema is invalid')
  if (manifest.appVersion !== expectedAppVersion)
    throw new Error('runtime manifest app version mismatch')
  if (!Array.isArray(manifest.builtInSkills))
    throw new Error('runtime manifest builtInSkills is invalid')

  const declared = new Map()
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      typeof file.size !== 'number'
    )
      throw new Error('runtime manifest file entry is invalid')
    assertRelativeRuntimePath(file.path)
    if (declared.has(file.path))
      throw new Error(`duplicate runtime resource path: ${file.path}`)
    declared.set(file.path, file)
  }
  const sortedDeclared = [...declared.keys()].sort()
  if (manifest.files.some((file, index) => file.path !== sortedDeclared[index]))
    throw new Error('runtime manifest files must be sorted')

  const actual = collectPackagedRuntimeFiles(root)
  if (
    actual.length !== sortedDeclared.length ||
    actual.some((file, index) => file.path !== sortedDeclared[index])
  )
    throw new Error('packaged runtime resource tree does not match manifest')
  for (const actualFile of actual) {
    const expected = declared.get(actualFile.path)
    if (
      actualFile.size !== expected.size ||
      actualFile.sha256 !== expected.sha256
    )
      throw new Error(`packaged runtime resource mismatch: ${actualFile.path}`)
  }
  if (runtimeRevision(manifest.files) !== manifest.runtimeRevision)
    throw new Error('runtime manifest revision mismatch')

  const normalizedSkills = [...new Set(manifest.builtInSkills)].sort()
  if (
    normalizedSkills.length !== manifest.builtInSkills.length ||
    normalizedSkills.some(
      (name, index) => name !== manifest.builtInSkills[index],
    )
  )
    throw new Error('runtime manifest builtInSkills must be unique and sorted')
  const inferredSkills = [
    ...new Set(
      sortedDeclared
        .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1])
        .filter(Boolean),
    ),
  ].sort()
  if (
    inferredSkills.length !== normalizedSkills.length ||
    inferredSkills.some((name, index) => name !== normalizedSkills[index])
  )
    throw new Error('runtime manifest builtInSkills does not match files')
  return manifest
}

function collectPackagedRuntimeFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const name of readdirSync(current).sort().reverse()) {
      const source = join(current, name)
      const stat = lstatSync(source)
      const rel = slash(relative(root, source))
      if (rel === 'runtime-manifest.json') continue
      assertRelativeRuntimePath(rel)
      if (stat.isSymbolicLink())
        throw new Error(`packaged runtime contains symlink: ${rel}`)
      if (stat.isDirectory()) stack.push(source)
      else if (stat.isFile()) {
        const content = readFileSync(source)
        out.push({
          path: rel,
          sha256: sha256(content),
          size: content.byteLength,
        })
      } else
        throw new Error(`packaged runtime contains non-regular file: ${rel}`)
    }
  }
  return out.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
}

function assertRelativeRuntimePath(value) {
  if (
    !value ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`unsafe runtime manifest path: ${value}`)
}

async function beforePack(context) {
  const desktopRoot = resolve(__dirname, '..')
  const repoRoot = resolve(desktopRoot, '..')
  createRuntimeManifest({
    repoRoot,
    appVersion: context.packager.appInfo.version,
    outputPath: join(desktopRoot, 'build', 'runtime-defaults-manifest.json'),
  })
}

module.exports = beforePack
module.exports.createRuntimeManifest = createRuntimeManifest
module.exports.validateRuntimeManifest = validateRuntimeManifest
module.exports.SOURCE_MAPPINGS = SOURCE_MAPPINGS
module.exports.TEMPLATE_RUNTIME_FILES = TEMPLATE_RUNTIME_FILES
