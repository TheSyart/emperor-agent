#!/usr/bin/env node
// REL-05 test 1: releases are unsigned (decided 2026-10-01). Nothing that
// builds or publishes a release holds a signing secret, a signing identity
// or a notarization step; `make check` runs this.
//
//   node scripts/ci/check-unsigned-release.mjs [--workflows <dir>]
//     [--builder <electron-builder config>]... [--script <shell script>]...
//
// Defaults: .github/workflows, desktop/electron-builder.release.cjs and
// electron-builder.preview.cjs, and the release shell scripts below.
//
// - Workflows, parsed (comments do not count): a release workflow
//   (release*.yml) references no secret but the GitHub token; no workflow
//   names a signing variable (CSC_LINK, APPLE_TEAM_ID, ...) or runs a
//   signing or notarization tool; release.yml and release-preview.yml turn
//   CSC_IDENTITY_AUTO_DISCOVERY off for the whole workflow.
// - Builder configs: mac.identity is null; no forceCodeSigning, notarize,
//   certificate, signing identity or Windows signing option anywhere.
// - Release scripts, comments stripped: no keychain import, no
//   notarization, no signing variable, codesign only with the ad-hoc
//   identity `-`.
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)

const DEFAULT_BUILDERS = [
  'desktop/electron-builder.release.cjs',
  'desktop/electron-builder.preview.cjs',
]
const DEFAULT_SCRIPTS = [
  'scripts/build_desktop_release.sh',
  'scripts/verify-macos-release.sh',
  'scripts/generate-release-sbom.sh',
  'scripts/publish-release.sh',
  'scripts/publish-preview-release.sh',
]
/** Workflows that build or publish what users download. */
const RELEASE_WORKFLOW = /^release.*\.ya?ml$/
/** These must turn signing discovery off for every job. */
const DISCOVERY_OFF = ['release.yml', 'release-preview.yml']

/** Variables electron-builder, notarytool or the old signed chain read. */
const SIGNING_VARIABLE =
  /\b(CSC_LINK|CSC_KEY_PASSWORD|CSC_NAME|CSC_INSTALLER_LINK|CSC_INSTALLER_KEY_PASSWORD|WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_API_KEY(?:_ID|_BASE64)?|APPLE_API_ISSUER|APPLE_TEAM_ID|APPLE_KEYCHAIN(?:_PROFILE)?|MACOS_CERTIFICATE(?:_PASSWORD)?|WINDOWS_SIGNING_[A-Z_]+|AZURE_TENANT_ID|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET|EMPEROR_DEV_SIGN_IDENTITY)\b/g

/** Signing and notarization tools, by what they are reported as. */
const SIGNING_TOOLS = [
  /\b(?:xcrun\s+)?notarytool\b/g,
  /\b(?:xcrun\s+)?stapler\b/g,
  /\b(?:xcrun\s+)?altool\b/g,
  /\bsecurity\s+(?:import|create-keychain|unlock-keychain|set-key-partition-list|find-identity|default-keychain)\b/g,
  /\bforceCodeSigning\b/g,
  /\b(?:azureSignOptions|signtoolOptions)\b/g,
]

/** codesign with an identity; only the ad-hoc `-` is allowed. */
const CODESIGN_IDENTITY =
  /\bcodesign\b[^\n]*?\s(?:--sign|-s)\s+("[^"]*"|'[^']*'|[^\s;|&]+)/g

/** Builder options that sign, notarize or name a certificate. */
const SIGNING_OPTIONS = new Set([
  'forceCodeSigning',
  'notarize',
  'identity',
  'sign',
  'signtoolOptions',
  'azureSignOptions',
  'certificateFile',
  'certificatePassword',
  'certificateSubjectName',
  'certificateSha1',
  'provisioningProfile',
  'cscLink',
  'cscKeyPassword',
])

function toolProblems(text) {
  const problems = []
  for (const pattern of SIGNING_TOOLS)
    for (const match of text.matchAll(pattern))
      problems.push(`runs ${match[0].replace(/\s+/g, ' ')}`)
  for (const match of text.matchAll(CODESIGN_IDENTITY)) {
    const identity = match[1].replace(/^["']|["']$/g, '')
    if (identity !== '-')
      problems.push(
        `signs with an identity other than - (codesign --sign ${match[1]})`,
      )
  }
  for (const match of text.matchAll(SIGNING_VARIABLE))
    problems.push(`uses the signing variable ${match[1]}`)
  return problems
}

/** Every key and string of a parsed YAML document. */
function* yamlTexts(value) {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value))
    for (const item of value) yield* yamlTexts(item)
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      yield key
      yield* yamlTexts(item)
    }
}

export function workflowProblems(name, text) {
  let workflow
  try {
    workflow = YAML.parse(text) ?? {}
  } catch (error) {
    return [`not valid YAML (${String(error.message).split('\n')[0]})`]
  }
  const problems = []
  const release = RELEASE_WORKFLOW.test(name)
  for (const value of yamlTexts(workflow)) {
    if (release)
      for (const match of value.matchAll(
        /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g,
      ))
        if (match[1] !== 'GITHUB_TOKEN')
          problems.push(`references secrets.${match[1]}`)
    problems.push(...toolProblems(value))
  }
  const discovery = (env) => env?.CSC_IDENTITY_AUTO_DISCOVERY
  const discoveryValues = [
    discovery(workflow.env),
    ...Object.values(workflow.jobs ?? {}).flatMap((job) => [
      discovery(job?.env),
      ...(Array.isArray(job?.steps) ? job.steps : []).map((step) =>
        discovery(step?.env),
      ),
    ]),
  ].filter((value) => value !== undefined)
  if (discoveryValues.some((value) => String(value) !== 'false'))
    problems.push('turns CSC_IDENTITY_AUTO_DISCOVERY on')
  if (
    DISCOVERY_OFF.includes(name) &&
    String(discovery(workflow.env)) !== 'false'
  )
    problems.push('does not turn off CSC_IDENTITY_AUTO_DISCOVERY')
  return problems
}

export function builderProblems(config) {
  const problems = []
  if (config?.mac?.identity !== null) problems.push('mac.identity is not null')
  const visit = (value, path) => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key
      if (SIGNING_OPTIONS.has(key)) {
        const harmless =
          item === null ||
          item === false ||
          (key === 'identity' && at === 'mac.identity')
        if (!harmless) problems.push(`sets ${at}`)
      }
      visit(item, at)
    }
  }
  visit(config, '')
  return problems
}

export function scriptProblems(text) {
  const code = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  return toolProblems(code)
}

function loadBuilder(path) {
  const resolved = resolve(path)
  delete require.cache[resolved]
  const loaded = require(resolved)
  return typeof loaded === 'function' ? loaded() : loaded
}

function parseArgs(argv) {
  const options = { workflows: null, builders: [], scripts: [] }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1]
    if (!value) throw new Error(`${argv[index]} needs a value`)
    if (argv[index] === '--workflows') options.workflows = value
    else if (argv[index] === '--builder') options.builders.push(value)
    else if (argv[index] === '--script') options.scripts.push(value)
    else throw new Error(`unknown option: ${argv[index]}`)
    index++
  }
  const explicit =
    options.workflows || options.builders.length || options.scripts.length
  return {
    workflows: options.workflows
      ? [resolve(options.workflows)]
      : explicit
        ? []
        : [join(repoRoot, '.github', 'workflows')],
    builders: explicit
      ? options.builders.map((path) => resolve(path))
      : DEFAULT_BUILDERS.map((path) => join(repoRoot, path)),
    scripts: explicit
      ? options.scripts.map((path) => resolve(path))
      : DEFAULT_SCRIPTS.map((path) => join(repoRoot, path)),
  }
}

function main(argv) {
  const { workflows, builders, scripts } = parseArgs(argv)
  const problems = new Set()
  let workflowCount = 0
  for (const dir of workflows)
    for (const name of readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort()) {
      workflowCount++
      for (const problem of workflowProblems(
        name,
        readFileSync(join(dir, name), 'utf8'),
      ))
        problems.add(`${name}: ${problem}`)
    }
  for (const path of builders)
    for (const problem of builderProblems(loadBuilder(path)))
      problems.add(`${basename(path)}: ${problem}`)
  for (const path of scripts)
    for (const problem of scriptProblems(readFileSync(path, 'utf8')))
      problems.add(`${basename(path)}: ${problem}`)
  if (problems.size) {
    for (const problem of problems) console.error(problem)
    console.error(
      `${problems.size} signing problem(s): releases are unsigned (docs/release/preview-release-runbook.md#发布包不签名)`,
    )
    return 1
  }
  console.log(
    `unsigned releases: ${workflowCount} workflows reference no signing secret or tool; ${builders.length} builder configs have no signing identity; ${scripts.length} release scripts seal ad hoc only`,
  )
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
