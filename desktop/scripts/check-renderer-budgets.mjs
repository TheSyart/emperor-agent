#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, '..')
const args = parseArguments(process.argv.slice(2))
const outDir = resolve(args.outDir ?? join(desktopRoot, 'out'))
const configPath = resolve(
  args.config ?? join(scriptDir, 'renderer-budgets.json'),
)

try {
  const config = readConfig(configPath)
  const metrics = collectMetrics(outDir)
  const violations = Object.entries(config.limits).flatMap(
    ([metric, limit]) => {
      const actual = metrics[metric]
      return actual > limit ? [`${metric}: ${actual} > ${limit}`] : []
    },
  )
  const deltas = Object.fromEntries(
    Object.entries(metrics).map(([metric, actual]) => [
      metric,
      actual - config.baseline[metric],
    ]),
  )

  process.stdout.write(
    `${JSON.stringify(
      {
        outDir,
        metrics,
        baseline: config.baseline,
        limits: config.limits,
        deltas,
      },
      null,
      2,
    )}\n`,
  )

  if (violations.length > 0) {
    process.stderr.write(
      `Desktop bundle budget exceeded:\n${violations
        .map((violation) => `- ${violation}`)
        .join('\n')}\n`,
    )
    process.exitCode = 1
  }
} catch (cause) {
  process.stderr.write(
    `Desktop bundle budget check failed: ${messageOf(cause)}\n`,
  )
  process.exitCode = 1
}

function collectMetrics(root) {
  const rendererDir = join(root, 'renderer')
  const assetsDir = join(rendererDir, 'assets')
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf8')
  const initialScripts = referencedAssets(html, 'script', 'src', '.js')
  const globalStyles = referencedAssets(html, 'link', 'href', '.css')
  const assetNames = readdirSync(assetsDir)
  const chatAssets = assetNames.filter((name) =>
    /^ConversationView-.+\.js$/.test(name),
  )
  const imageAssets = assetNames.filter((name) =>
    ['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp'].includes(
      extname(name).toLowerCase(),
    ),
  )

  if (initialScripts.length === 0)
    throw new Error('renderer index.html has no initial JavaScript entry')
  if (globalStyles.length === 0)
    throw new Error('renderer index.html has no global stylesheet')
  if (chatAssets.length === 0)
    throw new Error(
      'renderer assets contain no ConversationView JavaScript chunk',
    )
  if (imageAssets.length === 0)
    throw new Error('renderer assets contain no image assets')

  return {
    mainJsBytes: fileSize(join(root, 'main', 'index.js')),
    initialJsBytes: sumSizes(rendererDir, initialScripts),
    chatJsBytes: maxSize(assetsDir, chatAssets),
    globalCssBytes: sumSizes(rendererDir, globalStyles),
    largestImageBytes: maxSize(assetsDir, imageAssets),
  }
}

function referencedAssets(html, tagName, attribute, extension) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  const attributePattern = new RegExp(`\\b${attribute}=["']([^"']+)["']`, 'i')
  return [...html.matchAll(tagPattern)]
    .map((match) => attributePattern.exec(match[0])?.[1] ?? '')
    .filter((path) => path.endsWith(extension))
    .map((path) => path.replace(/^\.\//, ''))
}

function readConfig(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed?.schemaVersion !== 1)
    throw new Error(`unsupported budget schema in ${path}`)
  const metricNames = [
    'mainJsBytes',
    'initialJsBytes',
    'chatJsBytes',
    'globalCssBytes',
    'largestImageBytes',
  ]
  for (const group of ['baseline', 'limits']) {
    for (const metric of metricNames) {
      if (!Number.isSafeInteger(parsed?.[group]?.[metric]))
        throw new Error(`invalid ${group}.${metric} in ${path}`)
    }
  }
  return parsed
}

function parseArguments(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--out-dir') parsed.outDir = requiredValue(argv, ++index)
    else if (current === '--config')
      parsed.config = requiredValue(argv, ++index)
    else throw new Error(`unknown argument: ${current}`)
  }
  return parsed
}

function requiredValue(argv, index) {
  const value = argv[index]
  if (!value) throw new Error('missing command argument value')
  return value
}

function fileSize(path) {
  return statSync(path).size
}

function sumSizes(root, paths) {
  return paths.reduce((total, path) => total + fileSize(join(root, path)), 0)
}

function maxSize(root, names) {
  return Math.max(...names.map((name) => fileSize(join(root, name))))
}

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}
